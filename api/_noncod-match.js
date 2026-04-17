const { applyStatusOverrides, readStatusOverridesByResi } = require('./_noncod-status-overrides');

const NONCOD_MATCH_TOLERANCE = 10000;
const NONCOD_SPLIT_TOLERANCE = 500;
const PERIODE_RE = /^\d{4}-\d{2}$/;
const PREFETCHED_CONTEXT_TTL_MS = 30 * 1000;

const prefetchedContexts = new Map();
let prefetchedContextCounter = 0;

function isExcludedNoncodStatus(value) {
  return String(value || '').trim().toUpperCase() === 'VOID';
}

function getPreferredSyncPeriodes(periodes, preferredPeriode) {
  const normalizedPreferredPeriode = String(preferredPeriode || '').trim();
  if (PERIODE_RE.test(normalizedPreferredPeriode) && periodes.includes(normalizedPreferredPeriode)) {
    return [normalizedPreferredPeriode];
  }
  return periodes.length ? [periodes[periodes.length - 1]] : [];
}

function getNoncodSyncModule() {
  return require('./noncod');
}

function buildDateCandidates(byDate) {
  return Object.entries(byDate || {}).map(([tgl, totalOngkir]) => ({
    tanggal_buat: tgl,
    totalOngkir: Number(totalOngkir || 0),
    periode: tgl.slice(0, 7),
  }));
}

function filterByPreferredPeriode(byDate, preferredPeriode) {
  const normalizedPeriode = String(preferredPeriode || '').trim();
  if (!PERIODE_RE.test(normalizedPeriode)) return {};
  const filtered = {};
  for (const [tgl, totalOngkir] of Object.entries(byDate || {})) {
    if (String(tgl).startsWith(normalizedPeriode + '-')) filtered[tgl] = totalOngkir;
  }
  return filtered;
}

function getSearchByDate(byDate, preferredPeriode) {
  const normalizedPeriode = String(preferredPeriode || '').trim();
  if (!PERIODE_RE.test(normalizedPeriode)) return byDate || {};
  return filterByPreferredPeriode(byDate, normalizedPeriode);
}

function groupTransfersByDate(existingTransfers) {
  const transfersByDate = {};
  const paidNominalByDate = {};
  for (const tr of (existingTransfers || [])) {
    const tgl = String(tr.tgl_inputan || '').trim();
    if (!tgl) continue;
    if (!transfersByDate[tgl]) transfersByDate[tgl] = [];
    transfersByDate[tgl].push(tr);
    paidNominalByDate[tgl] = (paidNominalByDate[tgl] || 0) + Number(tr.nominal || 0);
  }
  return { transfersByDate, paidNominalByDate };
}

function annotateCandidates(candidates, existingTransfers) {
  const { transfersByDate, paidNominalByDate } = groupTransfersByDate(existingTransfers);
  for (const c of (candidates || [])) {
    c.existingTransfers = transfersByDate[c.tanggal_buat] || [];
    c.hasExistingTransfer = c.existingTransfers.length > 0;
    c.paidNominal = paidNominalByDate[c.tanggal_buat] || 0;
    c.remainingNominal = Math.max(Number(c.totalOngkir || 0) - c.paidNominal, 0);
    c.isFullyPaid = c.remainingNominal <= 0;
  }
  return candidates || [];
}

function getOutstandingCandidates(byDate, existingTransfers) {
  return annotateCandidates(buildDateCandidates(byDate), existingTransfers)
    .filter(c => c.remainingNominal > 0)
    .sort((a, b) => a.tanggal_buat.localeCompare(b.tanggal_buat));
}

function allocateSplitPlannedNominals(dates, transferTotal) {
  let remainingTransfer = Number(transferTotal || 0);
  return (dates || []).map((item, index) => {
    const isLast = index === dates.length - 1;
    const plannedNominal = isLast
      ? remainingTransfer
      : Math.min(Number(item.remainingNominal || 0), remainingTransfer);
    remainingTransfer -= plannedNominal;
    return {
      tanggal_buat: item.tanggal_buat,
      periode: item.periode,
      totalOngkir: item.totalOngkir,
      paidNominal: item.paidNominal,
      remainingNominal: item.remainingNominal,
      plannedNominal,
    };
  }).filter(item => item.plannedNominal > 0);
}

