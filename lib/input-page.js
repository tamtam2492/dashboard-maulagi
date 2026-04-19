// Init periode dropdown
const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Makassar' }));
const currentPeriode = now.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit' }).slice(0, 7);
const periodeEl = document.getElementById('periodeInput');
for (let i = 0; i < 3; i++) {
  const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
  const val = d.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit' }).slice(0, 7);
  const label = d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  const o = document.createElement('option');
  o.value = val;
  o.textContent = label;
  periodeEl.appendChild(o);
}

// Init tanggal default (today)
const BULAN_ID_FULL = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

function ensurePeriodeOption(periode) {
  if (!periode) return;
  const [year, month] = periode.split('-');
  if (!year || !month) return;
  const exists = Array.from(periodeEl.options).some(opt => opt.value === periode);
  if (exists) {
    periodeEl.value = periode;
    return;
  }
  const option = document.createElement('option');
  option.value = periode;
  option.textContent = BULAN_ID_FULL[parseInt(month, 10) - 1] + ' ' + year;
  periodeEl.insertBefore(option, periodeEl.firstChild);
  periodeEl.value = periode;
}

function syncPeriodeFromTglInput() {
  const tglInput = document.getElementById('tglInput').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tglInput)) return;
  ensurePeriodeOption(tglInput.slice(0, 7));
}

function resetPeriodePreference() {
  ensurePeriodeOption(currentPeriode);
  periodeEl.value = currentPeriode;
}

// tglInput sekarang otomatis dari NONCOD match — tidak ada date picker manual

// Format nominal — strip non-numeric, add thousand separator
function formatNominal(el) {
  let raw = el.value.replace(/[^\d]/g, '');
  if (raw) {
    el.value = Number(raw).toLocaleString('id-ID');
  }
}

// Parse nominal — strip separator to get raw number
function parseNominal() {
  return parseInt(document.getElementById('nominal').value.replace(/[^\d]/g, '')) || 0;
}

// Load cabang dari API
// Cabang data store
let cabangData = []; // [{nama, area}]
let cabangSummaryTimer = null;
let lastSummaryKey = '';
let lastSummaryRequestId = 0;
let lastCabangContextRequestId = 0;
let lastDupeContext = null;
let detailStageUnlocked = false;
let cabangSummaryAbortController = null;
let cabangContextAbortController = null;
const inputAsyncState = {
  uploadRevision: 0,
  ocrStatus: 'idle',
  cabangHoldStatus: 'idle',
  cabangHoldKey: '',
  noncodContextKey: '',
  cabangHoldHasData: false,
  cabangHoldMessage: '',
};

function setOcrFlowStatus(status) {
  inputAsyncState.ocrStatus = status;
}

function hasReadyOcrResult() {
  return inputAsyncState.ocrStatus === 'success' &&
    parseNominal() > 0 &&
    document.getElementById('namaBank').value.trim();
}

function setCabangHoldState(status, options = {}) {
  inputAsyncState.cabangHoldStatus = status;
  inputAsyncState.cabangHoldKey = Object.prototype.hasOwnProperty.call(options, 'holdKey')
    ? options.holdKey
    : inputAsyncState.cabangHoldKey;
  inputAsyncState.noncodContextKey = options.contextKey || '';
  inputAsyncState.cabangHoldHasData = !!options.hasData;
  inputAsyncState.cabangHoldMessage = options.message || '';
}

function resetCabangHoldState() {
  if (cabangContextAbortController) {
    cabangContextAbortController.abort();
    cabangContextAbortController = null;
  }
  lastCabangContextRequestId = 0;
  setCabangHoldState('idle', {
    holdKey: '',
    contextKey: '',
    hasData: false,
    message: '',
  });
}

function getCabangHoldKey() {
  const selectedCabang = getSelectedCabangRecord();
  if (!selectedCabang) return '';
  const vals = getFormValues();
  return [selectedCabang.nama, vals.periode].join('|');
}

function hasReadyCabangHold() {
  return inputAsyncState.cabangHoldStatus === 'ready' && !!inputAsyncState.cabangHoldKey;
}

function canResolveNoncodMatch() {
  return hasSelectedCabang() && hasReadyCabangHold() && hasReadyOcrResult();
}

