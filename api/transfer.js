const { requireAdmin } = require('./_auth');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { normalizeBankName } = require('./_bank');
const {
  MAX_NONCOD_CARRYOVER_AMOUNT,
  deleteCarryoverOverride,
  listCarryoverOverrideRows,
  normalizeCarryoverAmount,
  normalizeCarryoverCabang,
  normalizeCarryoverDate,
  normalizeCarryoverTransferId,
  upsertCarryoverOverride,
} = require('./_noncod-carryover-overrides');
const {
  deletePendingAllocation,
  listPendingAllocationRows,
  normalizePendingTransferId,
} = require('./_noncod-pending-allocations');
const {
  markNoncodSyncDirty,
  queueNoncodPipelineTrigger,
} = require('./_noncod-sync-pipeline');
const { getSupabase } = require('./_supabase');
const {
  buildTransferUpdate,
  getPeriodeFromDate,
  isPositiveTransferNominal,
  isValidTransferDate,
  normalizeTransferKet,
  roundTransferNominal,
} = require('./_transfer-utils');

function normalizeProofUrl(buktiUrl) {
  let value = String(buktiUrl || '').trim();
  if (!value) return '';
  if (value.includes('drive.google.com')) {
    let fileId = null;
    const byId = value.match(/[?&]id=([^&]+)/);
    const byPath = value.match(/\/file\/d\/([^/]+)/);
    if (byId) fileId = byId[1];
    else if (byPath) fileId = byPath[1];
    if (fileId) return '/api/proxy-image?id=' + fileId;
  }
  if (!value.startsWith('http')) {
    return '/api/proxy-image?path=' + encodeURIComponent(value);
  }
  return value;
}

function normalizeTransferDateValue(value) {
  return normalizeCarryoverDate(value);
}

async function clearCarryoverOverrideSafe(supabase, transferId, context) {
  const normalizedTransferId = normalizeCarryoverTransferId(transferId);
  if (!normalizedTransferId) return;

  try {
    await deleteCarryoverOverride(supabase, normalizedTransferId);
  } catch (err) {
    logError('transfer-carryover', err.message, {
      method: context,
      transferId: normalizedTransferId,
    });
  }
}

async function clearPendingAllocationSafe(supabase, transferId, context) {
  const normalizedTransferId = normalizePendingTransferId(transferId);
  if (!normalizedTransferId) return;

  try {
    await deletePendingAllocation(supabase, normalizedTransferId);
  } catch (err) {
    logError('transfer-pending-allocation', err.message, {
      method: context,
      transferId: normalizedTransferId,
    });
  }
}

async function queuePipelineRefreshSafe(supabase, periodes, reason, context) {
  const affectedPeriodes = [...new Set((periodes || []).filter(Boolean))];
  if (!affectedPeriodes.length) return;

  try {
    await markNoncodSyncDirty(supabase, {
      reason,
      periodes: affectedPeriodes,
    });
    queueNoncodPipelineTrigger({
      reason,
      periodes: affectedPeriodes,
      source: 'transfer',
    });
  } catch (err) {
    logError('noncod-sync', err.message, {
      method: context,
      action: 'queue_after_transfer_write',
      periodes: affectedPeriodes,
    });
  }
}