function getOutstandingNominalForDate(byDate, existingTransfers, targetDate) {
  const normalizedTargetDate = String(targetDate || '').trim();
  if (!normalizedTargetDate) return 0;

  const candidates = annotateCandidates(buildDateCandidates(byDate), existingTransfers);
  const target = candidates.find((candidate) => candidate.tanggal_buat === normalizedTargetDate);
  return target ? Math.max(Number(target.remainingNominal || 0), 0) : 0;
}

function findSequentialAllocationDates(byDate, existingTransfers, nominal, startDate = '', options = {}) {
  const normalizedNominal = Number(nominal || 0);
  const normalizedStartDate = String(startDate || '').trim();
  const includeStartDate = !!options.includeStartDate;
  if (!(normalizedNominal > 0)) {
    return { dates: [], allocatedTotal: 0, pendingNominal: 0, lastDate: normalizedStartDate };
  }

  const outstandingDates = getOutstandingCandidates(byDate, existingTransfers)
    .filter((candidate) => {
      if (!normalizedStartDate) return true;
      return includeStartDate
        ? candidate.tanggal_buat >= normalizedStartDate
        : candidate.tanggal_buat > normalizedStartDate;
    });

  let remainingNominal = normalizedNominal;
  const dates = [];
  for (const candidate of outstandingDates) {
    if (!(remainingNominal > 0)) break;
    const plannedNominal = Math.min(Number(candidate.remainingNominal || 0), remainingNominal);
    if (!(plannedNominal > 0)) continue;
    dates.push({
      tanggal_buat: candidate.tanggal_buat,
      periode: candidate.periode,
      totalOngkir: candidate.totalOngkir,
      paidNominal: candidate.paidNominal,
      remainingNominal: candidate.remainingNominal,
      plannedNominal,
    });
    remainingNominal -= plannedNominal;
  }

  return {
    dates,
    allocatedTotal: normalizedNominal - remainingNominal,
    pendingNominal: remainingNominal,
    lastDate: dates.length ? dates[dates.length - 1].tanggal_buat : normalizedStartDate,
  };
}

function findOutstandingMatchingDates(byDate, existingTransfers, nominal, tolerance) {
  const normalizedNominal = Number(nominal || 0);
  const candidates = annotateCandidates(buildDateCandidates(byDate), existingTransfers);

  return candidates
    .filter(c => c.remainingNominal > 0)
    .map(c => ({
      ...c,
      diff: Math.abs(c.remainingNominal - normalizedNominal),
      matchNominal: c.remainingNominal,
    }))
    .filter(c => c.diff <= tolerance)
    .sort((a, b) => a.diff - b.diff || a.tanggal_buat.localeCompare(b.tanggal_buat));
}

function findSplitMatchingDates(byDate, existingTransfers, nominal, tolerance = NONCOD_SPLIT_TOLERANCE) {
  const normalizedNominal = Number(nominal || 0);
  if (!(normalizedNominal > 0)) return null;

  const outstandingDates = getOutstandingCandidates(byDate, existingTransfers);
  for (let startIndex = 0; startIndex < outstandingDates.length; startIndex++) {
    let runningTotal = 0;
    const selectedDates = [];

    for (let currentIndex = startIndex; currentIndex < outstandingDates.length; currentIndex++) {
      const current = outstandingDates[currentIndex];
      selectedDates.push(current);
      runningTotal += Number(current.remainingNominal || 0);
      const previousTotal = runningTotal - Number(current.remainingNominal || 0);

      if (selectedDates.length > 1 && Math.abs(runningTotal - normalizedNominal) <= tolerance) {
        return {
          dates: allocateSplitPlannedNominals(selectedDates, normalizedNominal),
          total: runningTotal,
          transferTotal: normalizedNominal,
          diff: Math.abs(runningTotal - normalizedNominal),
          startDate: selectedDates[0].tanggal_buat,
          endDate: selectedDates[selectedDates.length - 1].tanggal_buat,
          leavesRemainderOnLastDate: false,
        };
      }

      if (selectedDates.length > 1 && previousTotal < normalizedNominal && runningTotal > normalizedNominal + tolerance) {
        return {
          dates: allocateSplitPlannedNominals(selectedDates, normalizedNominal),
          total: runningTotal,
          transferTotal: normalizedNominal,
          diff: Math.abs(runningTotal - normalizedNominal),
          startDate: selectedDates[0].tanggal_buat,
          endDate: selectedDates[selectedDates.length - 1].tanggal_buat,
          leavesRemainderOnLastDate: true,
        };
      }

      if (runningTotal > normalizedNominal + tolerance) break;
    }
  }

  return null;
}

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
    if (isExcludedNoncodStatus(row.status_terakhir)) continue;
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
  annotateCandidates(candidates, existingTransfers);
  const match = (candidates || []).find(c => c.remainingNominal > 0) || null;
  const allPaid = (candidates || []).length > 0 && candidates.every(c => c.remainingNominal <= 0);
  return { match, allPaid };
}