async function loadCabang() {
  try {
    const res = await fetch('/api/cabang');
    const json = await res.json();
    const areaOrder = ['SULTRA', 'MKS OUTER', 'CUSTUMER', 'LAINNYA'];

    const groups = {};
    (json.cabang || []).forEach(c => {
      const area = c.area || 'LAINNYA';
      if (!groups[area]) groups[area] = [];
      groups[area].push(c);
    });

    const sorted = Object.keys(groups).sort((a, b) => {
      const ia = areaOrder.indexOf(a);
      const ib = areaOrder.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    cabangData = [];
    sorted.forEach(area => {
      groups[area].forEach(c => cabangData.push({ nama: c.nama, area }));
    });

    renderCabangList('');
  } catch {
    cabangData = [];
    document.getElementById('cabangList').innerHTML = '<div class="dd-empty">Gagal memuat cabang</div>';
  }
}

function renderCabangList(query) {
  const list = document.getElementById('cabangList');
  const q = query.toLowerCase();
  const filtered = q ? cabangData.filter(c => c.nama.toLowerCase().includes(q)) : cabangData;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="dd-empty">Tidak ditemukan</div>';
    return;
  }

  let html = '';
  let lastArea = '';
  filtered.forEach(c => {
    if (c.area !== lastArea) {
      lastArea = c.area;
      html += '<div class="dd-group">' + lastArea + '</div>';
    }
    html += '<div class="dd-item" data-value="' + c.nama.replace(/"/g, '&quot;') + '">' +
      '<div class="dd-name">' + c.nama + '</div>' +
      '<div class="dd-meta">Area ' + c.area + '</div>' +
      '</div>';
  });
  list.innerHTML = html;
}

function getSelectedCabangRecord() {
  const selectedName = document.getElementById('namaCabang').value;
  return cabangData.find(c => c.nama === selectedName) || null;
}

function setCabangSummaryView({ tone, badge, meta, dateValue, ongkirValue, diffValue, note }) {
  const card = document.getElementById('cabangSummaryCard');
  card.dataset.tone = tone;
  document.getElementById('cabangSummaryBadge').textContent = badge;
  document.getElementById('cabangSummaryMeta').textContent = meta;
  document.getElementById('cabangDateValue').textContent = dateValue || '-';
  document.getElementById('cabangOngkirValue').textContent = ongkirValue || '-';
  document.getElementById('cabangDiffValue').textContent = diffValue || '-';
  document.getElementById('cabangSummaryNote').textContent = note;
}

function renderCabangSummary(context) {
  const card = document.getElementById('cabangSummaryCard');
  const selectedCabang = getSelectedCabangRecord();
  const vals = getFormValues();

  if (!selectedCabang) {
    card.classList.remove('show');
    return;
  }

  card.classList.add('show');
  document.getElementById('cabangSummaryName').textContent = selectedCabang.nama;
  document.getElementById('cabangAreaValue').textContent = selectedCabang.area || '-';

  const scopeLabel = selectedCabang.area ? 'Area ' + selectedCabang.area : 'Cabang ini';

  if (!context) {
    if (inputAsyncState.cabangHoldStatus === 'loading') {
      setCabangSummaryView({
        tone: 'pending',
        badge: 'Menyiapkan NONCOD',
        meta: selectedCabang.nama + ' · Menarik konteks cabang',
        dateValue: '...',
        ongkirValue: '...',
        diffValue: '...',
        note: hasReadyOcrResult()
          ? 'Hasil OCR sudah siap. Sistem sedang menyiapkan data NONCOD cabang sebelum mencocokkan hasil akhirnya.'
          : 'Cabang sedang menyiapkan konteks NONCOD. OCR bisa berjalan paralel dan hasil akhir akan keluar saat dua-duanya siap.',
      });
    } else if (inputAsyncState.cabangHoldStatus === 'failed') {
      setCabangSummaryView({
        tone: 'warn',
        badge: 'Gagal Ambil NONCOD',
        meta: selectedCabang.nama,
        dateValue: '-',
        ongkirValue: '-',
        diffValue: '-',
        note: inputAsyncState.cabangHoldMessage || 'Data NONCOD cabang belum berhasil dimuat. Pilih ulang cabang atau coba lagi.',
      });
    } else if (hasReadyCabangHold() && !inputAsyncState.cabangHoldHasData) {
      setCabangSummaryView({
        tone: 'info',
        badge: 'Context Kosong',
        meta: selectedCabang.nama,
        dateValue: '-',
        ongkirValue: '-',
        diffValue: '-',
        note: inputAsyncState.cabangHoldMessage || 'Cabang sudah siap, tetapi belum ada data NONCOD yang bisa dipakai untuk pencocokan.',
      });
    } else if (hasReadyCabangHold() && inputAsyncState.ocrStatus === 'processing') {
      setCabangSummaryView({
        tone: 'pending',
        badge: 'NONCOD Siap',
        meta: selectedCabang.nama + ' · Konteks cabang sudah siap',
        dateValue: '...',
        ongkirValue: '...',
        diffValue: '...',
        note: 'Konteks NONCOD untuk cabang ini sudah siap. Sistem tinggal menunggu OCR selesai untuk mencocokkan hasil akhirnya.',
      });
    } else if (inputAsyncState.ocrStatus === 'failed') {
      setCabangSummaryView({
        tone: 'warn',
        badge: 'OCR Gagal',
        meta: selectedCabang.nama,
        dateValue: '-',
        ongkirValue: '-',
        diffValue: '-',
        note: hasReadyCabangHold()
          ? 'Konteks cabang sudah siap, tetapi OCR belum menghasilkan data valid. Upload ulang bukti transfer untuk melanjutkan pencocokan.'
          : 'OCR belum menghasilkan data yang valid. Upload ulang bukti transfer untuk melanjutkan pencocokan.',
      });
    } else if (inputAsyncState.ocrStatus === 'partial' || vals.nominal <= 0) {
      setCabangSummaryView({
        tone: 'pending',
        badge: hasReadyCabangHold() ? 'NONCOD Siap' : 'Menunggu hasil OCR',
        meta: selectedCabang.nama,
        dateValue: '-',
        ongkirValue: '-',
        diffValue: '-',
        note: hasReadyCabangHold()
          ? 'Konteks NONCOD cabang sudah siap. Sistem menunggu OCR lengkap untuk menjalankan pencocokan akhir.'
          : 'Sistem menahan pilihan cabang ini sampai hasil OCR lengkap, lalu pencocokan NONCOD dijalankan otomatis.',
      });
    } else if (hasReadyCabangHold() && !hasReadyOcrResult()) {
      setCabangSummaryView({
        tone: 'pending',
        badge: 'Cabang Siap',
        meta: selectedCabang.nama,
        dateValue: '-',
        ongkirValue: '-',
        diffValue: '-',
        note: 'Konteks NONCOD cabang sudah siap. Upload bukti atau tunggu OCR selesai agar hasil akhir bisa keluar.',
      });
    } else {
      setCabangSummaryView({
        tone: 'pending',
        badge: 'Mencocokkan...',
        meta: selectedCabang.nama + ' · Nominal ' + fmtNom(vals.nominal),
        dateValue: '...',
        ongkirValue: '...',
        diffValue: '...',
        note: 'Sedang mencocokkan nominal transfer dengan data NONCOD...',
      });
    }
    return;
  }

  const nc = context.noncodMatch;

  if (!nc) {
    setCabangSummaryView({
      tone: 'info',
      badge: 'Info',
      meta: selectedCabang.nama,
      dateValue: '-',
      ongkirValue: '-',
      diffValue: '-',
      note: 'Data NONCOD belum tersedia.',
    });
    return;
  }

  if (nc.hold && nc.match) {
    const hasDupes = context.dupes && context.dupes.length > 0;
    const tone = hasDupes ? 'warn' : 'ok';
    const badge = hasDupes ? 'Cocok + Hold, Ada Serupa' : 'Cocok + Hold Cabang';
    const allocatedNominal = Number(nc.match.plannedNominal || nc.match.remainingNominal || vals.nominal || 0);
    const note = hasDupes
      ? 'Bagian exact akan ditempel ke NONCOD tgl ' + fmtTgl(nc.match.tanggal_buat) + ', tetapi ada transfer serupa pada tanggal target. Sisa ' + fmtNom(nc.hold.nominal) + ' akan ditahan sebagai hold cabang.'
      : 'Bagian exact ' + fmtNom(allocatedNominal) + ' akan ditempel ke NONCOD tgl ' + fmtTgl(nc.match.tanggal_buat) + '. Sisa ' + fmtNom(nc.hold.nominal) + ' akan disimpan sebagai hold cabang.';
    setCabangSummaryView({
      tone,
      badge,
      meta: scopeLabel + ' · Nominal ' + fmtNom(vals.nominal),
      dateValue: fmtTgl(nc.match.tanggal_buat),
      ongkirValue: fmtNom(allocatedNominal),
      diffValue: 'Hold ' + fmtNom(nc.hold.nominal),
      note,
    });
  } else if (nc.hold && nc.splitMatch && Array.isArray(nc.splitMatch.dates) && nc.splitMatch.dates.length > 1) {
    const hasDupes = context.dupes && context.dupes.length > 0;
    const tone = hasDupes ? 'warn' : 'ok';
    const badge = hasDupes ? 'Split + Hold, Ada Serupa' : 'Split + Hold Cabang';
    const firstDate = nc.splitMatch.startDate || nc.splitMatch.dates[0].tanggal_buat;
    const lastDate = nc.splitMatch.endDate || nc.splitMatch.dates[nc.splitMatch.dates.length - 1].tanggal_buat;
    const note = hasDupes
      ? 'Bagian exact akan dibagi ke ' + nc.splitMatch.dates.length + ' tanggal NONCOD, tetapi ada transfer serupa pada salah satu tanggal target. Sisa ' + fmtNom(nc.hold.nominal) + ' akan ditahan sebagai hold cabang.'
      : 'Bagian exact ' + fmtNom(nc.splitMatch.total) + ' akan dibagi otomatis ke ' + nc.splitMatch.dates.length + ' tanggal NONCOD (' + formatSplitDateList(nc.splitMatch.dates) + '). Sisa ' + fmtNom(nc.hold.nominal) + ' akan disimpan sebagai hold cabang.';
    setCabangSummaryView({
      tone,
      badge,
      meta: scopeLabel + ' · Nominal ' + fmtNom(vals.nominal),
      dateValue: fmtTgl(firstDate) + ' - ' + fmtTgl(lastDate),
      ongkirValue: fmtNom(nc.splitMatch.total),
      diffValue: 'Hold ' + fmtNom(nc.hold.nominal),
      note,
    });
  } else if (nc.match) {
    const hasDupes = context.dupes && context.dupes.length > 0;
    const tone = hasDupes ? 'warn' : 'ok';
    const badge = hasDupes ? 'Cocok, Ada Serupa' : 'Cocok NONCOD';
    const note = hasDupes
      ? 'Cocok NONCOD tgl ' + fmtTgl(nc.match.tanggal_buat) + ', tapi ada transfer serupa (area/tanggal/nominal sama) yang sudah tersimpan. Cek ulang.'
      : 'Cocok dengan NONCOD tgl ' + fmtTgl(nc.match.tanggal_buat) + '. Belum ada bukti transfer untuk tanggal ini. Aman disimpan.';
    setCabangSummaryView({
      tone,
      badge,
      meta: scopeLabel + ' · Nominal ' + fmtNom(vals.nominal),
      dateValue: fmtTgl(nc.match.tanggal_buat),
      ongkirValue: fmtNom(nc.match.totalOngkir),
      diffValue: nc.match.diff === 0 ? 'Rp 0 (persis)' : fmtNom(nc.match.diff),
      note,
    });
  } else if (nc.splitMatch && Array.isArray(nc.splitMatch.dates) && nc.splitMatch.dates.length > 1) {
    const hasDupes = context.dupes && context.dupes.length > 0;
    const tone = hasDupes ? 'warn' : 'ok';
    const badge = hasDupes ? 'Cocok Multi, Ada Serupa' : 'Cocok Multi Tgl';
    const firstDate = nc.splitMatch.startDate || nc.splitMatch.dates[0].tanggal_buat;
    const lastDate = nc.splitMatch.endDate || nc.splitMatch.dates[nc.splitMatch.dates.length - 1].tanggal_buat;
    const note = hasDupes
      ? 'Cocok gabungan ' + nc.splitMatch.dates.length + ' tanggal NONCOD, tetapi ada transfer serupa pada salah satu tanggal target. Cek ulang.'
      : 'Cocok gabungan ' + nc.splitMatch.dates.length + ' tanggal NONCOD dengan selisih Rp 0. Sistem akan simpan otomatis per tanggal: ' + formatSplitDateList(nc.splitMatch.dates) + '.';
    setCabangSummaryView({
      tone,
      badge,
      meta: scopeLabel + ' · Nominal ' + fmtNom(vals.nominal),
      dateValue: fmtTgl(firstDate) + ' - ' + fmtTgl(lastDate),
      ongkirValue: fmtNom(nc.splitMatch.total),
      diffValue: nc.splitMatch.diff === 0 ? 'Rp 0 (persis)' : fmtNom(nc.splitMatch.diff),
      note,
    });
  } else if (nc.blocked) {
    const firstCand = nc.candidates && nc.candidates[0];
    setCabangSummaryView({
      tone: 'warn',
      badge: 'Indikasi Dobel',
      meta: scopeLabel + ' · Nominal ' + fmtNom(vals.nominal),
      dateValue: firstCand ? fmtTgl(firstCand.tanggal_buat) : '-',
      ongkirValue: firstCand ? fmtNom(firstCand.totalOngkir) : '-',
      diffValue: '-',
      note: nc.message || 'Semua tanggal NONCOD yang cocok sudah memiliki bukti transfer.',
    });
  } else {
    setCabangSummaryView({
      tone: 'info',
      badge: 'Tidak Cocok',
      meta: scopeLabel + ' · Nominal ' + fmtNom(vals.nominal),
      dateValue: '-',
      ongkirValue: '-',
      diffValue: '-',
      note: nc.message || 'Tidak ada data NONCOD yang cocok untuk nominal ini.',
    });
  }
}

function resetCabangSummaryRequestState() {
  clearTimeout(cabangSummaryTimer);
  if (cabangSummaryAbortController) {
    cabangSummaryAbortController.abort();
    cabangSummaryAbortController = null;
  }
  lastSummaryKey = '';
  lastSummaryRequestId = 0;
  lastDupeContext = null;
  document.getElementById('tglInput').value = '';
}

function resetCabangSummary() {
  resetCabangSummaryRequestState();
  document.getElementById('cabangSummaryCard').classList.remove('show');
}

async function prefetchCabangContext(force = false) {
  const selectedCabang = getSelectedCabangRecord();
  if (!selectedCabang) {
    resetCabangHoldState();
    return { ok: false, reason: 'missing_cabang' };
  }

  const vals = getFormValues();
  const holdKey = getCabangHoldKey();

  if (!force && hasReadyCabangHold() && inputAsyncState.cabangHoldKey === holdKey) {
    return { ok: true, reason: 'cached' };
  }

  if (!force && inputAsyncState.cabangHoldStatus === 'loading' && inputAsyncState.cabangHoldKey === holdKey) {
    return { ok: false, reason: 'loading' };
  }

  setCabangHoldState('loading', {
    holdKey,
    contextKey: '',
    hasData: false,
    message: '',
  });

  const requestId = ++lastCabangContextRequestId;
  if (cabangContextAbortController) cabangContextAbortController.abort();
  cabangContextAbortController = new AbortController();

  try {
    const { res, json } = await fetchJsonWithTimeout('/api/input?dupe=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nama_cabang: vals.nama_cabang,
        periode: vals.periode,
        prefetch: true,
      }),
    }, 15000, cabangContextAbortController);

    if (requestId !== lastCabangContextRequestId) return { ok: false, reason: 'stale' };
    if (!res.ok) throw new Error(json.error || 'Gagal menyiapkan konteks NONCOD.');

    setCabangHoldState('ready', {
      holdKey,
      contextKey: json.contextKey || '',
      hasData: !!json.hasData,
      message: json.message || '',
    });
    return { ok: true, reason: 'ready' };
  } catch (err) {
    if (requestId !== lastCabangContextRequestId) return { ok: false, reason: 'stale' };
    const message = err && err.name === 'AbortError'
      ? 'Menyiapkan data NONCOD terlalu lama. Coba pilih ulang cabang.'
      : 'Gagal menyiapkan data NONCOD untuk cabang ini. Coba lagi.';
    setCabangHoldState('failed', {
      holdKey,
      contextKey: '',
      hasData: false,
      message,
    });
    return { ok: false, reason: 'error' };
  } finally {
    if (cabangContextAbortController && requestId === lastCabangContextRequestId) {
      cabangContextAbortController = null;
    }
  }
}