async function handleCarryoverRoute(req, res, supabase) {
  if (req.method === 'GET') {
    try {
      const result = await listCarryoverOverrideRows(supabase, {
        periode: req.query.periode || '',
      });
      res.json(result);
      return true;
    } catch (err) {
      console.error(err);
      logError('transfer-carryover', err.message, { method: 'GET' });
      res.status(500).json({ error: 'Gagal memuat carry-over H+1.' });
      return true;
    }
  }

  if (req.method === 'PUT') {
    try {
      const transferId = normalizeCarryoverTransferId(req.body && req.body.transfer_id);
      const targetDate = normalizeCarryoverDate(req.body && req.body.target_date);
      const transferDate = normalizeCarryoverDate(req.body && req.body.transfer_date);
      const nominal = normalizeCarryoverAmount(req.body && req.body.nominal);

      if (!transferId || !targetDate || !transferDate || !(nominal > 0)) {
        res.status(400).json({ error: 'Data carry-over H+1 wajib lengkap.' });
        return true;
      }
      if (nominal > MAX_NONCOD_CARRYOVER_AMOUNT) {
        res.status(400).json({ error: 'Carry-over H+1 maksimal Rp 100.000.' });
        return true;
      }

      const { data: transfer, error: transferError } = await supabase
        .from('transfers')
        .select('id, nama_cabang, tgl_inputan, nominal, nama_bank')
        .eq('id', transferId)
        .maybeSingle();

      if (transferError) throw transferError;
      if (!transfer) {
        res.status(404).json({ error: 'Transfer tidak ditemukan.' });
        return true;
      }

      const transferCabang = normalizeCarryoverCabang(transfer.nama_cabang);
      const payloadCabang = normalizeCarryoverCabang((req.body && req.body.cabang) || transfer.nama_cabang);
      const actualTransferDate = normalizeTransferDateValue(transfer.tgl_inputan);
      const transferNominal = Math.round(Number(transfer.nominal || 0));

      if (!transferCabang || payloadCabang !== transferCabang) {
        res.status(400).json({ error: 'Cabang carry-over tidak sesuai dengan transfer.' });
        return true;
      }
      if (!actualTransferDate || actualTransferDate !== transferDate) {
        res.status(400).json({ error: 'Tanggal transfer carry-over harus mengikuti tanggal transfer asli.' });
        return true;
      }
      if (transferNominal < nominal) {
        res.status(400).json({ error: 'Nominal carry-over tidak boleh melebihi nominal transfer.' });
        return true;
      }

      const override = await upsertCarryoverOverride(supabase, {
        transfer_id: transferId,
        cabang: transferCabang,
        target_date: targetDate,
        transfer_date: transferDate,
        nominal,
        reason: req.body && req.body.reason,
        transfer_bank: transfer.nama_bank,
      });

      res.json({ success: true, override });
      return true;
    } catch (err) {
      console.error(err);
      const statusCode = /wajib lengkap|maksimal|tidak valid|tidak sesuai|melebihi/i.test(err.message) ? 400 : 500;
      if (statusCode === 500) logError('transfer-carryover', err.message, { method: 'PUT' });
      res.status(statusCode).json({ error: err.message || 'Gagal menyimpan carry-over H+1.' });
      return true;
    }
  }

  if (req.method === 'DELETE') {
    try {
      const transferId = normalizeCarryoverTransferId(req.query.transfer_id || req.body?.transfer_id);
      if (!transferId) {
        res.status(400).json({ error: 'ID transfer wajib diisi.' });
        return true;
      }

      await deleteCarryoverOverride(supabase, transferId);
      res.json({ success: true });
      return true;
    } catch (err) {
      console.error(err);
      const statusCode = /tidak valid/i.test(err.message) ? 400 : 500;
      if (statusCode === 500) logError('transfer-carryover', err.message, { method: 'DELETE' });
      res.status(statusCode).json({ error: err.message || 'Gagal menghapus carry-over H+1.' });
      return true;
    }
  }

  res.status(405).json({ error: 'Method not allowed.' });
  return true;
}