async function ensureFreshNoncod(supabase, periodes) {
  const { isSyncMetaStale, maybeSyncMaukirimPeriod, readSyncMeta } = getNoncodSyncModule();
  for (const periode of periodes) {
    try {
      const meta = await readSyncMeta(supabase, periode);
      if (isSyncMetaStale(meta)) {
        await maybeSyncMaukirimPeriod(supabase, periode, { force: true });
      }
    } catch (_) { /* sync failure is non-blocking */ }
  }
}

function prunePrefetchedContexts(now = Date.now()) {
  for (const [key, entry] of prefetchedContexts.entries()) {
    if (!entry || entry.expiresAt <= now) {
      prefetchedContexts.delete(key);
    }
  }
}

function buildPrefetchedContextKey() {
  prefetchedContextCounter += 1;
  return 'ncctx_' + Date.now().toString(36) + '_' + prefetchedContextCounter.toString(36);
}

function storePrefetchedContext(context) {
  prunePrefetchedContexts();
  const contextKey = buildPrefetchedContextKey();
  prefetchedContexts.set(contextKey, {
    expiresAt: Date.now() + PREFETCHED_CONTEXT_TTL_MS,
    context,
  });
  return contextKey;
}

function readPrefetchedContext(contextKey) {
  if (!contextKey) return null;
  prunePrefetchedContexts();
  const entry = prefetchedContexts.get(String(contextKey || '').trim());
  return entry ? entry.context : null;
}

function buildEmptyContext(normalizedCabang, preferredPeriode, message) {
  const normalizedPreferredPeriode = String(preferredPeriode || '').trim();
  return {
    normalizedCabang,
    normalizedPreferredPeriode,
    hasPreferredPeriode: PERIODE_RE.test(normalizedPreferredPeriode),
    searchByDate: {},
    existingTransfers: [],
    hasData: false,
    message,
  };
}

async function loadNoncodMatchContext(supabase, { namaCabang, preferredPeriode }) {
  const normalizedCabang = String(namaCabang || '').trim().toUpperCase();
  const normalizedPreferredPeriode = String(preferredPeriode || '').trim();
  const hasPreferredPeriode = PERIODE_RE.test(normalizedPreferredPeriode);

  if (!normalizedCabang) {
    return buildEmptyContext('', normalizedPreferredPeriode, 'Cabang wajib dipilih.');
  }

  const periodes = getRecentPeriodes();
  await ensureFreshNoncod(supabase, getPreferredSyncPeriodes(periodes, normalizedPreferredPeriode));

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
    return buildEmptyContext(
      normalizedCabang,
      normalizedPreferredPeriode,
      'Tidak ada data NONCOD untuk ' + normalizedCabang + (hasPreferredPeriode ? (' pada periode aktif ' + normalizedPreferredPeriode + '.') : '.'),
    );
  }

  const searchByDate = getSearchByDate(byDate, normalizedPreferredPeriode);
  if (hasPreferredPeriode && !Object.keys(searchByDate).length) {
    return buildEmptyContext(
      normalizedCabang,
      normalizedPreferredPeriode,
      'Tidak ada data NONCOD untuk ' + normalizedCabang + ' pada periode ' + normalizedPreferredPeriode + '.',
    );
  }

  const allCandidateDates = Object.keys(searchByDate);
  const { data: existingTransfers, error: trErr } = await supabase
    .from('transfers')
    .select('id, tgl_inputan, nominal, nama_bank, nama_cabang, timestamp')
    .eq('nama_cabang', normalizedCabang)
    .in('tgl_inputan', allCandidateDates);
  if (trErr) throw trErr;

  return {
    normalizedCabang,
    normalizedPreferredPeriode,
    hasPreferredPeriode,
    searchByDate,
    existingTransfers: existingTransfers || [],
    hasData: true,
    message: null,
  };
}

