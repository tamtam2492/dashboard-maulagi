const { isSyncMetaStale, maybeSyncMaukirimPeriod, readSyncMeta } = require('./noncod');
const { applyStatusOverrides, readStatusOverridesByResi } = require('./_noncod-status-overrides');

const NONCOD_MATCH_TOLERANCE = 10000;

function getRecentPeriodes() {
  const now = new Date();
  const periodes = [];
  for (let i = -2; i <= 0; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    periodes.push(y + '-' + m);
  }
  return periodes;
}

function aggregateOngkirByDate(noncodRows) {
  const byDate = {};
  for (const row of (noncodRows || [])) {
    if (String(row.status_terakhir || '').trim().toUpperCase() === 'BATAL') continue;
    if (String(row.metode_pembayaran || '').trim().toLowerCase() !== 'noncod') continue;
    const tgl = String(row.tanggal_buat || '').trim().slice(0, 10);
    if (!tgl || !/^\d{4}-\d{2}-\d{2}$/.test(tgl)) continue;
    if (!byDate[tgl]) byDate[tgl] = 0;
    byDate[tgl] += Number(row.ongkir || 0);
  }
  return byDate;
}

function findMatchingDates(byDate, nominal, tolerance) {
  const normalizedNominal = Number(nominal || 0);
  const candidates = [];
  for (const [tgl, totalOngkir] of Object.entries(byDate)) {
    const diff = Math.abs(totalOngkir - normalizedNominal);
    if (diff <= tolerance) {
      candidates.push({ tanggal_buat: tgl, totalOngkir, diff, periode: tgl.slice(0, 7) });
    }
  }
  candidates.sort((a, b) => a.diff - b.diff || a.tanggal_buat.localeCompare(b.tanggal_buat));
  return candidates;
}

function resolveMatch(candidates, existingTransfers) {
  const transfersByDate = {};
  for (const tr of (existingTransfers || [])) {
    const tgl = String(tr.tgl_inputan || '');
    if (!transfersByDate[tgl]) transfersByDate[tgl] = [];
    transfersByDate[tgl].push(tr);
  }
  for (const c of candidates) {
    c.existingTransfers = transfersByDate[c.tanggal_buat] || [];
    c.hasExistingTransfer = c.existingTransfers.length > 0;
  }
  const match = candidates.find(c => !c.hasExistingTransfer) || null;
  const allPaid = candidates.length > 0 && candidates.every(c => c.hasExistingTransfer);
  return { match, allPaid };
}

async function ensureFreshNoncod(supabase, periodes) {
  for (const periode of periodes) {
    try {
      const meta = await readSyncMeta(supabase, periode);
      if (isSyncMetaStale(meta)) {
        await maybeSyncMaukirimPeriod(supabase, periode, { force: true });
      }
    } catch (_) { /* sync failure is non-blocking */ }
  }
}

async function findNoncodDateMatch(supabase, { namaCabang, nominal }) {
  const normalizedCabang = String(namaCabang || '').trim().toUpperCase();
  const normalizedNominal = Number(nominal || 0);
  if (!normalizedCabang || normalizedNominal <= 0) {
    return { match: null, candidates: [], message: 'Cabang dan nominal wajib diisi.' };
  }

  const periodes = getRecentPeriodes();
  await ensureFreshNoncod(supabase, periodes);
  const { data: noncodRows, error: ncErr } = await supabase
    .from('noncod')
    .select('tanggal_buat, ongkir, metode_pembayaran, nomor_resi, status_terakhir')
    .in('periode', periodes)
    .eq('cabang', normalizedCabang);
  if (ncErr) throw ncErr;

  const overrideMap = await readStatusOverridesByResi(supabase, (noncodRows || []).map((row) => row.nomor_resi));
  const effectiveRows = applyStatusOverrides(noncodRows, overrideMap);
  const byDate = aggregateOngkirByDate(effectiveRows);

  if (!Object.keys(byDate).length) {
    return {
      match: null,
      candidates: [],
      message: 'Tidak ada data NONCOD untuk ' + normalizedCabang + ' pada 3 periode terakhir.',
    };
  }

  const candidates = findMatchingDates(byDate, normalizedNominal, NONCOD_MATCH_TOLERANCE);

  if (!candidates.length) {
    return {
      match: null,
      candidates: [],
      message: 'Nominal Rp ' + normalizedNominal.toLocaleString('id-ID') +
        ' tidak cocok dengan NONCOD manapun untuk ' + normalizedCabang +
        '. Toleransi maks Rp ' + NONCOD_MATCH_TOLERANCE.toLocaleString('id-ID') + '.',
    };
  }

  const candidateDates = candidates.map(c => c.tanggal_buat);
  const { data: existingTransfers, error: trErr } = await supabase
    .from('transfers')
    .select('id, tgl_inputan, nominal, nama_bank, nama_cabang, timestamp')
    .eq('nama_cabang', normalizedCabang)
    .in('tgl_inputan', candidateDates);
  if (trErr) throw trErr;

  const { match, allPaid } = resolveMatch(candidates, existingTransfers);

  if (allPaid) {
    const first = candidates[0];
    return {
      match: null,
      candidates,
      blocked: true,
      message: 'Semua tanggal NONCOD yang cocok sudah memiliki bukti transfer. Indikasi pembayaran dobel.',
      existingTransfer: first.existingTransfers[0] || null,
    };
  }

  return { match, candidates, blocked: false, message: null };
}

module.exports = {
  NONCOD_MATCH_TOLERANCE,
  aggregateOngkirByDate,
  findMatchingDates,
  findNoncodDateMatch,
  getRecentPeriodes,
  resolveMatch,
};
