const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { findNoncodDateMatch } = require('./_noncod-match');
const { rateLimit } = require('./_ratelimit');
const { normalizeBankName } = require('./_bank');
const { getSupabase } = require('./_supabase');

const dupeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 }); // 20 req/min per IP

function normalizeTransferRow(row) {
  return {
    ...row,
    nama_bank: normalizeBankName(row.nama_bank),
    nominal: Number(row.nominal || 0),
  };
}

function getScopeLabel(areaName, fallback = 'Cabang ini') {
  const normalizedArea = String(areaName || '').trim().toUpperCase();
  return normalizedArea ? 'Area ' + normalizedArea : fallback;
}

async function getAreaScope(supabase, namaCabang) {
  const normalizedCabang = String(namaCabang || '').trim().toUpperCase();
  if (!normalizedCabang) {
    return { areaName: '', cabangNames: [] };
  }

  const { data: cabangRow, error: cabangError } = await supabase
    .from('cabang')
    .select('nama, area')
    .eq('nama', normalizedCabang)
    .maybeSingle();

  if (cabangError) throw cabangError;

  const areaName = String(cabangRow?.area || '').trim().toUpperCase();
  if (!areaName) {
    return { areaName: '', cabangNames: [normalizedCabang] };
  }

  const { data: areaCabangRows, error: areaCabangError } = await supabase
    .from('cabang')
    .select('nama')
    .eq('area', areaName)
    .order('nama', { ascending: true });

  if (areaCabangError) throw areaCabangError;

  const cabangNames = Array.from(new Set((areaCabangRows || [])
    .map((row) => String(row.nama || '').trim().toUpperCase())
    .filter(Boolean)));

  return {
    areaName,
    cabangNames: cabangNames.length > 0 ? cabangNames : [normalizedCabang],
  };
}

function buildDupeSummary({ exactDupes, branchDayTransfers, nominal, areaName }) {
  const normalizedNominal = Number(nominal || 0);
  const branchTransfers = Array.isArray(branchDayTransfers) ? branchDayTransfers : [];
  const dupes = Array.isArray(exactDupes) ? exactDupes : [];
  const branchDayCount = branchTransfers.length;
  const branchDayTotal = branchTransfers.reduce((sum, row) => sum + Number(row.nominal || 0), 0);
  const lastTransfer = branchTransfers[0] || null;
  const scopeLabel = getScopeLabel(areaName);

  if (dupes.length > 0) {
    return {
      tone: 'warn',
      exactMatch: true,
      title: scopeLabel + ' sudah punya nominal yang sama',
      message: 'Ada transfer tersimpan dengan area, tanggal rekap, dan nominal yang sama. Cek ulang agar tidak double upload bukti.',
      branchDayCount,
      branchDayTotal,
      lastTransfer,
      nominalInput: normalizedNominal,
      scopeLabel,
    };
  }

  if (branchDayCount > 0) {
    return {
      tone: 'info',
      exactMatch: false,
      title: scopeLabel + ' sudah punya transfer di tanggal yang sama',
      message: 'Masih bisa disimpan bila ini transfer berbeda, tetapi cek area, tanggal rekap, dan nominal agar tidak tertukar atau dobel.',
      branchDayCount,
      branchDayTotal,
      lastTransfer,
      nominalInput: normalizedNominal,
      scopeLabel,
    };
  }

  return {
    tone: 'ok',
    exactMatch: false,
    title: 'Belum ada transfer tersimpan',
    message: scopeLabel + ' belum punya transfer tersimpan pada tanggal tersebut.',
    branchDayCount,
    branchDayTotal,
    lastTransfer: null,
    nominalInput: normalizedNominal,
    scopeLabel,
  };
}

async function getDuplicateContext(supabase, { nama_cabang, tgl_inputan, nominal }) {
  const normalizedDate = String(tgl_inputan || '').trim();
  const normalizedNominal = Number(nominal || 0);
  const { areaName, cabangNames } = await getAreaScope(supabase, nama_cabang);

  const exactQuery = supabase
    .from('transfers')
    .select('id, timestamp, tgl_inputan, nama_bank, nama_cabang, nominal, periode')
    .in('nama_cabang', cabangNames)
    .eq('tgl_inputan', normalizedDate)
    .eq('nominal', normalizedNominal)
    .order('timestamp', { ascending: false })
    .limit(5);

  const branchDayQuery = supabase
    .from('transfers')
    .select('id, timestamp, tgl_inputan, nama_bank, nama_cabang, nominal, periode')
    .in('nama_cabang', cabangNames)
    .eq('tgl_inputan', normalizedDate)
    .order('timestamp', { ascending: false })
    .limit(10);

  const [exactResult, branchDayResult] = await Promise.all([
    exactQuery,
    branchDayQuery,
  ]);
  if (exactResult.error) throw exactResult.error;
  if (branchDayResult.error) throw branchDayResult.error;

  const dupes = (exactResult.data || []).map(normalizeTransferRow);
  const branchDayTransfers = (branchDayResult.data || []).map(normalizeTransferRow);
  const summary = buildDupeSummary({
    exactDupes: dupes,
    branchDayTransfers,
    nominal: normalizedNominal,
    areaName,
  });

  return {
    areaName,
    scopeType: 'area',
    matchedCabangNames: cabangNames,
    dupes,
    areaDayTransfers: branchDayTransfers,
    branchDayTransfers,
    areaDayCount: summary.branchDayCount,
    branchDayCount: summary.branchDayCount,
    areaDayTotal: summary.branchDayTotal,
    branchDayTotal: summary.branchDayTotal,
    summary,
  };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'POST, OPTIONS' })) return;

  if (await dupeLimiter(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const { nama_cabang, tgl_inputan, nominal } = req.body || {};

    if (!nama_cabang || !nominal) {
      return res.status(400).json({ error: 'Field tidak lengkap.' });
    }

    const supabase = getSupabase();
    let noncodMatch = null;
    let effectiveDate = tgl_inputan || null;

    if (!effectiveDate) {
      noncodMatch = await findNoncodDateMatch(supabase, { namaCabang: nama_cabang, nominal });
      if (noncodMatch.match) {
        effectiveDate = noncodMatch.match.tanggal_buat;
      }
    }

    if (!effectiveDate) {
      return res.status(200).json({
        noncodMatch,
        tgl_inputan: null,
        dupes: [],
        areaDayTransfers: [],
        branchDayTransfers: [],
        summary: {
          tone: noncodMatch && noncodMatch.blocked ? 'warn' : 'info',
          exactMatch: false,
          title: noncodMatch && noncodMatch.blocked ? 'Indikasi pembayaran dobel' : 'Tidak ada NONCOD cocok',
          message: noncodMatch ? noncodMatch.message : 'Tanggal tidak tersedia.',
        },
      });
    }

    const result = await getDuplicateContext(supabase, {
      nama_cabang,
      tgl_inputan: effectiveDate,
      nominal,
    });

    return res.status(200).json({ ...result, noncodMatch, tgl_inputan: effectiveDate });
  } catch (err) {
    console.error(err);
    logError('check-dupe', err.message, { method: 'POST' });
    return res.status(500).json({ error: 'Gagal cek duplikat.' });
  }
}

module.exports = handler;
module.exports.buildDupeSummary = buildDupeSummary;
module.exports.getDuplicateContext = getDuplicateContext;
module.exports.normalizeTransferRow = normalizeTransferRow;
module.exports.getAreaScope = getAreaScope;
module.exports.getScopeLabel = getScopeLabel;