function resolveNoncodDateMatchFromContext(context, nominal) {
  const normalizedNominal = Number(nominal || 0);
  if (!context || !context.normalizedCabang) {
    return { match: null, candidates: [], message: 'Cabang wajib diisi.' };
  }
  if (normalizedNominal <= 0) {
    return { match: null, candidates: [], message: 'Nominal wajib diisi.' };
  }
  if (!context.hasData || !Object.keys(context.searchByDate || {}).length) {
    return {
      match: null,
      candidates: [],
      blocked: false,
      message: context.message,
    };
  }

  const outstandingCandidates = findOutstandingMatchingDates(
    context.searchByDate,
    context.existingTransfers,
    normalizedNominal,
    NONCOD_MATCH_TOLERANCE,
  );

  if (outstandingCandidates.length) {
    return {
      match: outstandingCandidates[0],
      candidates: outstandingCandidates,
      blocked: false,
      message: null,
    };
  }

  const splitMatch = findSplitMatchingDates(
    context.searchByDate,
    context.existingTransfers,
    normalizedNominal,
    NONCOD_SPLIT_TOLERANCE,
  );

  if (splitMatch && Array.isArray(splitMatch.dates) && splitMatch.dates.length > 1) {
    return {
      match: null,
      splitMatch,
      candidates: [],
      blocked: false,
      message: null,
    };
  }

  const candidates = findMatchingDates(context.searchByDate, normalizedNominal, NONCOD_MATCH_TOLERANCE);

  if (!candidates.length) {
    return {
      match: null,
      candidates: [],
      blocked: false,
      message: 'Nominal Rp ' + normalizedNominal.toLocaleString('id-ID') +
        ' tidak cocok dengan NONCOD ' + (context.hasPreferredPeriode ? ('periode ' + context.normalizedPreferredPeriode + ' ') : 'manapun ') + 'untuk ' + context.normalizedCabang +
        '. Toleransi maks Rp ' + NONCOD_MATCH_TOLERANCE.toLocaleString('id-ID') + '.',
    };
  }

  const { match, allPaid } = resolveMatch(candidates, context.existingTransfers);

  if (allPaid) {
    const first = candidates[0];
    return {
      match: null,
      candidates,
      blocked: true,
      message: 'Semua tanggal NONCOD yang cocok sudah memiliki bukti transfer. Indikasi pembayaran dobel.',
      existingTransfer: first && first.existingTransfers ? first.existingTransfers[0] || null : null,
    };
  }

  return { match, candidates, blocked: false, message: null };
}

async function prefetchNoncodMatchContext(supabase, { namaCabang, preferredPeriode }) {
  const context = await loadNoncodMatchContext(supabase, { namaCabang, preferredPeriode });
  return {
    contextKey: storePrefetchedContext(context),
    hasData: !!context.hasData,
    candidateDateCount: Object.keys(context.searchByDate || {}).length,
    message: context.message,
    cabang: context.normalizedCabang,
  };
}

async function findNoncodDateMatch(supabase, { namaCabang, nominal, preferredPeriode, contextKey }) {
  const normalizedCabang = String(namaCabang || '').trim().toUpperCase();
  const normalizedNominal = Number(nominal || 0);
  const normalizedPreferredPeriode = String(preferredPeriode || '').trim();
  if (!normalizedCabang || normalizedNominal <= 0) {
    return { match: null, candidates: [], message: 'Cabang dan nominal wajib diisi.' };
  }

  let context = readPrefetchedContext(contextKey);
  if (
    !context ||
    context.normalizedCabang !== normalizedCabang ||
    String(context.normalizedPreferredPeriode || '').trim() !== normalizedPreferredPeriode
  ) {
    context = await loadNoncodMatchContext(supabase, {
      namaCabang: normalizedCabang,
      preferredPeriode: normalizedPreferredPeriode,
    });
  }

  return resolveNoncodDateMatchFromContext(context, normalizedNominal);
}

module.exports = {
  NONCOD_MATCH_TOLERANCE,
  NONCOD_SPLIT_TOLERANCE,
  aggregateOngkirByDate,
  allocateSplitPlannedNominals,
  annotateCandidates,
  filterByPreferredPeriode,
  findMatchingDates,
  findOutstandingMatchingDates,
  findSequentialAllocationDates,
  findSplitMatchingDates,
  findNoncodDateMatch,
  getPreferredSyncPeriodes,
  getRecentPeriodes,
  getSearchByDate,
  getOutstandingCandidates,
  getOutstandingNominalForDate,
  groupTransfersByDate,
  loadNoncodMatchContext,
  prefetchNoncodMatchContext,
  resolveNoncodDateMatchFromContext,
  resolveMatch,
};