async function handlePendingAllocationRoute(req, res, supabase) {
  if (req.method === 'GET') {
    try {
      const result = await listPendingAllocationRows(supabase, {
        periode: req.query.periode || '',
      });
      res.json(result);
      return true;
    } catch (err) {
      console.error(err);
      logError('transfer-pending-allocation', err.message, { method: 'GET' });
      res.status(500).json({ error: 'Gagal memuat pending tempel NONCOD.' });
      return true;
    }
  }

  if (req.method === 'DELETE') {
    try {
      const transferId = normalizePendingTransferId(req.query.transfer_id || req.body?.transfer_id);
      if (!transferId) {
        res.status(400).json({ error: 'ID transfer wajib diisi.' });
        return true;
      }

      await deletePendingAllocation(supabase, transferId);
      res.json({ success: true });
      return true;
    } catch (err) {
      console.error(err);
      const statusCode = /tidak valid/i.test(err.message) ? 400 : 500;
      if (statusCode === 500) logError('transfer-pending-allocation', err.message, { method: 'DELETE' });
      res.status(statusCode).json({ error: err.message || 'Gagal menghapus pending tempel NONCOD.' });
      return true;
    }
  }

  res.status(405).json({ error: 'Method not allowed.' });
  return true;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (cors(req, res, { methods: 'GET, POST, PUT, DELETE, OPTIONS', headers: 'Content-Type, X-Admin-Token' })) return;

  // Transfer review and all write operations are admin only
  if (['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
    if (!(await requireAdmin(req, res))) return;
  }

  try {
  const supabase = getSupabase();

  if (req.query.carryover === '1') {
    if (await handleCarryoverRoute(req, res, supabase)) return;
  }

  if (req.query.pending_allocation === '1') {
    if (await handlePendingAllocationRoute(req, res, supabase)) return;
  }

  // GET ?periode=2026-04
  if (req.method === 'GET') {
    const { periode } = req.query;
    if (!periode || !/^\d{4}-\d{2}$/.test(periode)) {
      return res.status(400).json({ error: 'Parameter periode tidak valid (format: YYYY-MM).' });
    }
    const [, mm] = periode.split('-');
    if (parseInt(mm) < 1 || parseInt(mm) > 12) {
      return res.status(400).json({ error: 'Bulan tidak valid.' });
    }
    const { data, error } = await supabase
      .from('transfers')
      .select('id, timestamp, tgl_inputan, periode, nama_bank, nama_cabang, nominal, bukti_url, ket')
      .eq('periode', periode)
      .order('timestamp', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const normalizedTransfers = (data || []).map(row => ({
      ...row,
      nama_bank: normalizeBankName(row.nama_bank),
      bukti: normalizeProofUrl(row.bukti_url),
    }));

    // Hitung summary
    const total = normalizedTransfers.reduce((s, r) => s + parseFloat(r.nominal || 0), 0);
    const cabangSet = new Set(normalizedTransfers.map(r => r.nama_cabang));
    return res.json({ transfers: normalizedTransfers, total, transaksi: normalizedTransfers.length, cabang: cabangSet.size });
  }

  // POST — split action
  if (req.method === 'POST') {
    const { action, id, rows } = req.body;

    if (action !== 'split') return res.status(400).json({ error: 'Action tidak dikenal.' });
    if (!id) return res.status(400).json({ error: 'ID transfer diperlukan.' });
    if (!Array.isArray(rows) || rows.length < 2) {
      return res.status(400).json({ error: 'Minimal 2 baris rincian untuk split.' });
    }

    // Ambil data asli
    const { data: orig, error: fetchErr } = await supabase
      .from('transfers')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchErr || !orig) return res.status(404).json({ error: 'Transfer tidak ditemukan.' });

    // Validasi total rincian = nominal asli
    const totalRincian = rows.reduce((sum, row) => sum + roundTransferNominal(row.nominal || 0), 0);
    const origNominal = roundTransferNominal(orig.nominal);
    if (totalRincian !== origNominal) {
      return res.status(400).json({
        error: `Total rincian (${totalRincian}) tidak sama dengan nominal asli (${orig.nominal}).`
      });
    }

    // Validasi tiap baris
    for (const r of rows) {
      if (!isValidTransferDate(r.tgl_inputan) || !isPositiveTransferNominal(r.nominal)) {
        return res.status(400).json({ error: 'Setiap baris harus punya tanggal dan nominal > 0.' });
      }
    }

    // Hapus row asli dulu (lebih aman — jika delete gagal, data tidak terduplikat)
    const newRows = rows.map(r => ({
      timestamp: orig.timestamp,
      tgl_inputan: r.tgl_inputan,
      periode: getPeriodeFromDate(r.tgl_inputan),
      nama_bank: normalizeBankName(orig.nama_bank),
      nama_cabang: orig.nama_cabang,
      nominal: roundTransferNominal(r.nominal),
      bukti_url: orig.bukti_url,
      ket: normalizeTransferKet(r.ket) || orig.ket || null,
    }));

    const { error: delErr } = await supabase.from('transfers').delete().eq('id', id);
    if (delErr) return res.status(500).json({ error: 'Gagal menghapus transfer asli: ' + delErr.message });

    // Insert baris baru
    const { error: insErr } = await supabase.from('transfers').insert(newRows);
    if (insErr) {
      // Rollback: restore row asli jika insert gagal
      const { timestamp, tgl_inputan: ti, periode: p, nama_bank: nb, nama_cabang: nc, nominal: n, bukti_url: bu, ket: k } = orig;
      await supabase.from('transfers').insert({ timestamp, tgl_inputan: ti, periode: p, nama_bank: normalizeBankName(nb), nama_cabang: nc, nominal: n, bukti_url: bu, ket: k }).catch(() => {});
      return res.status(500).json({ error: 'Gagal insert baris baru, data asli dikembalikan.' });
    }

    await clearCarryoverOverrideSafe(supabase, id, 'POST');
    await clearPendingAllocationSafe(supabase, id, 'POST');
    await queuePipelineRefreshSafe(
      supabase,
      newRows.map((row) => row.periode),
      'transfer_split',
      'POST',
    );

    return res.json({ success: true, inserted: newRows.length });
  }

  // PUT — edit tgl_inputan (dan optional ket) satu baris
  if (req.method === 'PUT') {
    const body = req.body || {};
    const { id, tgl_inputan, ket } = body;
    const hasNominal = Object.prototype.hasOwnProperty.call(body, 'nominal');
    if (!id) return res.status(400).json({ error: 'ID diperlukan.' });
    if (!isValidTransferDate(tgl_inputan)) {
      return res.status(400).json({ error: 'Format tanggal tidak valid (YYYY-MM-DD).' });
    }
    if (hasNominal && !isPositiveTransferNominal(body.nominal)) {
      return res.status(400).json({ error: 'Nominal harus lebih dari 0.' });
    }
    const update = buildTransferUpdate(tgl_inputan, ket, hasNominal ? body.nominal : undefined);
    if (!update) return res.status(400).json({ error: 'Data transfer tidak valid.' });

    const { error: updErr } = await supabase.from('transfers').update(update).eq('id', id);
    if (updErr) return res.status(500).json({ error: updErr.message });

    await clearCarryoverOverrideSafe(supabase, id, 'PUT');
    await clearPendingAllocationSafe(supabase, id, 'PUT');
    await queuePipelineRefreshSafe(supabase, [update.periode], 'transfer_update', 'PUT');
    return res.json({ success: true, periode: update.periode });
  }

  // DELETE — hapus satu baris transfer
  if (req.method === 'DELETE') {
    const id = String(req.query.id || req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'ID diperlukan.' });

    const { data: existing, error: findErr } = await supabase
      .from('transfers')
      .select('id, nama_cabang, tgl_inputan, nominal')
      .eq('id', id)
      .maybeSingle();
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!existing) return res.status(404).json({ error: 'Transfer tidak ditemukan.' });

    const { error: delErr } = await supabase.from('transfers').delete().eq('id', id);
    if (delErr) return res.status(500).json({ error: delErr.message });

    await clearCarryoverOverrideSafe(supabase, id, 'DELETE');
    await clearPendingAllocationSafe(supabase, id, 'DELETE');
    await queuePipelineRefreshSafe(
      supabase,
      [getPeriodeFromDate(existing.tgl_inputan)],
      'transfer_delete',
      'DELETE',
    );

    return res.json({ success: true, deleted: existing });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error(err);
    logError('transfer', err.message, { method: req.method });
    return res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
};