async function beginCabangSyncFlow() {
  resetCabangSummaryRequestState();
  resetPeriodePreference();
  detailStageUnlocked = true;
  renderCabangSummary(null);
  updateCabangStepState();

  const prefetched = await prefetchCabangContext(true);
  renderCabangSummary(null);
  checkReady();
  if (prefetched.ok && hasReadyOcrResult()) {
    refreshCabangSummary(true);
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000, existingController = null) {
  const controller = existingController || new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const json = await res.json();
    return { res, json };
  } finally {
    clearTimeout(timeoutId);
  }
}

function scheduleCabangSummaryRefresh() {
  clearTimeout(cabangSummaryTimer);
  cabangSummaryTimer = setTimeout(() => {
    refreshCabangSummary();
  }, 350);
}

async function refreshCabangSummary(force = false) {
  const vals = getFormValues();
  const selectedCabang = getSelectedCabangRecord();
  const holdKey = getCabangHoldKey();

  if (!selectedCabang) {
    resetCabangHoldState();
    resetCabangSummary();
    detailStageUnlocked = false;
    updateCabangStepState();
    return;
  }

  detailStageUnlocked = true;
  updateCabangStepState();

  if (
    force ||
    inputAsyncState.cabangHoldKey !== holdKey ||
    inputAsyncState.cabangHoldStatus === 'idle' ||
    inputAsyncState.cabangHoldStatus === 'failed'
  ) {
    const prefetched = await prefetchCabangContext(force);
    renderCabangSummary(null);
    checkReady();
    if (!prefetched.ok) {
      return;
    }
  }

  if (!canResolveNoncodMatch()) {
    resetCabangSummaryRequestState();
    renderCabangSummary(null);
    checkReady();
    return;
  }

  const summaryKey = [inputAsyncState.uploadRevision, vals.nama_cabang, vals.nominal, vals.periode, inputAsyncState.noncodContextKey].join('|');
  if (!force && summaryKey === lastSummaryKey && lastDupeContext) {
    renderCabangSummary(lastDupeContext);
    checkReady();
    return;
  }

  lastSummaryKey = summaryKey;
  lastDupeContext = null;
  document.getElementById('tglInput').value = '';
  renderCabangSummary(null);
  const requestId = ++lastSummaryRequestId;
  if (cabangSummaryAbortController) cabangSummaryAbortController.abort();
  cabangSummaryAbortController = new AbortController();

  try {
    const { res, json } = await fetchJsonWithTimeout('/api/input?dupe=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nama_cabang: vals.nama_cabang,
        periode: vals.periode,
        nominal: vals.nominal,
        context_key: inputAsyncState.noncodContextKey,
      }),
    }, 15000, cabangSummaryAbortController);
    if (requestId !== lastSummaryRequestId) return;
    if (!res.ok) throw new Error(json.error || 'Gagal cek.');
    lastDupeContext = json;

    const primaryDate = getPrimaryNoncodDate(json.noncodMatch);
    if (primaryDate) {
      document.getElementById('tglInput').value = primaryDate;
      syncPeriodeFromTglInput();
    } else {
      document.getElementById('tglInput').value = '';
    }

    renderCabangSummary(lastDupeContext);
    checkReady();
  } catch (err) {
    if (requestId !== lastSummaryRequestId) return;
    const message = err && err.name === 'AbortError'
      ? 'Pencocokan NONCOD terlalu lama. Coba pilih ulang cabang atau tunggu OCR selesai.'
      : 'Gagal mencocokkan data NONCOD. Coba lagi.';
    lastDupeContext = {
      noncodMatch: { match: null, message },
    };
    document.getElementById('tglInput').value = '';
    renderCabangSummary(lastDupeContext);
    checkReady();
  } finally {
    if (cabangSummaryAbortController && requestId === lastSummaryRequestId) {
      cabangSummaryAbortController = null;
    }
  }
}

