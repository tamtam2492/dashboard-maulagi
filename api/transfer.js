const { requireAdmin } = require('./_auth');
const {
  deleteCabangHold,
  normalizeCabangHoldTransferId,
} = require('./_noncod-cabang-holds');
const { cors } = require('./_cors');
const { logError } = require('./_logger');
const { normalizeBankName } = require('./_bank');
const {
  pruneProofSignatureRegistryByTransferIds,
  replaceProofSignatureRegistryTransferIds,
} = require('./_proof-signature');
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
  buildTransferAllocationPlan,
  deleteTransferAllocation,
  loadTransferAllocationContext,
  readTransferAllocationRowsByTransferIds,
  splitTransferAllocationRecord,
  upsertTransferAllocation,
} = require('./_noncod-transfer-allocations');
const {
  markNoncodSyncDirty,
} = require('./_noncod-sync-pipeline');
const { getSupabase } = require('./_supabase');
const { publishAdminWriteMarker, readAdminWriteMarker } = require('./_admin-write-marker');
const {
  ensureAllowedMethod,
  normalizeQueryFlag,
  normalizeText,
} = require('./_request-validation');
const {
  buildTransferUpdate,
  getAffectedTransferPeriodes,
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

async function clearCabangHoldSafe(supabase, transferId, context) {
  const normalizedTransferId = normalizeCabangHoldTransferId(transferId);
  if (!normalizedTransferId) return;

  try {
    await deleteCabangHold(supabase, normalizedTransferId);
  } catch (err) {
    logError('transfer-cabang-hold', err.message, {
      method: context,
      transferId: normalizedTransferId,
    });
  }
}

async function clearTransferAllocationSafe(supabase, transferId, context) {
  const normalizedTransferId = normalizeText(transferId, 120);
  if (!normalizedTransferId) return;

  try {
    await deleteTransferAllocation(supabase, normalizedTransferId);
  } catch (err) {
    logError('transfer-allocation', err.message, {
      method: context,
      transferId: normalizedTransferId,
      action: 'delete_transfer_allocation',
    });
  }
}

async function rebuildTransferAllocationSafe(supabase, transfer, source, context) {
  const transferId = normalizeText(transfer && transfer.id, 120);
  const cabang = normalizeText(transfer && transfer.nama_cabang, 120);
  const transferDate = normalizeTransferDateValue(transfer && transfer.tgl_inputan);
  const transferNominal = roundTransferNominal(transfer && transfer.nominal);
  if (!transferId || !cabang || !transferDate || !(transferNominal > 0)) return;

  try {
    const allocationContext = await loadTransferAllocationContext(supabase, {
      cabang,
      targetDates: [transferDate],
      excludeTransferIds: [transferId],
    });
    const plans = buildTransferAllocationPlan({
      noncodRows: allocationContext.effectiveRows,
      existingTransfers: allocationContext.existingTransfers,
      existingAllocationRows: allocationContext.existingAllocationRows,
      plannedRows: [{ tgl_inputan: transferDate, nominal: transferNominal }],
    });
    const plan = plans[0] || { allocations: [], unallocatedNominal: transferNominal };

    await upsertTransferAllocation(supabase, {
      transfer_id: transferId,
      cabang,
      transfer_date: transferDate,
      transfer_nominal: transferNominal,
      source,
      allocations: plan.allocations,
      unallocated_nominal: plan.unallocatedNominal,
      created_at: transfer && transfer.timestamp,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    logError('transfer-allocation', err.message, {
      method: context,
      transferId,
      action: 'rebuild_transfer_allocation',
      source,
    });
  }
}

async function replaceTransferAllocationAfterSplitSafe(supabase, oldTransfer, newTransfers, source, context) {
  const oldTransferId = normalizeText(oldTransfer && oldTransfer.id, 120);
  const cabang = normalizeText(oldTransfer && oldTransfer.nama_cabang, 120);
  if (!oldTransferId || !cabang || !Array.isArray(newTransfers) || !newTransfers.length) return;

  try {
    const existingAllocation = (await readTransferAllocationRowsByTransferIds(supabase, [oldTransferId]))[0] || null;
    let records = [];

    if (existingAllocation) {
      records = splitTransferAllocationRecord(existingAllocation, newTransfers.map((row) => ({
        ...row,
        nama_cabang: row.nama_cabang || cabang,
      })));
    } else {
      const allocationContext = await loadTransferAllocationContext(supabase, {
        cabang,
        targetDates: newTransfers.map((row) => row.tgl_inputan),
        excludeTransferIds: [oldTransferId],
      });
      const plans = buildTransferAllocationPlan({
        noncodRows: allocationContext.effectiveRows,
        existingTransfers: allocationContext.existingTransfers,
        existingAllocationRows: allocationContext.existingAllocationRows,
        plannedRows: newTransfers.map((row) => ({
          tgl_inputan: row.tgl_inputan,
          nominal: row.nominal,
        })),
      });
      records = newTransfers.map((row, index) => ({
        transfer_id: row.id,
        cabang,
        transfer_date: row.tgl_inputan,
        transfer_nominal: row.nominal,
        source,
        allocations: plans[index] ? plans[index].allocations : [],
        unallocated_nominal: plans[index] ? plans[index].unallocatedNominal : roundTransferNominal(row.nominal),
        created_at: row.timestamp || oldTransfer.timestamp,
        updated_at: row.timestamp || new Date().toISOString(),
      }));
    }

    for (const record of records) {
      await upsertTransferAllocation(supabase, record);
    }
    await clearTransferAllocationSafe(supabase, oldTransferId, context);
  } catch (err) {
    logError('transfer-allocation', err.message, {
      method: context,
      transferId: oldTransferId,
      newTransferIds: newTransfers.map((row) => row.id).filter(Boolean),
      action: 'replace_transfer_allocation_after_split',
      source,
    });
  }
}

async function pruneProofRegistrySafe(supabase, transferIds, context) {
  try {
    await pruneProofSignatureRegistryByTransferIds(supabase, transferIds);
  } catch (err) {
    logError('transfer-proof-signature', err.message, {
      method: context,
      transferIds: Array.isArray(transferIds) ? transferIds : [transferIds],
      action: 'prune_proof_registry',
    });
  }
}

async function replaceProofRegistrySafe(supabase, oldTransferId, newTransfers, context) {
  try {
    await replaceProofSignatureRegistryTransferIds(supabase, oldTransferId, newTransfers);
  } catch (err) {
    logError('transfer-proof-signature', err.message, {
      method: context,
      transferId: String(oldTransferId || '').trim(),
      newTransferIds: (Array.isArray(newTransfers) ? newTransfers : []).map((row) => String(row && row.id || '').trim()).filter(Boolean),
      action: 'replace_proof_registry_transfer_ids',
    });
  }
}

async function markPipelineDirtySafe(supabase, periodes, reason, context) {
  const affectedPeriodes = [...new Set((periodes || []).filter(Boolean))];
  if (!affectedPeriodes.length) return;

  try {
    await markNoncodSyncDirty(supabase, {
      reason,
      periodes: affectedPeriodes,
    });
  } catch (err) {
    logError('noncod-sync', err.message, {
      method: context,
      action: 'mark_dirty_after_transfer_write',
      periodes: affectedPeriodes,
    });
  }
}

async function publishAdminWriteMarkerSafe(supabase, options, context) {
  try {
    await publishAdminWriteMarker(supabase, options || {});
  } catch (err) {
    logError('admin-marker', err.message, {
      method: context,
      action: 'publish_admin_write_marker',
      source: options && options.source,
      scopes: options && options.scopes,
      periodes: options && options.periodes,
    });
  }
}

async function handleCarryoverRoute(req, res, supabase) {
  if (req.method === 'GET') {
    try {
      const result = await listCarryoverOverrideRows(supabase, {
        periode: normalizeText(req.query.periode, 20),
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

      await publishAdminWriteMarkerSafe(supabase, {
        source: 'carryover_put',
        scopes: ['admin_monitor', 'carryover'],
        periodes: [override.target_periode, override.transfer_periode],
      }, 'PUT');

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

      const existingRows = await listCarryoverOverrideRows(supabase, {});
      const existingOverride = (existingRows.rows || []).find((row) => row.transfer_id === transferId) || null;
      await deleteCarryoverOverride(supabase, transferId);
      await publishAdminWriteMarkerSafe(supabase, {
        source: 'carryover_delete',
        scopes: ['admin_monitor', 'carryover'],
        periodes: existingOverride ? [existingOverride.target_periode, existingOverride.transfer_periode] : [],
      }, 'DELETE');
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
        periode: normalizeText(req.query.periode, 20),
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

      const existingRows = await listPendingAllocationRows(supabase, {});
      const existingPending = (existingRows.rows || []).find((row) => row.root_transfer_id === transferId) || null;
      await deletePendingAllocation(supabase, transferId);
      await publishAdminWriteMarkerSafe(supabase, {
        source: 'pending_allocation_delete',
        scopes: ['admin_monitor', 'pending_allocation'],
        periodes: existingPending ? [existingPending.after_periode] : [],
      }, 'DELETE');
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
  if (!ensureAllowedMethod(req, res, ['GET', 'POST', 'PUT', 'DELETE'])) return;

  const isCarryoverRoute = normalizeQueryFlag(req.query.carryover);
  const isPendingAllocationRoute = normalizeQueryFlag(req.query.pending_allocation);
  const isWatchRoute = normalizeQueryFlag(req.query.watch);

  // Transfer review and all write operations are admin only
  if (['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
    if (!(await requireAdmin(req, res))) return;
  }

  try {
  const supabase = getSupabase();

  if (isCarryoverRoute) {
    if (await handleCarryoverRoute(req, res, supabase)) return;
  }

  if (isPendingAllocationRoute) {
    if (await handlePendingAllocationRoute(req, res, supabase)) return;
  }

  if (isWatchRoute) {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    const marker = await readAdminWriteMarker(supabase);
    return res.json({ marker });
  }

  // GET ?periode=2026-04
  if (req.method === 'GET') {
    const periode = normalizeText(req.query.periode, 20);
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
    const body = req.body || {};
    const action = normalizeText(body.action, 40);
    const id = normalizeText(body.id, 120);
    const rows = body.rows;

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
    const { data: insertedRows, error: insErr } = await supabase
      .from('transfers')
      .insert(newRows)
      .select('id, timestamp, tgl_inputan, nominal, nama_cabang');
    if (insErr) {
      // Rollback: restore row asli jika insert gagal
      const { timestamp, tgl_inputan: ti, periode: p, nama_bank: nb, nama_cabang: nc, nominal: n, bukti_url: bu, ket: k } = orig;
      const rollbackResult = await supabase.from('transfers').insert({
        timestamp,
        tgl_inputan: ti,
        periode: p,
        nama_bank: normalizeBankName(nb),
        nama_cabang: nc,
        nominal: n,
        bukti_url: bu,
        ket: k,
      });
      if (rollbackResult.error) {
        logError('transfer', rollbackResult.error.message, {
          method: 'POST',
          action: 'rollback_restore_original_transfer',
          transferId: id,
        });
      }
      return res.status(500).json({ error: 'Gagal insert baris baru, data asli dikembalikan.' });
    }

    await clearCarryoverOverrideSafe(supabase, id, 'POST');
    await clearPendingAllocationSafe(supabase, id, 'POST');
    await clearCabangHoldSafe(supabase, id, 'POST');
    await replaceTransferAllocationAfterSplitSafe(supabase, orig, insertedRows || [], 'admin_transfer_split', 'POST');
    await replaceProofRegistrySafe(supabase, id, insertedRows || [], 'POST');
    await publishAdminWriteMarkerSafe(supabase, {
      source: 'transfer_split',
      scopes: ['overview', 'noncod', 'transfer', 'audit', 'admin_monitor'],
      periodes: getAffectedTransferPeriodes([orig.tgl_inputan, ...newRows.map((row) => row.tgl_inputan)]),
    }, 'POST');
    await markPipelineDirtySafe(
      supabase,
      getAffectedTransferPeriodes([orig.tgl_inputan, ...newRows.map((row) => row.tgl_inputan)]),
      'transfer_split',
      'POST',
    );

    return res.json({ success: true, inserted: Array.isArray(insertedRows) ? insertedRows.length : newRows.length });
  }

  // PUT — edit tgl_inputan (dan optional ket) satu baris
  if (req.method === 'PUT') {
    const body = req.body || {};
    const id = normalizeText(body.id, 120);
    const { tgl_inputan, ket } = body;
    const hasNominal = Object.prototype.hasOwnProperty.call(body, 'nominal');
    if (!id) return res.status(400).json({ error: 'ID diperlukan.' });
    if (!isValidTransferDate(tgl_inputan)) {
      return res.status(400).json({ error: 'Format tanggal tidak valid (YYYY-MM-DD).' });
    }
    if (hasNominal && !isPositiveTransferNominal(body.nominal)) {
      return res.status(400).json({ error: 'Nominal harus lebih dari 0.' });
    }

    const { data: existing, error: findErr } = await supabase
      .from('transfers')
      .select('id, tgl_inputan, nominal, nama_cabang, timestamp')
      .eq('id', id)
      .maybeSingle();
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!existing) return res.status(404).json({ error: 'Transfer tidak ditemukan.' });

    const update = buildTransferUpdate(tgl_inputan, ket, hasNominal ? body.nominal : undefined);
    if (!update) return res.status(400).json({ error: 'Data transfer tidak valid.' });

    const { data: updated, error: updErr } = await supabase
      .from('transfers')
      .update(update)
      .eq('id', id)
      .select('id, tgl_inputan, nominal, nama_cabang, timestamp')
      .maybeSingle();
    if (updErr) return res.status(500).json({ error: updErr.message });

    await clearCarryoverOverrideSafe(supabase, id, 'PUT');
    await clearPendingAllocationSafe(supabase, id, 'PUT');
    await clearCabangHoldSafe(supabase, id, 'PUT');
    await rebuildTransferAllocationSafe(supabase, updated || { ...existing, ...update }, 'admin_transfer_update', 'PUT');
    await publishAdminWriteMarkerSafe(supabase, {
      source: 'transfer_update',
      scopes: ['overview', 'noncod', 'transfer', 'audit', 'admin_monitor'],
      periodes: getAffectedTransferPeriodes([existing.tgl_inputan, update.tgl_inputan]),
    }, 'PUT');
    await markPipelineDirtySafe(
      supabase,
      getAffectedTransferPeriodes([existing.tgl_inputan, update.tgl_inputan]),
      'transfer_update',
      'PUT',
    );
    return res.json({ success: true, periode: update.periode });
  }

  // DELETE — hapus satu baris transfer
  if (req.method === 'DELETE') {
    const id = normalizeText(req.query.id || req.body?.id, 120);
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
    await clearCabangHoldSafe(supabase, id, 'DELETE');
    await clearTransferAllocationSafe(supabase, id, 'DELETE');
    await pruneProofRegistrySafe(supabase, [id], 'DELETE');
    await publishAdminWriteMarkerSafe(supabase, {
      source: 'transfer_delete',
      scopes: ['overview', 'noncod', 'transfer', 'audit', 'admin_monitor'],
      periodes: [getPeriodeFromDate(existing.tgl_inputan)],
    }, 'DELETE');
    await markPipelineDirtySafe(
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