// Search dropdown behavior
(function() {
  const dd = document.getElementById('cabangDD');
  const input = document.getElementById('cabangSearch');
  const hidden = document.getElementById('namaCabang');
  const list = document.getElementById('cabangList');

  input.addEventListener('focus', () => {
    dd.classList.add('open');
    renderCabangList(input.value);
  });
  input.addEventListener('input', () => {
    dd.classList.add('open');
    hidden.value = ''; // clear selection when typing
    detailStageUnlocked = false;
    resetCabangHoldState();
    lastDupeContext = null;
    lastSummaryKey = '';
    renderCabangList(input.value);
    resetCabangSummary();
    checkReady();
  });

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.dd-item');
    if (!item) return;
    const val = item.dataset.value;
    input.value = val;
    hidden.value = val;
    dd.classList.remove('open');
    checkReady();
    beginCabangSyncFlow();
  });

  // Close on click outside
  document.addEventListener('click', (e) => {
    if (!dd.contains(e.target)) dd.classList.remove('open');
  });

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.dd-item');
    const active = list.querySelector('.dd-item.active');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!active) {
        items[0]?.classList.add('active');
      } else {
        active.classList.remove('active');
        (active.nextElementSibling?.classList.contains('dd-item') ? active.nextElementSibling : active.nextElementSibling?.nextElementSibling)?.classList.add('active');
      }
      list.querySelector('.dd-item.active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (active) {
        active.classList.remove('active');
        let prev = active.previousElementSibling;
        if (prev && !prev.classList.contains('dd-item')) prev = prev.previousElementSibling;
        prev?.classList.add('active');
        prev?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) {
        input.value = active.dataset.value;
        hidden.value = active.dataset.value;
        dd.classList.remove('open');
        checkReady();
        beginCabangSyncFlow();
      }
    } else if (e.key === 'Escape') {
      dd.classList.remove('open');
    }
  });
})();

loadCabang();
initInputEventBindings();

// Drag-and-drop on upload area
(function() {
  const ua = document.getElementById('uploadArea');
  ua.addEventListener('dragover', function(e) {
    e.preventDefault();
    ua.classList.add('dragover');
  });
  ua.addEventListener('dragleave', function(e) {
    if (!ua.contains(e.relatedTarget)) ua.classList.remove('dragover');
  });
  ua.addEventListener('drop', function(e) {
    e.preventDefault();
    ua.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      const inp = document.getElementById('fileBukti');
      const dt = new DataTransfer();
      dt.items.add(file);
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change'));
    }
  });
})();

// File preview + OCR auto-scan
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const inputOcrModule = window.InputOcrModule;
let ocrController = null;

if (!inputOcrModule) {
  throw new Error('Input OCR module gagal dimuat.');
}

function readProofFileAsDataUrl(file) {
  if (inputOcrModule && typeof inputOcrModule.readFileAsDataUrl === 'function') {
    return inputOcrModule.readFileAsDataUrl(file);
  }

  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const result = String(event && event.target && event.target.result || '');
        if (!result) {
          reject(new Error('Gagal membaca file.'));
          return;
        }
        resolve(result);
      };
      reader.onerror = () => reject(new Error('Gagal membaca file.'));
      reader.readAsDataURL(file);
    });
  }

  return Promise.reject(new Error('Browser ini belum mendukung pembacaan file untuk preview OCR.'));
}

// Compress image to reduce base64 size for OCR API
function compressImage(dataUrl, maxWidth = 800) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      if (w > maxWidth) {
        h = Math.round(h * maxWidth / w);
        w = maxWidth;
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    img.src = dataUrl;
  });
}

function setOcrStatus(type, text) {
  if (type === 'scanning') {
    setOcrFlowStatus('processing');
  } else if (type === 'success') {
    setOcrFlowStatus('success');
  } else if (type === 'info') {
    setOcrFlowStatus('partial');
  } else {
    setOcrFlowStatus('failed');
  }

  const el = document.getElementById('ocrStatus');
  el.className = 'ocr-status ' + type;
  if (type === 'scanning') {
    el.innerHTML = '<span class="spinner-border"></span>' + text;
  } else if (type === 'success') {
    el.innerHTML = '<i class="bi bi-check-circle-fill"></i>' + text;
  } else if (type === 'info') {
    el.innerHTML = '<i class="bi bi-info-circle-fill"></i>' + text;
  } else {
    el.innerHTML = '<i class="bi bi-x-circle-fill"></i>' + text;
  }

  if (hasSelectedCabang()) scheduleCabangSummaryRefresh();
  checkReady();
}

function showFields() {
  document.getElementById('formFields').classList.add('show');
  updateCabangStepState();
}

function setBadge(badgeId, show) {
  const badge = document.getElementById(badgeId);
  if (badge) badge.style.display = show ? 'inline-flex' : 'none';
}

function prepareProofAsyncFlow() {
  inputAsyncState.uploadRevision += 1;
  setOcrFlowStatus('processing');
  if (ocrController) ocrController.resetState();
  document.getElementById('namaBank').value = '';
  document.getElementById('nominal').value = '';
  document.getElementById('tglInput').value = '';
  setBadge('bankBadge', false);
  setBadge('nominalBadge', false);
  resetPeriodePreference();
  resetCabangSummaryRequestState();
  if (hasSelectedCabang()) renderCabangSummary(null);
  checkReady();
}

document.getElementById('fileBukti').addEventListener('change', async function() {
  const file = this.files[0];
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) {
    alert('File terlalu besar. Maksimal 5MB.');
    this.value = '';
    checkReady();
    return;
  }

  prepareProofAsyncFlow();

  try {
    const dataUrl = await readProofFileAsDataUrl(file);
    const img = document.getElementById('previewImg');
    const placeholder = document.getElementById('uploadPlaceholder');
    img.src = dataUrl;
    img.style.display = 'block';
    placeholder.style.display = 'none';
    document.getElementById('uploadArea').classList.add('has-preview');
    document.getElementById('previewChangeHint').style.display = 'block';
    showFields();
    await runOCR(dataUrl, { force: true });
  } catch (err) {
    showFields();
    setOcrStatus('error', err && err.message ? err.message : 'Gagal membaca file untuk preview OCR.');
  }
  checkReady();
});

function normalizeBankNameInput(value) {
  return inputOcrModule.normalizeBankNameInput(value);
}

function normalizeBankInputField() {
  const input = document.getElementById('namaBank');
  const normalized = normalizeBankNameInput(input.value);
  if (normalized) input.value = normalized;
}

function initInputEventBindings() {
  const bankInput = document.getElementById('namaBank');
  if (bankInput) {
    bankInput.addEventListener('input', () => {
      checkReady();
      scheduleCabangSummaryRefresh();
    });
    bankInput.addEventListener('blur', () => {
      normalizeBankInputField();
      checkReady();
      scheduleCabangSummaryRefresh();
    });
  }

  const nominalInput = document.getElementById('nominal');
  if (nominalInput) {
    nominalInput.addEventListener('input', event => {
      formatNominal(event.currentTarget);
      checkReady();
      scheduleCabangSummaryRefresh();
    });
  }

  const submitBtn = document.getElementById('btnSubmit');
  if (submitBtn) submitBtn.addEventListener('click', submitForm);

  const closeDupeBtn = document.getElementById('btnCloseDupe');
  if (closeDupeBtn) closeDupeBtn.addEventListener('click', closeDupe);

  const forceSubmitBtn = document.getElementById('btnForceSubmit');
  if (forceSubmitBtn) forceSubmitBtn.addEventListener('click', forceSubmit);

  const resetBtn = document.getElementById('btnResetForm');
  if (resetBtn) resetBtn.addEventListener('click', resetForm);
}

// Map OCR channel to bank name
function matchBank(channel) {
  return inputOcrModule.matchBank(channel);
}

async function runOCR(base64DataUrl, options) {
  if (!ocrController) return;
  await ocrController.runOCR(base64DataUrl, options);
}

function setInputStep(n) {
  document.querySelectorAll('#inputSteps .is-step').forEach(s => {
    const sn = parseInt(s.dataset.s);
    s.classList.toggle('is-done', sn < n);
    s.classList.toggle('is-active', sn === n);
  });
  ['isConn1', 'isConn2', 'isConn3'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('is-filled', i + 1 < n);
  });
}

function checkReady() {
  updateCabangStepState();
  const ok = hasReadyOcrResult() &&
    parseNominal() > 0 &&
    document.getElementById('tglInput').value &&
    document.getElementById('namaCabang').value &&
    document.getElementById('fileBukti').files.length > 0;
  document.getElementById('btnSubmit').disabled = !ok;
  if (ok) setInputStep(4);
}

ocrController = inputOcrModule.createInputOcrController({
  compressImage,
  fetchImpl: window.fetch.bind(window),
  setStatus: setOcrStatus,
  showFields,
  setBadge,
  setBankValue(value) {
    document.getElementById('namaBank').value = value;
  },
  setNominalValue(value) {
    document.getElementById('nominal').value = Number(value).toLocaleString('id-ID');
    if (hasSelectedCabang()) scheduleCabangSummaryRefresh();
  },
  onReadyChange: checkReady,
  log: console.error.bind(console),
});

// Collect form values helper
function getFormValues() {
  const matchedDate = document.getElementById('tglInput').value;
  const preferredPeriode = /^\d{4}-\d{2}-\d{2}$/.test(matchedDate)
    ? (document.getElementById('periodeInput').value || matchedDate.slice(0, 7))
    : currentPeriode;
  return {
    periode: preferredPeriode,
    tgl_inputan: document.getElementById('tglInput').value,
    nama_bank: normalizeBankNameInput(document.getElementById('namaBank').value),
    nama_cabang: document.getElementById('namaCabang').value,
    nominal: parseNominal(),
  };
}

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function fmtTgl(dateStr) {
  if (!dateStr) return '-';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function fmtNom(v) {
  return 'Rp ' + Number(v).toLocaleString('id-ID');
}

function getPrimaryNoncodDate(nc) {
  if (nc && nc.match && nc.match.tanggal_buat) return nc.match.tanggal_buat;
  if (nc && nc.splitMatch && Array.isArray(nc.splitMatch.dates) && nc.splitMatch.dates.length > 0) {
    return nc.splitMatch.dates[0].tanggal_buat;
  }
  return '';
}

function formatSplitDateList(dates, limit = 4) {
  const safeDates = Array.isArray(dates) ? dates : [];
  if (!safeDates.length) return '-';
  const labels = safeDates.slice(0, limit).map(item => fmtTgl(item.tanggal_buat || item.date || ''));
  const moreCount = safeDates.length - labels.length;
  return moreCount > 0 ? labels.join(', ') + ' +' + moreCount + ' tgl' : labels.join(', ');
}

function formatSavedDateSummary(rows, limit = 4) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return '-';
  const labels = safeRows.slice(0, limit).map(item => fmtTgl(item.tgl_inputan || item.tanggal_buat || ''));
  const moreCount = safeRows.length - labels.length;
  return moreCount > 0 ? labels.join(', ') + ' +' + moreCount + ' tgl' : labels.join(', ');
}

function fmtJam(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' });
}

function fmtTglFromTs(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Makassar' });
}

function hasSelectedCabang() {
  return !!document.getElementById('namaCabang').value;
}

function updateCabangStepState() {
  const formVisible = document.getElementById('formFields').classList.contains('show');
  const hasBukti = document.getElementById('fileBukti').files.length > 0;
  const cabangSelected = hasSelectedCabang();
  const hasMatchedDate = !!document.getElementById('tglInput').value;
  const cabangInput = document.getElementById('cabangSearch');
  const detailFields = document.getElementById('detailAfterCabang');
  const cabangStageNote = document.getElementById('cabangStageNote');
  const cabangStageNoteText = document.getElementById('cabangStageNoteText');
  const submitBtn = document.getElementById('btnSubmit');

  cabangInput.disabled = false;
  cabangInput.placeholder = 'Cari cabang...';

  detailFields.classList.toggle('show', formVisible && hasBukti && detailStageUnlocked);

  if (!formVisible) {
    cabangStageNote.style.display = 'none';
  } else if (!hasBukti && !cabangSelected) {
    cabangStageNote.style.display = 'flex';
    cabangStageNoteText.textContent = 'Pilih cabang atau upload bukti dulu. Sistem akan menahan bagian yang sudah siap sampai dua-duanya lengkap.';
  } else if (!hasBukti && cabangSelected) {
    cabangStageNote.style.display = 'flex';
    if (inputAsyncState.cabangHoldStatus === 'loading') {
      cabangStageNoteText.textContent = 'Cabang sudah tersimpan. Sistem sedang menyiapkan konteks NONCOD, dan Anda bisa lanjut upload bukti kapan saja.';
    } else if (inputAsyncState.cabangHoldStatus === 'failed') {
      cabangStageNoteText.textContent = 'Cabang sudah dipilih, tetapi konteks NONCOD belum berhasil dimuat. Coba pilih ulang cabang atau lanjut upload bukti setelah retry.';
    } else if (hasReadyCabangHold()) {
      cabangStageNoteText.textContent = 'Konteks NONCOD cabang sudah siap. Upload bukti untuk menjalankan OCR dan menyelesaikan pencocokan.';
    } else {
      cabangStageNoteText.textContent = 'Cabang sudah dipilih. Sistem akan menyiapkan konteks NONCOD sambil menunggu bukti transfer.';
    }
  } else if (!cabangSelected) {
    cabangStageNote.style.display = 'flex';
    cabangStageNoteText.textContent = 'Pilih cabang dulu. Sistem akan menyiapkan konteks NONCOD sambil OCR berjalan.';
  } else if (inputAsyncState.cabangHoldStatus === 'loading') {
    cabangStageNote.style.display = 'flex';
    cabangStageNoteText.textContent = hasReadyOcrResult()
      ? 'Hasil OCR sudah siap. Sistem sedang menyiapkan data NONCOD cabang sebelum mengeluarkan hasil akhir.'
      : 'Cabang sudah tersimpan. Sistem sedang menyiapkan data NONCOD, OCR tetap bisa berjalan paralel.';
  } else if (inputAsyncState.cabangHoldStatus === 'failed') {
    cabangStageNote.style.display = 'flex';
    cabangStageNoteText.textContent = 'Gagal menyiapkan data NONCOD untuk cabang ini. Coba pilih ulang cabang.';
  } else if (inputAsyncState.ocrStatus === 'processing') {
    cabangStageNote.style.display = 'flex';
    cabangStageNoteText.textContent = hasReadyCabangHold()
      ? 'Konteks NONCOD cabang sudah siap. OCR sedang membaca bukti, lalu hasil akhirnya akan keluar otomatis.'
      : 'OCR sedang membaca bukti. Sistem akan melanjutkan pencocokan setelah konteks cabang siap.';
  } else if (inputAsyncState.ocrStatus === 'failed' || inputAsyncState.ocrStatus === 'partial') {
    cabangStageNote.style.display = 'flex';
    cabangStageNoteText.textContent = hasReadyCabangHold()
      ? 'Konteks cabang sudah siap, tetapi hasil OCR belum lengkap. Upload ulang bukti agar pencocokan bisa dilanjutkan.'
      : 'Hasil OCR belum lengkap. Upload ulang bukti agar sistem bisa lanjut mencocokkan dengan NONCOD.';
  } else if (!lastDupeContext) {
    cabangStageNote.style.display = 'flex';
    cabangStageNoteText.textContent = 'Sedang mencocokkan dengan data NONCOD...';
  } else if (!hasMatchedDate) {
    cabangStageNote.style.display = 'flex';
    cabangStageNoteText.textContent = 'Belum ada data NONCOD yang cocok untuk kombinasi bukti dan cabang ini.';
  } else {
    cabangStageNote.style.display = 'none';
  }

  submitBtn.style.display = formVisible && hasBukti && detailStageUnlocked ? '' : 'none';

  if (!cabangSelected) {
    detailStageUnlocked = false;
    resetCabangHoldState();
    resetCabangSummary();
  }

  // Update step indicator
  if (!hasBukti && !cabangSelected) setInputStep(1);
  else if (!hasBukti || !cabangSelected) setInputStep(2);
  else if (!detailStageUnlocked) setInputStep(3);
  // step 4 set by checkReady() when form fully valid
}

function closeDupe() {
  document.getElementById('dupeOverlay').classList.remove('show');
  const btn = document.getElementById('btnSubmit');
  btn.innerHTML = '<i class="bi bi-send-fill me-2"></i>Kirim Data';
  btn.disabled = false;
}

function forceSubmit() {
  document.getElementById('dupeOverlay').classList.remove('show');
  doSubmit();
}

async function submitForm() {
  const btn = document.getElementById('btnSubmit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Mengecek NONCOD...';

  const vals = getFormValues();

  try {
    const selectedCabang = getSelectedCabangRecord();
    const { res: chkRes, json: chkJson } = await fetchJsonWithTimeout('/api/input?dupe=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nama_cabang: vals.nama_cabang,
        periode: vals.periode,
        nominal: vals.nominal,
        context_key: inputAsyncState.noncodContextKey,
      }),
    }, 15000);

    lastDupeContext = chkJson;
    renderCabangSummary(lastDupeContext);

    const nc = chkJson.noncodMatch;
    if (!nc || (!nc.match && !nc.splitMatch)) {
      const msg = nc ? nc.message : 'Tidak ada NONCOD yang cocok untuk nominal ini.';
      alert(msg);
      btn.innerHTML = '<i class="bi bi-send-fill me-2"></i>Kirim Data';
      btn.disabled = false;
      return;
    }

    const primaryDate = getPrimaryNoncodDate(nc);
    if (primaryDate) {
      document.getElementById('tglInput').value = primaryDate;
      syncPeriodeFromTglInput();
    }

    if (chkRes.ok && chkJson.dupes && chkJson.dupes.length > 0) {
      const d = chkJson.dupes[0];
      const detail = document.getElementById('dupeDetail');
      const scopeTitle = selectedCabang && selectedCabang.area ? 'Area ' + selectedCabang.area : vals.nama_cabang;
      detail.innerHTML =
        `<div class="dupe-cabang">${esc(scopeTitle)}</div>` +
        `<span class="lbl">Cabang Tersimpan</span> : ${esc(d.nama_cabang || vals.nama_cabang)}<br>` +
        `<span class="lbl">Tgl NONCOD</span> : ${fmtTgl(d.tgl_inputan)}<br>` +
        `<span class="lbl">Jam</span> : ${fmtJam(d.timestamp)}<br>` +
        `<span class="lbl">Bank Tersimpan</span> : ${esc(d.nama_bank || '-')}<br>` +
        `<span class="lbl">Nominal</span> : ${fmtNom(d.nominal)}`;
      document.getElementById('dupeOverlay').classList.add('show');
      return;
    }
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? 'Pencocokan NONCOD terlalu lama. Coba pilih ulang cabang atau tunggu OCR selesai.'
      : 'Gagal mencocokkan data NONCOD. Pastikan koneksi stabil.';
    alert(message);
    btn.innerHTML = '<i class="bi bi-send-fill me-2"></i>Kirim Data';
    btn.disabled = false;
    return;
  }

  doSubmit();
}

async function doSubmit() {
  const btn = document.getElementById('btnSubmit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Mengirim...';
  try {
    const vals = getFormValues();
    const fd = new FormData();
    fd.append('periode', vals.periode);
    fd.append('tgl_inputan', vals.tgl_inputan);
    fd.append('nama_bank', vals.nama_bank);
    fd.append('nama_cabang', vals.nama_cabang);
    fd.append('nominal', vals.nominal);
    fd.append('bukti', document.getElementById('fileBukti').files[0]);

    const res = await fetch('/api/input', { method: 'POST', body: fd });
    const json = await res.json();

    if (!res.ok) {
      alert(json.error || 'Gagal mengirim data. Coba lagi.');
      btn.innerHTML = '<i class="bi bi-send-fill me-2"></i>Kirim Data';
      btn.disabled = false;
      return;
    }

    const allocatedNominal = (Array.isArray(json.rows) ? json.rows : []).reduce((sum, row) => sum + Number(row.nominal || 0), 0);
    const holdNominal = Number(json.holdNominal || 0);
    const successText = holdNominal > 0
      ? 'Transfer ' + esc(vals.nama_cabang) + ' senilai ' + fmtNom(vals.nominal) + ' sudah diproses. Bagian exact ' + fmtNom(allocatedNominal) + ' masuk ke bucket NONCOD' + (json.inserted > 1 ? ' (' + esc(formatSavedDateSummary(json.rows)) + ')' : '') + ', dan sisa ' + fmtNom(holdNominal) + ' disimpan sebagai hold cabang.<br>Silakan lanjut input berikutnya bila ada.'
      : json.inserted > 1
        ? 'Transfer ' + esc(vals.nama_cabang) + ' senilai ' + fmtNom(vals.nominal) + ' sudah masuk ke ' + json.inserted + ' tanggal NONCOD (' + esc(formatSavedDateSummary(json.rows)) + ').<br>Silakan lanjut input berikutnya bila ada.'
        : 'Transfer ' + esc(vals.nama_cabang) + ' senilai ' + fmtNom(vals.nominal) + ' sudah masuk.<br>Silakan lanjut input berikutnya bila ada.';
    document.getElementById('successMessage').innerHTML = successText;
    document.getElementById('formWrap').style.display = 'none';
    document.getElementById('successScreen').style.display = 'flex';
  } catch {
    alert('Terjadi kesalahan jaringan. Pastikan koneksi Anda stabil.');
    btn.innerHTML = '<i class="bi bi-send-fill me-2"></i>Kirim Data';
    btn.disabled = false;
  }
}

function resetForm() {
  detailStageUnlocked = false;
  inputAsyncState.uploadRevision += 1;
  setOcrFlowStatus('idle');
  document.getElementById('formWrap').style.display = 'flex';
  document.getElementById('successScreen').style.display = 'none';
  document.getElementById('successMessage').innerHTML = 'Data transfer Anda sudah masuk.<br>Terima kasih!';
  document.getElementById('nominal').value = '';
  document.getElementById('namaBank').value = '';
  document.getElementById('tglInput').value = '';
  document.getElementById('namaCabang').value = '';
  document.getElementById('cabangSearch').value = '';
  document.getElementById('cabangDD').classList.remove('open');
  document.getElementById('fileBukti').value = '';
  document.getElementById('previewImg').style.display = 'none';
  document.getElementById('previewChangeHint').style.display = 'none';
  document.getElementById('uploadArea').classList.remove('has-preview');
  document.getElementById('uploadPlaceholder').style.display = 'block';
  document.getElementById('btnSubmit').innerHTML = '<i class="bi bi-send-fill me-2"></i>Kirim Data';
  document.getElementById('ocrStatus').className = 'ocr-status';
  document.getElementById('formFields').classList.add('show');
  document.getElementById('btnSubmit').style.display = 'none';
  setBadge('bankBadge', false);
  setBadge('nominalBadge', false);
  if (ocrController) ocrController.resetState();
  periodeEl.selectedIndex = 0;
  resetCabangSummary();
  checkReady();
}

checkReady();
