const EMBED_MODE = new URLSearchParams(location.search).get('embed') === '1' || window.self !== window.top;
      if (EMBED_MODE) document.body.classList.add('embed');

      let cabangData = [];
      let manualStatusRows = [];
      let manualStatusEditingResi = '';
      let manualStatusSearchTimer = null;
      let monitorDataCache = null;
      let auditCabangState = null;
      let auditSelectedCabang = '';
      let adminCarryUploadContext = null;
      const ADMIN_CARRY_MAX_FILE_SIZE = 5 * 1024 * 1024;
      const ADMIN_MANUAL_STATUS_LIMIT = 1000;
      const ADMIN_BOOT_DEFAULT_TEXT = 'Menyiapkan snapshot admin...';
      const ADMIN_MARKER_WATCH_MS = 10000;
      const adminCarryOcrModule = window.InputOcrModule || null;
      let adminCarryOcrController = null;
      let adminCarryCabangFetchPromise = null;
      let manualStatusSnapshotRows = [];
      let manualStatusSnapshotLoaded = false;
      let cabangSnapshotLoaded = false;
      let cabangAutoSyncDone = false;
      let activeTransferPeriode = '';
      const transferSnapshotsByPeriode = new Map();
      const adminUiState = {
        bootReady: false,
        bootPromise: null,
        monitorPromises: new Map(),
        transferPromises: new Map(),
        cabangPromise: null,
        manualStatusPromise: null,
        markerWatchId: 0,
        markerWatchBusy: false,
        markerToken: '',
      };

      function notifyParentAdminEmbed(status) {
        if (!EMBED_MODE || !window.parent || window.parent === window) return;
        try {
          window.parent.postMessage({
            type: 'maulagi_admin_embed_status',
            status: String(status || '').trim().toLowerCase() || 'unknown',
          }, location.origin);
        } catch {}
      }

      function setAdminBootLoading(show, text = ADMIN_BOOT_DEFAULT_TEXT) {
        const overlay = document.getElementById('adminBootOverlay');
        const label = document.getElementById('adminBootText');
        if (label) label.textContent = text || ADMIN_BOOT_DEFAULT_TEXT;
        if (overlay) overlay.classList.toggle('hidden', !show);
        document.body.classList.toggle('admin-loading', !!show);
      }

      function warmAdminSupportSnapshots() {
        const tasks = [];
        if (!cabangSnapshotLoaded && !adminUiState.cabangPromise) {
          tasks.push(fetchCabangSnapshot({ forceRefresh: true }));
        }
        if (!manualStatusSnapshotLoaded && !adminUiState.manualStatusPromise) {
          tasks.push(fetchManualStatusSnapshot({ forceRefresh: true }));
        }
        if (!tasks.length) return;
        Promise.allSettled(tasks).catch(() => {});
      }

      function getRecentAdminPeriodes() {
        const now = new Date();
        const periodes = [];
        for (let i = 0; i < 3; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          periodes.push(d.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit' }).slice(0, 7));
        }
        return periodes;
      }

      function buildTransferSnapshot(periode, json) {
        const transfers = (Array.isArray(json && json.transfers) ? json.transfers : []).slice().sort((a, b) => {
          const da = normTgl(a.tgl_inputan);
          const db = normTgl(b.tgl_inputan);
          return db.localeCompare(da);
        });
        const lookup = {};
        transfers.forEach((item) => {
          if (item && item.id) lookup[String(item.id)] = item;
        });
        return {
          periode,
          total: Number(json && json.total) || 0,
          transaksi: Number(json && json.transaksi) || transfers.length,
          cabang: Number(json && json.cabang) || new Set(transfers.map((item) => item.nama_cabang)).size,
          transfers,
          lookup,
          duplicateIds: [...buildDuplicateTransferSet(transfers)],
        };
      }

      function cacheTransferSnapshot(periode, json) {
        const normalizedPeriode = String(periode || '').trim();
        if (!normalizedPeriode) return null;
        const snapshot = buildTransferSnapshot(normalizedPeriode, json || {});
        transferSnapshotsByPeriode.set(normalizedPeriode, snapshot);
        return snapshot;
      }

      function getTransferSnapshot(periode) {
        return transferSnapshotsByPeriode.get(String(periode || '').trim()) || null;
      }

      function applyTransferSnapshot(snapshot, options = {}) {
        const listEl = document.getElementById('trList');
        const sumEl = document.getElementById('trSummary');
        const filterBar = document.getElementById('trFilters');
        const resetFilters = !!options.resetFilters;

        if (!snapshot) {
          listEl.innerHTML = '<div class="empty-state"><i class="bi bi-calendar3"></i>Pilih periode untuk melihat data</div>';
          sumEl.style.display = 'none';
          filterBar.style.display = 'none';
          allTransfers = [];
          transferLookupById = {};
          duplicateTransferIds = new Set();
          activeTransferPeriode = '';
          return;
        }

        activeTransferPeriode = snapshot.periode;
        allTransfers = snapshot.transfers.slice();
        transferLookupById = { ...snapshot.lookup };
        duplicateTransferIds = new Set(snapshot.duplicateIds || []);

        sumEl.style.display = 'grid';
        filterBar.style.display = allTransfers.length > 0 ? 'flex' : 'none';

        const totalValue = Number(snapshot.total || 0);
        const totalStr = totalValue >= 1000000
          ? 'Rp ' + (totalValue / 1000000).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' jt'
          : 'Rp ' + totalValue.toLocaleString('id-ID');
        document.getElementById('trTotal').textContent = totalStr;
        document.getElementById('trTranaksi').textContent = snapshot.transaksi;
        document.getElementById('trCabang').textContent = snapshot.cabang;

        if (resetFilters) {
          document.getElementById('trSearchCabang').value = '';
          document.getElementById('trSearchTgl').value = '';
          document.getElementById('trClearFilter').classList.remove('active');
        }

        if (!allTransfers.length) {
          listEl.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i>Belum ada data periode ini</div>';
          return;
        }

        const hasFilter = document.getElementById('trSearchCabang').value.trim() || document.getElementById('trSearchTgl').value;
        if (hasFilter) applyTrFilter();
        else renderTransferList(allTransfers);
      }

      async function fetchTransferSnapshot(periode, options = {}) {
        const normalizedPeriode = String(periode || '').trim();
        const forceRefresh = !!options.forceRefresh;
        if (!normalizedPeriode) throw new Error('Periode transfer tidak valid.');

        if (!forceRefresh) {
          const cachedSnapshot = getTransferSnapshot(normalizedPeriode);
          if (cachedSnapshot) return cachedSnapshot;
        }

        if (adminUiState.transferPromises.has(normalizedPeriode)) {
          return adminUiState.transferPromises.get(normalizedPeriode);
        }

        const pending = (async () => {
          const { response: res, json } = await fetchJsonWithTimeout('/api/transfer?periode=' + encodeURIComponent(normalizedPeriode), {
            headers: { 'X-Admin-Token': getOpsToken() },
            requestLabel: 'Snapshot transfer admin ' + normalizedPeriode,
          });
          if (!res.ok) throw new Error(json.error || 'Gagal memuat transfer');
          return cacheTransferSnapshot(normalizedPeriode, json);
        })().finally(() => {
          adminUiState.transferPromises.delete(normalizedPeriode);
        });

        adminUiState.transferPromises.set(normalizedPeriode, pending);
        return pending;
      }

      async function fetchMonitorSnapshot(periode, options = {}) {
        const normalizedPeriode = String(periode || '').trim();
        const forceRefresh = !!options.forceRefresh;
        if (!normalizedPeriode) throw new Error('Periode monitor tidak valid.');

        if (!forceRefresh && monitorDataCache && monitorDataCache.periode === normalizedPeriode) {
          return monitorDataCache;
        }

        if (adminUiState.monitorPromises.has(normalizedPeriode)) {
          return adminUiState.monitorPromises.get(normalizedPeriode);
        }

        const pending = (async () => {
          const [{ response: ncRes, json: ncData }, { response: trRes, json: trData }, { response: pendingRes, json: pendingData }] = await Promise.all([
            fetchJsonWithTimeout('/api/noncod?periode=' + encodeURIComponent(normalizedPeriode) + '&mode=noncod', {
              requestLabel: 'Snapshot monitor NONCOD ' + normalizedPeriode,
            }),
            fetchJsonWithTimeout('/api/transfer?periode=' + encodeURIComponent(normalizedPeriode), {
              headers: { 'X-Admin-Token': getOpsToken() },
              requestLabel: 'Snapshot monitor transfer ' + normalizedPeriode,
            }),
            fetchJsonWithTimeout('/api/transfer?pending_allocation=1&periode=' + encodeURIComponent(normalizedPeriode), {
              headers: { 'X-Admin-Token': getOpsToken() },
              requestLabel: 'Snapshot pending alokasi ' + normalizedPeriode,
            })
          ]);

          if (!ncRes.ok) throw new Error(ncData.error || 'Gagal memuat NONCOD');
          if (!trRes.ok) throw new Error(trData.error || 'Gagal memuat transfer');
          if (!pendingRes.ok) throw new Error(pendingData.error || 'Gagal memuat pending tempel NONCOD');

          monitorDataCache = {
            periode: normalizedPeriode,
            ncData,
            trData,
            pendingData,
            updatedAt: new Date().toISOString(),
          };
          cacheTransferSnapshot(normalizedPeriode, trData);
          return monitorDataCache;
        })().finally(() => {
          adminUiState.monitorPromises.delete(normalizedPeriode);
        });

        adminUiState.monitorPromises.set(normalizedPeriode, pending);
        return pending;
      }

      async function fetchCabangSnapshot(options = {}) {
        const forceRefresh = !!options.forceRefresh;
        if (!forceRefresh && cabangSnapshotLoaded) return cabangData;
        if (adminUiState.cabangPromise) return adminUiState.cabangPromise;

        adminUiState.cabangPromise = (async () => {
          const { response: res, json } = await fetchJsonWithTimeout('/api/cabang', {
            requestLabel: 'Snapshot cabang admin',
          });
          if (!res.ok) throw new Error(json.error || 'Gagal memuat daftar cabang');
          cabangData = Array.isArray(json.cabang) ? json.cabang : [];
          cabangSnapshotLoaded = true;
          return cabangData;
        })().finally(() => {
          adminUiState.cabangPromise = null;
        });

        return adminUiState.cabangPromise;
      }

      async function fetchManualStatusSnapshot(options = {}) {
        const forceRefresh = !!options.forceRefresh;
        if (!forceRefresh && manualStatusSnapshotLoaded) return manualStatusSnapshotRows;
        if (adminUiState.manualStatusPromise) return adminUiState.manualStatusPromise;

        adminUiState.manualStatusPromise = (async () => {
          const url = '/api/noncod-status?limit=' + ADMIN_MANUAL_STATUS_LIMIT;
          const { response: res, json } = await fetchJsonWithTimeout(url, {
            headers: { 'X-Admin-Token': getOpsToken() },
            requestLabel: 'Snapshot status manual admin',
          });
          if (!res.ok) throw new Error(json.error || 'Gagal memuat status manual');
          manualStatusSnapshotRows = Array.isArray(json.rows) ? json.rows : [];
          manualStatusSnapshotLoaded = true;
          manualStatusRows = manualStatusSnapshotRows.slice();
          return manualStatusSnapshotRows;
        })().finally(() => {
          adminUiState.manualStatusPromise = null;
        });

        return adminUiState.manualStatusPromise;
      }

      function applyManualStatusSnapshot(query = getManualStatusQuery()) {
        const normalizedQuery = String(query || '').trim().toUpperCase();
        manualStatusRows = normalizedQuery
          ? manualStatusSnapshotRows.filter((row) => String(row.nomor_resi || '').includes(normalizedQuery))
          : manualStatusSnapshotRows.slice();

        const countEl = document.getElementById('manualStatusCount');
        if (countEl) {
          countEl.textContent = normalizedQuery
            ? (manualStatusRows.length + ' hasil pencarian')
            : (manualStatusRows.length ? (manualStatusRows.length + ' resi override manual') : 'Belum ada override manual');
        }
      }

      async function ensureAdminBootstrap() {
        if (adminUiState.bootReady) return;
        if (adminUiState.bootPromise) return adminUiState.bootPromise;

        const currentPeriode = getMonitorPeriode();
        setAdminBootLoading(true, ADMIN_BOOT_DEFAULT_TEXT);

        adminUiState.bootPromise = (async () => {
          const monitorSnapshot = await fetchMonitorSnapshot(currentPeriode, { forceRefresh: true });
          renderMismatchMonitorSnapshot(monitorSnapshot);

          adminUiState.bootReady = true;
          notifyParentAdminEmbed('ready');
          if (!EMBED_MODE) {
            pollAdminWriteMarker({ initialize: true }).catch(() => {});
            startAdminMarkerWatchLoop();
          }
          warmAdminSupportSnapshots();
        })().catch((err) => {
          notifyParentAdminEmbed('error');
          const contentEl = document.getElementById('mismatchContent');
          const sumEl = document.getElementById('mismatchSummary');
          document.getElementById('mismatchDateLabel').textContent = 'Gagal memuat snapshot admin';
          contentEl.innerHTML = '<div class="empty-state" style="padding:16px 0"><i class="bi bi-exclamation-circle text-danger me-1"></i>' + escHtmlAdmin(err.message || 'Gagal menyiapkan snapshot admin') + '</div>';
          sumEl.style.display = 'none';
          throw err;
        }).finally(() => {
          setAdminBootLoading(false, ADMIN_BOOT_DEFAULT_TEXT);
          adminUiState.bootPromise = null;
        });

        return adminUiState.bootPromise;
      }

      function normalizeAdminMarkerScopes(marker) {
        const scopes = Array.isArray(marker && marker.scopes) ? marker.scopes : [];
        return [...new Set(scopes.map(scope => String(scope || '').trim().toLowerCase()).filter(Boolean))];
      }

      function normalizeAdminMarkerPeriodes(marker) {
        const periodes = Array.isArray(marker && marker.periodes) ? marker.periodes : [];
        return [...new Set(periodes.map(periode => String(periode || '').trim()).filter(Boolean))];
      }

      function adminMarkerHasScope(marker, scopeList) {
        const markerScopes = normalizeAdminMarkerScopes(marker);
        const expected = new Set((Array.isArray(scopeList) ? scopeList : [scopeList]).map(scope => String(scope || '').trim().toLowerCase()).filter(Boolean));
        if (!markerScopes.length || !expected.size) return false;
        return markerScopes.some(scope => expected.has(scope));
      }

      function adminMarkerTouchesPeriode(marker, periode) {
        const periodes = normalizeAdminMarkerPeriodes(marker);
        if (!periodes.length) return true;
        return periodes.includes(String(periode || '').trim());
      }

      async function refreshAdminSnapshotViews(options = {}) {
        const silent = options.silent !== false;
        const marker = options.marker || null;
        const currentPeriode = getMonitorPeriode();
        const refreshMonitor = !marker || (adminMarkerHasScope(marker, ['admin_monitor']) && adminMarkerTouchesPeriode(marker, currentPeriode));
        const refreshAudit = !marker || (adminMarkerHasScope(marker, ['audit', 'admin_cabang']) && adminMarkerTouchesPeriode(marker, currentPeriode));
        const transferPeriode = activeTransferPeriode || currentPeriode;
        const refreshTransfer = !marker || (adminMarkerHasScope(marker, ['transfer']) && adminMarkerTouchesPeriode(marker, transferPeriode));
        const refreshCabang = !marker || adminMarkerHasScope(marker, ['admin_cabang']);
        const refreshManualStatus = !marker || adminMarkerHasScope(marker, ['manual_status']);

        if (!refreshMonitor && !refreshAudit && !refreshTransfer && !refreshCabang && !refreshManualStatus) {
          return;
        }

        if (refreshMonitor) {
          await loadMismatchMonitor({ forceRefresh: true, silent });
        }

        const auditModal = document.getElementById('modalAuditCabang');
        if (refreshAudit && auditModal && auditModal.classList.contains('show')) {
          await loadAuditCabangModal(true, { silent });
        }

        const transferModal = document.getElementById('modalTransfer');
        const splitOverlay = document.getElementById('splitOverlay');
        const transferEditing = document.querySelector('.tr-edit-bar');
        if (
          refreshTransfer
          &&
          transferModal && transferModal.classList.contains('show')
          && !transferEditing
          && !(splitOverlay && splitOverlay.classList.contains('show'))
        ) {
          await loadTransfers({ forceRefresh: true, silent, resetFilters: false });
        }

        const cabangModal = document.getElementById('modalCabang');
        if (refreshCabang && cabangModal && cabangModal.classList.contains('show')) {
          await loadCabangModal({ forceRefresh: true, silent: true });
        }

        const manualStatusModal = document.getElementById('modalManualStatus');
        if (refreshManualStatus && manualStatusModal && manualStatusModal.classList.contains('show') && !manualStatusEditingResi) {
          await loadManualStatusModal({ forceRefresh: true, silent: true });
        }
      }

      async function fetchAdminWriteMarker() {
        const res = await fetch('/api/dashboard?watch=1');
        if (!res.ok) throw new Error('Gagal memuat marker admin.');
        const json = await res.json();
        return json && json.marker ? json.marker : null;
      }

      async function pollAdminWriteMarker(options = {}) {
        if (EMBED_MODE || !adminUiState.bootReady || document.hidden || adminUiState.markerWatchBusy) return;

        adminUiState.markerWatchBusy = true;
        try {
          const marker = await fetchAdminWriteMarker();
          const nextToken = String(marker && marker.token || '').trim();
          if (!nextToken) return;

          const previousToken = adminUiState.markerToken;
          adminUiState.markerToken = nextToken;
          if (options.initialize) return;
          if (previousToken === nextToken) return;

          await refreshAdminSnapshotViews({ silent: true, marker });
        } finally {
          adminUiState.markerWatchBusy = false;
        }
      }

      function startAdminMarkerWatchLoop() {
        if (EMBED_MODE || adminUiState.markerWatchId) return;
        adminUiState.markerWatchId = window.setInterval(() => {
          pollAdminWriteMarker().catch(() => {});
        }, ADMIN_MARKER_WATCH_MS);
      }

      async function requestParentWorkspaceRefresh(options = {}) {
        if (!EMBED_MODE || !window.parent || window.parent === window) return false;
        try {
          const refreshFn = window.parent.requestWorkspaceRefresh;
          if (typeof refreshFn !== 'function') return false;
          await refreshFn.call(window.parent, {
            source: String(options.source || 'embedded_admin').trim() || 'embedded_admin',
            spinOverview: false,
            includeOverview: true,
            includeAudit: true,
            includeFrames: true,
          });
          return true;
        } catch {
          return false;
        }
      }

      async function refreshAdminViewsAfterWrite(options = {}) {
        if (await requestParentWorkspaceRefresh(options)) return;
        await refreshAdminSnapshotViews({ silent: true });
      }

      window.workspaceRefreshFromParent = async function(options = {}) {
        await refreshAdminSnapshotViews({ silent: true, marker: options.marker || null });
      };

      document.addEventListener('visibilitychange', () => {
        if (!EMBED_MODE && !document.hidden) {
          pollAdminWriteMarker().catch(() => {});
        }
      });

      function hasActiveSession(prefix) {
        const ts = parseInt(sessionStorage.getItem(prefix + 'AuthTs') || '0');
        return !!sessionStorage.getItem(prefix + 'Auth') && ts && (Date.now() - ts <= 60 * 60 * 1000);
      }

      function getOpsToken() {
        return sessionStorage.getItem('adminToken') || '';
      }

      function getSessionPrefix() {
        return hasActiveSession('admin') ? 'admin' : '';
      }

      function clearSession(prefix) {
        if (!prefix) return;
        sessionStorage.removeItem(prefix + 'Auth');
        sessionStorage.removeItem(prefix + 'AuthTs');
        sessionStorage.removeItem(prefix + 'Token');
      }

      function clearAllSessions() {
        clearSession('dash');
        clearSession('admin');
      }

      async function invalidateServerSession() {
        try {
          await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            keepalive: true,
            body: JSON.stringify({ action: 'logout' })
          });
        } catch {}
      }

      function refreshAuditCabangIfOpen(options = {}) {
        const modal = document.getElementById('modalAuditCabang');
        if (modal && modal.classList.contains('show')) {
          loadAuditCabangModal(!!options.forceRefresh, { silent: options.silent !== false });
        }
      }

      async function exitWorkspace() {
        clearAllSessions();
        await invalidateServerSession();
        try {
          if (window.top && window.top !== window.self) {
            window.top.location.replace('/');
            return;
          }
        } catch {}
        location.replace('/');
      }

      // ── Modal helpers ──
      function openModal(id) {
        document.getElementById(id).classList.add('show');
        document.body.style.overflow = 'hidden';
      }
      function closeModal(id) {
        document.getElementById(id).classList.remove('show');
        document.body.style.overflow = '';
      }
      function handleModalOverlay(e, id) {
        if (e.target === document.getElementById(id)) closeModal(id);
      }

      async function handleAdminDelegatedClick(event) {
        if (event.target.matches('.modal-overlay')) {
          closeModal(event.target.id);
          return;
        }
        if (event.target.id === 'proofOverlay') {
          handleProofOverlay(event);
          return;
        }
        if (event.target.id === 'logOverlay') {
          closeLogs();
          return;
        }

        const actionEl = event.target.closest('[data-admin-click]');
        if (!actionEl) return;

        const action = actionEl.dataset.adminClick;
        switch (action) {
          case 'exit-workspace':
            event.preventDefault();
            exitWorkspace();
            break;
          case 'open-logs':
            event.preventDefault();
            openLogs();
            break;
          case 'open-settings-gate':
            event.preventDefault();
            openSettingsGate();
            break;
          case 'open-cabang-modal':
            openModal('modalCabang');
            loadCabangModal();
            break;
          case 'open-audit-cabang-modal':
            openAuditCabangModal();
            break;
          case 'open-manual-status-modal':
            openManualStatusModal();
            break;
          case 'open-transfer-modal':
            openTransferModal();
            break;
          case 'open-admin-carry-upload-modal':
            openAdminCarryUploadModal();
            break;
          case 'refresh-mismatch':
            if (await requestParentWorkspaceRefresh({ source: 'admin_refresh_mismatch' })) break;
            loadMismatchMonitor({ forceRefresh: true });
            break;
          case 'close-modal':
            closeModal(actionEl.dataset.modalId || '');
            break;
          case 'add-cabang':
            addCabang();
            break;
          case 'render-cabang-list':
            renderCabangList();
            break;
          case 'refresh-audit-cabang':
            if (await requestParentWorkspaceRefresh({ source: 'admin_refresh_audit' })) break;
            loadAuditCabangModal(true);
            break;
          case 'clear-tr-filter':
            clearTrFilter();
            break;
          case 'submit-admin-carry-upload':
            submitAdminCarryUpload();
            break;
          case 'submit-admin-verify':
            submitAdminVerify();
            break;
          case 'buat-password':
            buatPassword();
            break;
          case 'ganti-password':
            gantiPassword();
            break;
          case 'buat-dash-password':
            buatDashPassword();
            break;
          case 'ganti-dash-password':
            gantiDashPassword();
            break;
          case 'close-split':
            closeSplit();
            break;
          case 'add-rincian-row':
            addRincianRow();
            break;
          case 'do-split':
            doSplit();
            break;
          case 'rotate-proof':
            rotateProof();
            break;
          case 'close-proof':
            closeProof();
            break;
          case 'save-edit-cabang':
            saveEditCabang(Number(actionEl.dataset.cabangId || 0));
            break;
          case 'edit-cabang':
            startEditCabang(Number(actionEl.dataset.cabangId || 0));
            break;
          case 'delete-cabang':
            deleteCabang(Number(actionEl.dataset.cabangId || 0), decodeURIComponent(actionEl.dataset.cabangName || ''));
            break;
          case 'select-audit-cabang':
            selectAuditCabang(actionEl.dataset.cabang || '');
            break;
          case 'open-proof': {
            event.preventDefault();
            const href = actionEl.getAttribute('href') || '';
            if (openProof(href)) {
              window.open(href, '_blank', 'noopener');
            }
            break;
          }
          case 'select-admin-carry-cabang':
            selectAdminCarryCabang(actionEl.dataset.cabang || '');
            break;
          case 'save-manual-status':
            saveManualStatus(actionEl.dataset.resi || '');
            break;
          case 'cancel-manual-status-edit':
            cancelManualStatusEdit();
            break;
          case 'edit-manual-status':
            startEditManualStatus(actionEl.dataset.resi || '');
            break;
          case 'clear-manual-status':
            clearManualStatus(actionEl.dataset.resi || '');
            break;
          case 'edit-transfer':
            startEditTrById(actionEl.dataset.transferId || '');
            break;
          case 'split-transfer':
            openSplitById(actionEl.dataset.transferId || '');
            break;
          case 'delete-transfer':
            deleteTransferById(actionEl.dataset.transferId || '');
            break;
          case 'save-edit-transfer':
            saveEditTr(actionEl.dataset.transferId || '');
            break;
          case 'cancel-edit-transfer':
            cancelEditTr(actionEl.dataset.transferId || '');
            break;
          case 'delete-rincian-row':
            delRincianRow(actionEl);
            break;
          case 'open-transfer-review':
            openTransferReview(
              actionEl.dataset.periode || '',
              actionEl.dataset.cabang || '',
              actionEl.dataset.filterDate || '',
              actionEl.dataset.transferId || '',
              actionEl.dataset.reviewAction || ''
            );
            break;
          case 'clear-pending-allocation':
            clearPendingAllocation(actionEl.dataset.transferId || '');
            break;
          case 'open-admin-carry-upload-from-case':
            openAdminCarryUploadFromCase(
              actionEl.dataset.cabang || '',
              actionEl.dataset.date || '',
              Number(actionEl.dataset.nominal || 0)
            );
            break;
          case 'download-logs':
            downloadLogs();
            break;
          case 'clear-logs':
            clearLogs();
            break;
          case 'close-logs':
            closeLogs();
            break;
        }
      }

      function handleAdminDelegatedInput(event) {
        const action = event.target.dataset.adminInput;
        switch (action) {
          case 'toggle-add-btn':
            toggleAddBtn();
            break;
          case 'render-cabang-list':
            renderCabangList();
            break;
          case 'schedule-manual-status-search':
            scheduleManualStatusSearch();
            break;
          case 'render-audit-cabang-list':
            renderAuditCabangList();
            break;
          case 'apply-tr-filter':
            applyTrFilter();
            break;
          case 'clear-admin-verify-error':
            clearAdminVerifyError();
            break;
          case 'check-pw-buat':
            checkPwBuat();
            break;
          case 'check-pw-ganti':
            checkPwGanti();
            break;
          case 'check-dash-pw-buat':
            checkDashPwBuat();
            break;
          case 'check-dash-pw-ganti':
            checkDashPwGanti();
            break;
          case 'update-sisa':
            updateSisa();
            break;
        }
      }

      function handleAdminDelegatedChange(event) {
        const action = event.target.dataset.adminChange;
        if (action === 'load-transfers') {
          loadTransfers();
        }
      }

      function handleAdminDelegatedKeydown(event) {
        if (event.key !== 'Enter') return;
        const action = event.target.dataset.adminEnter;
        if (!action) return;
        event.preventDefault();

        if (action === 'add-cabang') {
          addCabang();
          return;
        }
        if (action === 'submit-admin-verify') {
          submitAdminVerify();
        }
      }

      function handleAdminDelegatedBlur(event) {
        const action = event.target.dataset.adminBlur;
        if (action === 'normalize-carry-bank') {
          normalizeAdminCarryBankField();
        }
      }

      function initAdminEventBindings() {
        document.addEventListener('click', handleAdminDelegatedClick);
        document.addEventListener('input', handleAdminDelegatedInput);
        document.addEventListener('change', handleAdminDelegatedChange);
        document.addEventListener('keydown', handleAdminDelegatedKeydown);
        document.addEventListener('blur', handleAdminDelegatedBlur, true);

        const proofImg = document.getElementById('proofImg');
        if (proofImg) {
          proofImg.addEventListener('load', handleProofLoad);
          proofImg.addEventListener('error', handleProofError);
        }
      }

      function clearAdminVerifyError() {
        const errEl = document.getElementById('adminVerifyErr');
        errEl.textContent = '';
      }

      function openSettingsModal() {
        openModal('modalSettings');
        refreshPwCards();
      }

      async function openSettingsGate() {
        if (hasActiveSession('admin')) {
          openSettingsModal();
          return;
        }

        try {
          const res = await fetch('/api/auth?key=admin_password');
          const json = await res.json();
          if (json && !json.hasPassword) {
            openSettingsModal();
            return;
          }
        } catch {
          showToast('Gagal memeriksa password admin', 'error');
          return;
        }

        document.getElementById('adminVerifyPw').value = '';
        clearAdminVerifyError();
        openModal('modalAdminVerify');
        setTimeout(() => document.getElementById('adminVerifyPw').focus(), 50);
      }

      async function submitAdminVerify() {
        const pwEl = document.getElementById('adminVerifyPw');
        const errEl = document.getElementById('adminVerifyErr');
        const btn = document.getElementById('btnAdminVerify');
        const password = pwEl.value;
        if (!password) {
          errEl.textContent = 'Masukkan password admin';
          return;
        }

        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Memverifikasi...';

        try {
          const res = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'verify', password, key: 'admin_password' })
          });
          const json = await res.json();
          if (!res.ok) {
            errEl.textContent = json.error || 'Password admin salah';
            pwEl.select();
            return;
          }

          sessionStorage.setItem('adminAuth', '1');
          sessionStorage.setItem('adminAuthTs', String(Date.now()));
          sessionStorage.setItem('adminToken', '');
          document.getElementById('modalAdminVerify').classList.remove('show');
          openSettingsModal();
        } catch {
          errEl.textContent = 'Kesalahan jaringan, coba lagi';
        } finally {
          btn.disabled = false;
          btn.innerHTML = '<i class="bi bi-unlock-fill me-1"></i>Buka Pengaturan';
        }
      }

      // ── Password ──
      async function refreshPwCards() {
        try {
          const [adminRes, dashRes] = await Promise.all([
            fetch('/api/auth?key=admin_password'),
            fetch('/api/auth?key=dashboard_password'),
          ]);
          const adminJson = await adminRes.json();
          const dashJson = await dashRes.json();
          document.getElementById('cardBuatPw').style.display = adminJson.hasPassword ? 'none' : 'block';
          document.getElementById('cardGantiPw').style.display = adminJson.hasPassword ? 'block' : 'none';
          document.getElementById('cardBuatDashPw').style.display = dashJson.hasPassword ? 'none' : 'block';
          document.getElementById('cardGantiDashPw').style.display = dashJson.hasPassword ? 'block' : 'none';
        } catch { /* tampilkan default jika gagal */ }
      }

      function checkPwBuat() {
        const p1 = document.getElementById('pwBaru1').value;
        const p2 = document.getElementById('pwBaru2').value;
        const errEl = document.getElementById('pwBuatError');
        const btn = document.getElementById('btnBuatPw');
        if (p1.length > 0 && p1.length < 8) { errEl.textContent = 'Password minimal 8 karakter'; errEl.style.display = 'block'; btn.disabled = true; return; }
        if (p2 && p1 !== p2) { errEl.textContent = 'Password tidak cocok'; errEl.style.display = 'block'; btn.disabled = true; return; }
        errEl.style.display = 'none';
        btn.disabled = !(p1.length >= 8 && p1 === p2);
      }

      async function buatPassword() {
        const btn = document.getElementById('btnBuatPw');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Menyimpan...';
        try {
          const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', password: document.getElementById('pwBaru1').value, key: 'admin_password' }) });
          const json = await res.json();
          if (!res.ok) { document.getElementById('pwBuatError').textContent = json.error; document.getElementById('pwBuatError').style.display = 'block'; }
          else { document.getElementById('pwBaru1').value = ''; document.getElementById('pwBaru2').value = ''; showToast('Password berhasil dibuat', 'success'); refreshPwCards(); }
        } catch { showToast('Kesalahan jaringan', 'error'); }
        btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Simpan Password';
        btn.disabled = false;
      }

      function checkPwGanti() {
        const lama = document.getElementById('pwLama').value;
        const p3 = document.getElementById('pwBaru3').value;
        const p4 = document.getElementById('pwBaru4').value;
        const errEl = document.getElementById('pwGantiError');
        const btn = document.getElementById('btnGantiPw');
        if (p3.length > 0 && p3.length < 8) { errEl.textContent = 'Password baru minimal 8 karakter'; errEl.style.display = 'block'; btn.disabled = true; return; }
        if (p4 && p3 !== p4) { errEl.textContent = 'Password baru tidak cocok'; errEl.style.display = 'block'; btn.disabled = true; return; }
        errEl.style.display = 'none';
        btn.disabled = !(lama && p3.length >= 8 && p3 === p4);
      }

      async function gantiPassword() {
        const btn = document.getElementById('btnGantiPw');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Menyimpan...';
        try {
          const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'change', password: document.getElementById('pwLama').value, newPassword: document.getElementById('pwBaru3').value, key: 'admin_password' }) });
          const json = await res.json();
          if (!res.ok) { document.getElementById('pwGantiError').textContent = json.error; document.getElementById('pwGantiError').style.display = 'block'; }
          else {
            document.getElementById('pwLama').value = '';
            document.getElementById('pwBaru3').value = '';
            document.getElementById('pwBaru4').value = '';
            document.getElementById('pwGantiError').style.display = 'none';
            showToast('Password admin berhasil diganti', 'success');
            clearSession('admin');
          }
        } catch { showToast('Kesalahan jaringan', 'error'); }
        btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Ganti Password';
        btn.disabled = false;
      }

      // ── Viewer Password ──
      function checkDashPwBuat() {
        const p1 = document.getElementById('dashPwBaru1').value;
        const p2 = document.getElementById('dashPwBaru2').value;
        const errEl = document.getElementById('dashPwBuatError');
        const btn = document.getElementById('btnBuatDashPw');
        if (p1.length > 0 && p1.length < 8) { errEl.textContent = 'Password minimal 8 karakter'; errEl.style.display = 'block'; btn.disabled = true; return; }
        if (p2 && p1 !== p2) { errEl.textContent = 'Password tidak cocok'; errEl.style.display = 'block'; btn.disabled = true; return; }
        errEl.style.display = 'none';
        btn.disabled = !(p1.length >= 8 && p1 === p2);
      }

      async function buatDashPassword() {
        const btn = document.getElementById('btnBuatDashPw');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Menyimpan...';
        try {
          const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', password: document.getElementById('dashPwBaru1').value, key: 'dashboard_password' }) });
          const json = await res.json();
          if (!res.ok) { document.getElementById('dashPwBuatError').textContent = json.error; document.getElementById('dashPwBuatError').style.display = 'block'; }
          else { document.getElementById('dashPwBaru1').value = ''; document.getElementById('dashPwBaru2').value = ''; showToast('Password viewer berhasil dibuat', 'success'); refreshPwCards(); }
        } catch { showToast('Kesalahan jaringan', 'error'); }
        btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Simpan Password';
        btn.disabled = false;
      }

      function checkDashPwGanti() {
        const lama = document.getElementById('dashPwLama').value;
        const p3 = document.getElementById('dashPwBaru3').value;
        const p4 = document.getElementById('dashPwBaru4').value;
        const errEl = document.getElementById('dashPwGantiError');
        const btn = document.getElementById('btnGantiDashPw');
        if (p3.length > 0 && p3.length < 8) { errEl.textContent = 'Password baru minimal 8 karakter'; errEl.style.display = 'block'; btn.disabled = true; return; }
        if (p4 && p3 !== p4) { errEl.textContent = 'Password baru tidak cocok'; errEl.style.display = 'block'; btn.disabled = true; return; }
        errEl.style.display = 'none';
        btn.disabled = !(lama && p3.length >= 8 && p3 === p4);
      }

      async function gantiDashPassword() {
        const btn = document.getElementById('btnGantiDashPw');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Menyimpan...';
        try {
          const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'change', password: document.getElementById('dashPwLama').value, newPassword: document.getElementById('dashPwBaru3').value, key: 'dashboard_password' }) });
          const json = await res.json();
          if (!res.ok) { document.getElementById('dashPwGantiError').textContent = json.error; document.getElementById('dashPwGantiError').style.display = 'block'; }
          else { document.getElementById('dashPwLama').value = ''; document.getElementById('dashPwBaru3').value = ''; document.getElementById('dashPwBaru4').value = ''; document.getElementById('dashPwGantiError').style.display = 'none'; showToast('Password viewer berhasil diganti', 'success'); }
        } catch { showToast('Kesalahan jaringan', 'error'); }
        btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Ganti Password';
        btn.disabled = false;
      }

      // ── Kelola Cabang ──
      async function loadCabangModal(options = {}) {
        const { forceRefresh = false, silent = false } = options;
        const countEl = document.getElementById('cabangCount');
        const hasSnapshot = cabangSnapshotLoaded;

        if (hasSnapshot) {
          renderCabangList();
        } else if (!silent) {
          countEl.textContent = 'Memuat...';
        }

        try {
          if (!hasSnapshot || forceRefresh) {
            await fetchCabangSnapshot({ forceRefresh });
          }
          renderCabangList();
          // Auto-sync WA + password dari Maukirim — sekali per sesi, background, silent
          if (!cabangAutoSyncDone) {
            cabangAutoSyncDone = true;
            fetch('/api/cabang?sync=maukirim', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': getOpsToken() } })
              .then(r => r.json())
              .then(json => { if (json.updated > 0) loadCabangModal({ forceRefresh: true, silent: true }); })
              .catch(() => {});
          }
        } catch (err) {
          if (!hasSnapshot) {
            countEl.textContent = 'Gagal memuat cabang';
            document.getElementById('cabangList').innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-circle"></i>Gagal memuat data cabang</div>';
            return;
          }
          if (!silent) showToast(err.message || 'Gagal memuat data cabang', 'error');
        }
      }

      function toggleAddBtn() {
        const nama = document.getElementById('inputCabang').value.trim();
        const area = document.getElementById('inputArea').value;
        document.getElementById('btnAdd').disabled = !nama || !area;
      }

      async function addCabang() {
        const input = document.getElementById('inputCabang');
        const val = input.value.trim();
        if (!val) return;
        const btn = document.getElementById('btnAdd');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Menyimpan...';
        try {
          const body = {
            nama: val,
            area: document.getElementById('inputArea').value,
          };
          const res = await fetch('/api/cabang', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': getOpsToken() }, body: JSON.stringify(body) });
          const json = await res.json();
          if (!res.ok) { showToast(json.error || 'Gagal menambah cabang', 'error'); }
          else { input.value = ''; document.getElementById('inputArea').value = ''; showToast('Cabang berhasil ditambahkan', 'success'); await loadCabangModal({ forceRefresh: true, silent: true }); await refreshAdminViewsAfterWrite({ source: 'admin_cabang_create' }); }
        } catch { showToast('Terjadi kesalahan jaringan', 'error'); }
        finally { btn.innerHTML = '<i class="bi bi-plus-lg"></i> Tambah Cabang'; btn.disabled = !document.getElementById('inputCabang').value.trim(); }
      }

      async function deleteCabang(id, name) {
        if (!confirm(`Hapus "${name}"?`)) return;
        try {
          const res = await fetch(`/api/cabang?id=${id}`, { method: 'DELETE', headers: { 'X-Admin-Token': getOpsToken() } });
          const json = await res.json();
          if (!res.ok) { showToast(json.error || 'Gagal menghapus cabang', 'error'); }
          else { showToast('Cabang dihapus', 'success'); await loadCabangModal({ forceRefresh: true, silent: true }); await refreshAdminViewsAfterWrite({ source: 'admin_cabang_delete' }); }
        } catch { showToast('Terjadi kesalahan jaringan', 'error'); }
      }

      function startEditCabang(id) {
        const item = document.getElementById('ci-' + id);
        if (!item) return;
        const c = cabangData.find(x => x.id === id);
        if (!c) return;
        item.classList.add('editing');
        item.innerHTML = `
          <div class="edit-fields">
            <input type="text" id="editNama-${id}" value="${escHtmlAdmin(c.nama)}" maxlength="100" placeholder="Nama cabang">
            <select id="editArea-${id}">
              <option value="SULTRA"${c.area==='SULTRA'?' selected':''}>SULTRA</option>
              <option value="MKS OUTER"${c.area==='MKS OUTER'?' selected':''}>MKS OUTER</option>
              <option value="CUSTUMER"${c.area==='CUSTUMER'?' selected':''}>CUSTUMER</option>
            </select>
          </div>
          <div class="c-actions">
            <button class="c-btn c-btn-save" type="button" data-admin-click="save-edit-cabang" data-cabang-id="${id}" title="Simpan"><i class="bi bi-check-lg"></i></button>
            <button class="c-btn c-btn-cancel" type="button" data-admin-click="render-cabang-list" title="Batal"><i class="bi bi-x-lg"></i></button>
          </div>`;
        document.getElementById('editNama-' + id).focus();
      }

      async function saveEditCabang(id) {
        const nama = document.getElementById('editNama-' + id).value.trim();
        const area = document.getElementById('editArea-' + id).value;
        if (!nama) { showToast('Nama tidak boleh kosong', 'error'); return; }
        const body = { id, nama, area };
        try {
          const res = await fetch('/api/cabang', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': getOpsToken() }, body: JSON.stringify(body) });
          const json = await res.json();
          if (!res.ok) { showToast(json.error || 'Gagal mengubah cabang', 'error'); }
          else { showToast('Cabang diperbarui', 'success'); await loadCabangModal({ forceRefresh: true, silent: true }); await refreshAdminViewsAfterWrite({ source: 'admin_cabang_update' }); }
        } catch { showToast('Terjadi kesalahan jaringan', 'error'); }
      }

      function renderCabangList() {
        const q = document.getElementById('searchCabang').value.trim().toLowerCase();
        const filtered = cabangData.filter(c => c.nama.toLowerCase().includes(q));
        const el = document.getElementById('cabangList');
        const total = cabangData.length;
        document.getElementById('cabangCount').textContent = total + ' cabang terdaftar';

        if (filtered.length === 0) {
          el.innerHTML = `<div class="empty-state"><i class="bi bi-inbox"></i>${q ? 'Tidak ditemukan' : 'Belum ada cabang terdaftar'}</div>`;
          return;
        }

        const groups = {};
        filtered.forEach(c => { const a = c.area || 'LAINNYA'; if (!groups[a]) groups[a] = []; groups[a].push(c); });
        const areaOrder = ['SULTRA', 'MKS OUTER', 'CUSTUMER', 'LAINNYA'];
        const areaClass = { 'SULTRA': 'sultra', 'MKS OUTER': 'mks', 'CUSTUMER': 'cust' };
        const areaColor = { 'SULTRA': '#e8edf5', 'MKS OUTER': '#fef9c3', 'CUSTUMER': '#fce7f3', 'LAINNYA': '#f1f5f9' };
        const areaTextColor = { 'SULTRA': '#131b2e', 'MKS OUTER': '#ca8a04', 'CUSTUMER': '#db2777', 'LAINNYA': '#64748b' };

        const sorted = Object.keys(groups).sort((a, b) => {
          const ia = areaOrder.indexOf(a); const ib = areaOrder.indexOf(b);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });

        let html = ''; let globalIdx = 1;
        sorted.forEach(area => {
          const cls = areaClass[area] || '';
          const bg = areaColor[area] || '#f1f5f9';
          const tc = areaTextColor[area] || '#64748b';
          html += `<div class="area-group"><div class="area-header ${cls}">${area} <span class="area-badge">${groups[area].length}</span></div>`;
          groups[area].forEach(c => {
            const waText = c.no_wa
              ? `<span class="c-wa-text"><i class="bi bi-whatsapp"></i> ${escHtmlAdmin(c.no_wa)}</span>`
              : `<span class="c-wa-empty"><i class="bi bi-whatsapp"></i> Belum diset</span>`;
            const pwBadge = c.has_password
              ? `<span class="c-pw-badge c-pw-set"><i class="bi bi-lock-fill"></i> Password aktif</span>`
              : `<span class="c-pw-badge c-pw-empty"><i class="bi bi-lock"></i> Belum ada password</span>`;
            html += `<div class="cabang-item" id="ci-${c.id}">
              <span class="c-num">${globalIdx++}</span>
              <div class="c-info">
                <div class="c-name">${escHtmlAdmin(c.nama)}</div>
                <div class="c-meta">
                  <span class="c-area-tag" style="background:${bg};color:${tc}">${area}</span>
                  ${waText}
                  ${pwBadge}
                </div>
              </div>
              <div class="c-actions">
                <button class="c-btn c-btn-edit" type="button" data-admin-click="edit-cabang" data-cabang-id="${c.id}" title="Edit"><i class="bi bi-pencil"></i></button>
                <button class="c-btn c-btn-del" type="button" data-admin-click="delete-cabang" data-cabang-id="${c.id}" data-cabang-name="${encodeURIComponent(c.nama)}" title="Hapus"><i class="bi bi-trash3"></i></button>
              </div>
            </div>`;
          });
          html += `</div>`;
        });

        el.innerHTML = html;
      }

      function getAuditDatesForPeriode(periode) {
        if (!periode || !/^\d{4}-\d{2}$/.test(periode)) return [];
        const [year, month] = periode.split('-').map(Number);
        const today = getTodayYmdWita();
        const maxDay = periode === getMonitorPeriode()
          ? Number(today.slice(8, 10))
          : new Date(year, month, 0).getDate();
        return Array.from({ length: maxDay }, (_, index) => {
          return periode + '-' + String(index + 1).padStart(2, '0');
        });
      }

      function formatAuditNominal(value) {
        return toNominal(value).toLocaleString('id-ID');
      }

      function formatAuditDateShort(ymd) {
        if (!ymd) return '-';
        const parts = String(ymd).split('-');
        if (parts.length < 3) return ymd;
        return parts[2] + '/' + parts[1];
      }

      function buildAuditTransferBreakdown(transfers) {
        if (!Array.isArray(transfers) || !transfers.length) return 'tidak ada transfer';
        return transfers.map(item => formatAuditNominal(item.nominal)).join(' + ');
      }

      function buildAuditCabangState(periode, ncData, trData, cabangRows) {
        const ncByDay = ncData && ncData.byDay ? ncData.byDay : {};
        const transferRows = Array.isArray(trData && trData.transfers) ? trData.transfers : [];
        const cabangMap = new Map();
        const auditDates = getAuditDatesForPeriode(periode);

        function ensureCabangEntry(rawName, rawArea) {
          const name = String(rawName || '').trim();
          if (!name) return null;
          const area = String(rawArea || 'LAINNYA').trim() || 'LAINNYA';
          if (!cabangMap.has(name)) {
            cabangMap.set(name, { cabang: name, area, ncByDate: {}, trByDate: {} });
          } else if (area && cabangMap.get(name).area === 'LAINNYA') {
            cabangMap.get(name).area = area;
          }
          return cabangMap.get(name);
        }

        (Array.isArray(cabangRows) ? cabangRows : []).forEach(row => {
          ensureCabangEntry(row.nama, row.area);
        });

        Object.keys(ncByDay).forEach(date => {
          if (!String(date).startsWith(periode + '-')) return;
          const byCabang = ncByDay[date] || {};
          Object.keys(byCabang).forEach(cabang => {
            const nominal = toNominal(byCabang[cabang] && byCabang[cabang].ongkir);
            const entry = ensureCabangEntry(cabang, 'LAINNYA');
            if (!entry) return;
            entry.ncByDate[date] = nominal;
          });
        });

        transferRows.forEach(row => {
          const cabang = String(row.nama_cabang || '').trim();
          const date = normTgl(row.tgl_inputan);
          if (!cabang || !date || !String(date).startsWith(periode + '-')) return;
          const entry = ensureCabangEntry(cabang, 'LAINNYA');
          if (!entry) return;
          if (!entry.trByDate[date]) entry.trByDate[date] = [];
          entry.trByDate[date].push({
            id: row.id,
            nominal: toNominal(row.nominal),
            nama_bank: row.nama_bank || '',
            ket: row.ket || '',
            timestamp: row.timestamp || '',
            proofUrl: getTransferProofUrl(row),
          });
        });

        const items = Array.from(cabangMap.values()).map(entry => {
          const orderedDates = [...new Set([...auditDates, ...Object.keys(entry.ncByDate), ...Object.keys(entry.trByDate)])].sort();
          const rows = orderedDates.map(date => {
            const noncod = toNominal(entry.ncByDate[date] || 0);
            const transfers = (entry.trByDate[date] || []).slice().sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
            const transfer = transfers.reduce((sum, item) => sum + toNominal(item.nominal), 0);
            const transferText = buildAuditTransferBreakdown(transfers);
            const diff = noncod - transfer;
            const isSafe = noncod > 0 && (diff === 0 || (diff < 0 && Math.abs(diff) <= 500));
            let tone = 'safe';
            let line = '';

            if (noncod <= 0 && transfer <= 0) {
              line = formatAuditDateShort(date) + ': tidak ada NONCOD, tidak ada transfer';
              tone = 'safe';
            } else if (noncod > 0 && transfer <= 0) {
              line = formatAuditDateShort(date) + ': NONCOD ' + formatAuditNominal(noncod) + ', tidak ada transfer';
              tone = 'pending';
            } else if (noncod <= 0 && transfer > 0) {
              line = formatAuditDateShort(date) + ': tidak ada NONCOD, transfer ' + transferText + ', cek';
              tone = 'warn';
            } else if (isSafe) {
              line = formatAuditDateShort(date) + ': NONCOD ' + formatAuditNominal(noncod) + ', transfer ' + transferText + ', aman';
              tone = 'safe';
            } else if (diff > 0) {
              line = formatAuditDateShort(date) + ': NONCOD ' + formatAuditNominal(noncod) + ', transfer ' + transferText + ', kurang ' + formatAuditNominal(diff);
              tone = 'pending';
            } else {
              line = formatAuditDateShort(date) + ': NONCOD ' + formatAuditNominal(noncod) + ', transfer ' + transferText + ', lebih ' + formatAuditNominal(Math.abs(diff));
              tone = 'warn';
            }

            const proofCount = transfers.filter(item => item.proofUrl).length;
            const transferMeta = transfers.map(item => {
              const bank = String(item.nama_bank || '').trim();
              const time = item.timestamp ? new Date(item.timestamp).toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' }) : '';
              const ket = String(item.ket || '').trim();
              return [bank, time, ket].filter(Boolean).join(' · ');
            }).filter(Boolean);

            return { date, noncod, transfer, diff, tone, line, transfers, proofCount, transferMeta, carryMeta: [] };
          });

          const summary = rows.reduce((acc, row) => {
            if (row.noncod > 0 || row.transfer > 0) acc.activeDays += 1;
            if (row.tone === 'safe' && (row.noncod > 0 || row.transfer > 0)) acc.safe += 1;
            if (row.tone === 'pending') acc.pending += 1;
            if (row.tone === 'warn') acc.warn += 1;
            return acc;
          }, { safe: 0, pending: 0, warn: 0, activeDays: 0 });

          return { cabang: entry.cabang, area: entry.area, rows, summary };
        }).sort((a, b) => a.cabang.localeCompare(b.cabang));

        return { periode, items };
      }

      async function openAuditCabangModal() {
        document.getElementById('searchAuditCabang').value = '';
        openModal('modalAuditCabang');
        await loadAuditCabangModal(false, { silent: true });
        setTimeout(() => document.getElementById('searchAuditCabang').focus(), 60);
      }

      async function loadAuditCabangModal(forceRefresh = false, options = {}) {
        const silent = !!options.silent;
        const periode = getMonitorPeriode();
        const listEl = document.getElementById('auditCabangList');
        const detailEl = document.getElementById('auditCabangDetail');
        const countEl = document.getElementById('auditCabangCount');
        const badgeEl = document.getElementById('auditPeriodeBadge');
        const refreshBtn = document.getElementById('auditRefreshBtn');
        const hasState = !!(auditCabangState && auditCabangState.periode === periode && Array.isArray(auditCabangState.items));

        badgeEl.innerHTML = '<i class="bi bi-calendar-month"></i>' + escHtmlAdmin(getPeriodeLabel(periode));
        if (!hasState && !silent) {
          countEl.textContent = 'Memuat audit periode aktif...';
          listEl.innerHTML = '<div class="empty-state"><span class="spinner-border spinner-border-sm"></span></div>';
          detailEl.innerHTML = '<div class="empty-state"><span class="spinner-border spinner-border-sm"></span></div>';
        } else if (hasState) {
          renderAuditCabangList();
          renderAuditCabangDetail();
        }
        if (refreshBtn) refreshBtn.classList.add('spinning');

        try {
          const [monitor, cabangRows] = await Promise.all([
            fetchMonitorSnapshot(periode, { forceRefresh: forceRefresh || !hasState }),
            fetchCabangSnapshot(),
          ]);
          auditCabangState = buildAuditCabangState(periode, monitor.ncData, monitor.trData, cabangRows || []);
          const items = auditCabangState.items || [];
          if (!items.length) {
            countEl.textContent = 'Belum ada cabang untuk diaudit';
            listEl.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i>Belum ada data cabang</div>';
            detailEl.innerHTML = '<div class="empty-state"><i class="bi bi-clipboard-data"></i>Belum ada data audit periode ini</div>';
            return;
          }

          if (!items.some(item => item.cabang === auditSelectedCabang)) {
            auditSelectedCabang = items[0].cabang;
          }

          countEl.textContent = items.length + ' cabang · periode aktif ' + getPeriodeLabel(periode);
          renderAuditCabangList();
          renderAuditCabangDetail();
        } catch (err) {
          if (hasState) {
            if (!silent) showToast(err.message || 'Gagal memuat audit', 'error');
            return;
          }
          auditCabangState = null;
          countEl.textContent = 'Gagal memuat audit';
          listEl.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-circle"></i>' + escHtmlAdmin(err.message || 'Gagal memuat data') + '</div>';
          detailEl.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-circle"></i>Audit cabang belum bisa ditampilkan</div>';
        } finally {
          if (refreshBtn) refreshBtn.classList.remove('spinning');
        }
      }

      function renderAuditCabangList() {
        const listEl = document.getElementById('auditCabangList');
        const query = String(document.getElementById('searchAuditCabang').value || '').trim().toLowerCase();
        const items = auditCabangState && Array.isArray(auditCabangState.items) ? auditCabangState.items : [];
        const filtered = items.filter(item => item.cabang.toLowerCase().includes(query));

        if (!filtered.length) {
          listEl.innerHTML = '<div class="empty-state"><i class="bi bi-search"></i>' + (query ? 'Cabang tidak ditemukan' : 'Belum ada cabang') + '</div>';
          return;
        }

        listEl.innerHTML = '<div class="audit-list">' + filtered.map(item => {
          const encodedCabang = encodeURIComponent(item.cabang);
          const issueText = item.summary.pending > 0 || item.summary.warn > 0
            ? '<span class="audit-cabang-alert">' + (item.summary.pending + item.summary.warn) + ' perlu dicek</span>'
            : 'Semua tanggal aktif aman';
          return '<button class="audit-cabang-btn' + (item.cabang === auditSelectedCabang ? ' active' : '') + '" type="button" data-admin-click="select-audit-cabang" data-cabang="' + encodedCabang + '">' +
            '<div class="audit-cabang-top">' +
              '<div class="audit-cabang-name">' + escHtmlAdmin(item.cabang) + '</div>' +
              '<div class="audit-cabang-area">' + escHtmlAdmin(item.area || 'LAINNYA') + '</div>' +
            '</div>' +
            '<div class="audit-cabang-meta">Aktif ' + item.summary.activeDays + ' hari · Aman ' + item.summary.safe + ' · Kurang ' + item.summary.pending + ' · Lebih ' + item.summary.warn + '</div>' +
            '<div class="audit-cabang-meta">' + issueText + '</div>' +
          '</button>';
        }).join('') + '</div>';
      }

      function selectAuditCabang(encodedCabang) {
        auditSelectedCabang = decodeURIComponent(encodedCabang || '');
        renderAuditCabangList();
        renderAuditCabangDetail();
      }

      function renderAuditCabangDetail() {
        const detailEl = document.getElementById('auditCabangDetail');
        const items = auditCabangState && Array.isArray(auditCabangState.items) ? auditCabangState.items : [];
        const selected = items.find(item => item.cabang === auditSelectedCabang) || items[0];

        if (!selected) {
          detailEl.innerHTML = '<div class="empty-state"><i class="bi bi-building"></i>Pilih cabang untuk melihat audit harian</div>';
          return;
        }

        auditSelectedCabang = selected.cabang;
        const summary = selected.summary || { safe: 0, pending: 0, warn: 0, activeDays: 0 };
        const activeRows = selected.rows.filter(row => row.noncod > 0 || row.transfer > 0);
        const hiddenCount = selected.rows.length - activeRows.length;
        const rowsHtml = activeRows.map(row => {
          const proofsHtml = row.transfers.filter(item => item.proofUrl).map((item, index) => {
            const labelParts = ['Bukti ' + (index + 1)];
            if (item.nama_bank) labelParts.push(item.nama_bank);
            if (item.timestamp) labelParts.push(new Date(item.timestamp).toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' }));
            return '<a class="btn-proof-tr" href="' + escHtmlAdmin(item.proofUrl) + '" target="_blank" rel="noopener noreferrer" data-admin-click="open-proof"><i class="bi bi-image"></i> ' + escHtmlAdmin(labelParts.join(' · ')) + '</a>';
          }).join('');

          const metaParts = [];
          if (row.carryMeta.length > 0) metaParts.push(row.carryMeta.join(' | '));
          if (row.proofCount > 0) metaParts.push(row.proofCount + ' bukti');
          if (row.transferMeta.length > 0) metaParts.push(row.transferMeta.join(' | '));

          return '<div class="audit-row ' + row.tone + '">' +
            '<div class="audit-line ' + row.tone + '">' + escHtmlAdmin(row.line) + '</div>' +
            (metaParts.length ? '<div class="audit-row-meta">' + escHtmlAdmin(metaParts.join(' · ')) + '</div>' : '') +
            (proofsHtml ? '<div class="audit-proof-list">' + proofsHtml + '</div>' : '') +
          '</div>';
        }).join('');

        const noActivityHtml = !activeRows.length
          ? '<div class="audit-empty-note"><i class="bi bi-inbox"></i>Belum ada NONCOD maupun transfer bulan ini</div>'
          : '';
        const hiddenNote = hiddenCount > 0
          ? '<div class="audit-empty-note"><i class="bi bi-eye-slash"></i>' + hiddenCount + ' hari tanpa aktivitas disembunyikan</div>'
          : '';

        detailEl.innerHTML = '<div class="audit-detail-card">' +
          '<div class="audit-detail-head">' +
            '<div>' +
              '<div class="audit-detail-title">' + escHtmlAdmin(selected.cabang) + '</div>' +
              '<div class="audit-detail-sub">Audit harian periode aktif ' + escHtmlAdmin(getPeriodeLabel(auditCabangState.periode)) + '</div>' +
            '</div>' +
            '<div class="audit-cabang-area">' + escHtmlAdmin(selected.area || 'LAINNYA') + '</div>' +
          '</div>' +
          '<div class="audit-stats">' +
            '<div class="audit-stat safe"><div class="audit-stat-val">' + summary.safe + '</div><div class="audit-stat-label">Aman</div></div>' +
            '<div class="audit-stat pending"><div class="audit-stat-val">' + summary.pending + '</div><div class="audit-stat-label">Kurang</div></div>' +
            '<div class="audit-stat warn"><div class="audit-stat-val">' + summary.warn + '</div><div class="audit-stat-label">Lebih / Cek</div></div>' +
          '</div>' +
          '<div class="audit-rows">' + noActivityHtml + rowsHtml + hiddenNote + '</div>' +
        '</div>';
      }

      function safeDomId(value) {
        return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      }

      function normalizeAdminCarryBankInput(value) {
        if (adminCarryOcrModule && typeof adminCarryOcrModule.normalizeBankNameInput === 'function') {
          return adminCarryOcrModule.normalizeBankNameInput(value);
        }
        return String(value || '').trim().toUpperCase();
      }

      function normalizeAdminCarryBankField() {
        const input = document.getElementById('carryBankInput');
        if (!input) return;
        const normalized = normalizeAdminCarryBankInput(input.value);
        if (normalized) input.value = normalized;
      }

      function setAdminCarryOcrStatus(type, text) {
        const el = document.getElementById('carryOcrStatus');
        if (!el) return;
        if (!type) {
          el.className = 'carry-ocr-status';
          el.innerHTML = '';
          return;
        }

        el.className = 'carry-ocr-status ' + type;
        const safeText = escHtmlAdmin(String(text || ''));
        if (type === 'scanning') {
          el.innerHTML = '<span class="spinner-border"></span>' + safeText;
        } else if (type === 'success') {
          el.innerHTML = '<i class="bi bi-check-circle-fill"></i>' + safeText;
        } else if (type === 'info') {
          el.innerHTML = '<i class="bi bi-info-circle-fill"></i>' + safeText;
        } else {
          el.innerHTML = '<i class="bi bi-x-circle-fill"></i>' + safeText;
        }
      }

      function setAdminCarryBadge(badgeId, show) {
        const mappedId = badgeId === 'bankBadge'
          ? 'carryBankBadge'
          : badgeId === 'nominalBadge'
            ? 'carryNominalBadge'
            : badgeId;
        const badge = document.getElementById(mappedId);
        if (badge) badge.style.display = show ? 'inline-flex' : 'none';
      }

      function compressAdminCarryImage(dataUrl, maxWidth = 800) {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            let width = img.width;
            let height = img.height;
            if (width > maxWidth) {
              height = Math.round(height * maxWidth / width);
              width = maxWidth;
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
          };
          img.src = dataUrl;
        });
      }

      function getAdminCarryCabangRows() {
        const areaOrder = ['SULTRA', 'MKS OUTER', 'CUSTUMER', 'LAINNYA'];
        return (Array.isArray(cabangData) ? cabangData : []).slice().sort((a, b) => {
          const areaA = String(a.area || 'LAINNYA');
          const areaB = String(b.area || 'LAINNYA');
          const orderA = areaOrder.indexOf(areaA);
          const orderB = areaOrder.indexOf(areaB);
          if ((orderA === -1 ? 99 : orderA) !== (orderB === -1 ? 99 : orderB)) {
            return (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB);
          }
          return String(a.nama || '').localeCompare(String(b.nama || ''), 'id');
        });
      }

      function findAdminCarryCabangRecord(value) {
        const normalized = String(value || '').trim().toUpperCase();
        if (!normalized) return null;
        return getAdminCarryCabangRows().find((row) => String(row.nama || '').trim().toUpperCase() === normalized) || null;
      }

      function updateAdminCarryCabangMeta() {
        const metaEl = document.getElementById('carryCabangMeta');
        const searchEl = document.getElementById('carryCabangSearch');
        const hiddenEl = document.getElementById('carryCabangInput');
        if (!metaEl || !searchEl || !hiddenEl) return;

        const selected = findAdminCarryCabangRecord(hiddenEl.value);
        const typed = String(searchEl.value || '').trim();

        if (selected) {
          metaEl.textContent = 'Area ' + (selected.area || 'LAINNYA') + ' · dipilih dari master cabang.';
        } else if (adminCarryCabangFetchPromise) {
          metaEl.textContent = 'Memuat daftar cabang...';
        } else if (typed) {
          metaEl.textContent = 'Klik hasil pencarian agar cabang tepat dan tidak salah mapping.';
        } else {
          metaEl.textContent = 'Pilih cabang dari daftar agar tidak salah mapping.';
        }
      }

      function closeAdminCarryCabangDropdown() {
        const dd = document.getElementById('carryCabangDD');
        if (dd) dd.classList.remove('open');
      }

      function openAdminCarryCabangDropdown() {
        const dd = document.getElementById('carryCabangDD');
        if (!dd) return;
        dd.classList.add('open');
        renderAdminCarryCabangOptions(document.getElementById('carryCabangSearch').value || '');
      }

      function renderAdminCarryCabangOptions(query = '') {
        const listEl = document.getElementById('carryCabangList');
        const hiddenEl = document.getElementById('carryCabangInput');
        if (!listEl || !hiddenEl) return;

        const normalizedQuery = String(query || '').trim().toLowerCase();
        const selectedName = String(hiddenEl.value || '').trim().toUpperCase();
        const rows = getAdminCarryCabangRows().filter((row) => {
          const name = String(row.nama || '').toLowerCase();
          const area = String(row.area || '').toLowerCase();
          return !normalizedQuery || name.includes(normalizedQuery) || area.includes(normalizedQuery);
        });

        if (!rows.length) {
          listEl.innerHTML = '<div class="dd-empty">Tidak ditemukan</div>';
          return;
        }

        let html = '';
        let lastArea = '';
        rows.forEach((row) => {
          const area = String(row.area || 'LAINNYA');
          const name = String(row.nama || '').trim();
          if (area !== lastArea) {
            lastArea = area;
            html += '<div class="dd-group">' + escHtmlAdmin(area) + '</div>';
          }
          const activeClass = name.toUpperCase() === selectedName ? ' active' : '';
          html += '<div class="dd-item' + activeClass + '" data-admin-click="select-admin-carry-cabang" data-cabang="' + encodeURIComponent(name) + '">' +
            '<div class="dd-name">' + escHtmlAdmin(name) + '</div>' +
            '<div class="dd-meta">Area ' + escHtmlAdmin(area) + '</div>' +
          '</div>';
        });

        listEl.innerHTML = html;
      }

      function handleAdminCarryCabangInput() {
        const searchEl = document.getElementById('carryCabangSearch');
        const hiddenEl = document.getElementById('carryCabangInput');
        if (!searchEl || !hiddenEl) return;

        if (String(searchEl.value || '').trim().toUpperCase() !== String(hiddenEl.value || '').trim().toUpperCase()) {
          hiddenEl.value = '';
        }

        renderAdminCarryCabangOptions(searchEl.value || '');
        openAdminCarryCabangDropdown();
        updateAdminCarryCabangMeta();
      }

      function setAdminCarrySelectedCabang(value) {
        const searchEl = document.getElementById('carryCabangSearch');
        const hiddenEl = document.getElementById('carryCabangInput');
        if (!searchEl || !hiddenEl) return;

        const matched = findAdminCarryCabangRecord(value);
        const displayName = matched ? String(matched.nama || '').trim() : String(value || '').trim();
        hiddenEl.value = matched ? displayName : '';
        searchEl.value = displayName;
        renderAdminCarryCabangOptions(displayName);
        updateAdminCarryCabangMeta();
        closeAdminCarryCabangDropdown();
      }

      function selectAdminCarryCabang(encodedValue) {
        setAdminCarrySelectedCabang(decodeURIComponent(encodedValue || ''));
      }

      function maybeSelectAdminCarryCabangFromInput(showFeedback = false) {
        const searchEl = document.getElementById('carryCabangSearch');
        const hiddenEl = document.getElementById('carryCabangInput');
        if (!searchEl || !hiddenEl) return false;

        const typed = String(searchEl.value || '').trim();
        if (!typed) {
          hiddenEl.value = '';
          updateAdminCarryCabangMeta();
          return false;
        }

        const exactMatch = findAdminCarryCabangRecord(typed);
        if (exactMatch) {
          setAdminCarrySelectedCabang(exactMatch.nama);
          return true;
        }

        const candidates = getAdminCarryCabangRows().filter((row) => String(row.nama || '').toLowerCase().includes(typed.toLowerCase()));
        if (candidates.length === 1) {
          setAdminCarrySelectedCabang(candidates[0].nama);
          return true;
        }

        if (showFeedback) showToast('Pilih cabang dari daftar yang tersedia', 'error');
        updateAdminCarryCabangMeta();
        return false;
      }

      async function ensureAdminCarryCabangData() {
        if (Array.isArray(cabangData) && cabangData.length) {
          renderAdminCarryCabangOptions(document.getElementById('carryCabangSearch').value || '');
          updateAdminCarryCabangMeta();
          return cabangData;
        }
        if (adminCarryCabangFetchPromise) return adminCarryCabangFetchPromise;

        updateAdminCarryCabangMeta();
        adminCarryCabangFetchPromise = (async () => {
          try {
            const res = await fetch('/api/cabang');
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Gagal memuat daftar cabang');
            cabangData = Array.isArray(json.cabang) ? json.cabang : [];
            return cabangData;
          } catch (err) {
            showToast(err.message || 'Gagal memuat daftar cabang', 'error');
            return Array.isArray(cabangData) ? cabangData : [];
          } finally {
            adminCarryCabangFetchPromise = null;
            renderAdminCarryCabangOptions(document.getElementById('carryCabangSearch').value || '');
            updateAdminCarryCabangMeta();
          }
        })();

        return adminCarryCabangFetchPromise;
      }

      function resetAdminCarryPreview() {
        const uploadArea = document.getElementById('carryUploadArea');
        const preview = document.getElementById('carryProofPreview');
        const placeholder = document.getElementById('carryUploadPlaceholder');
        const hint = document.getElementById('carryChangeHint');

        if (preview) {
          preview.removeAttribute('src');
          preview.style.display = 'none';
        }
        if (placeholder) placeholder.style.display = 'flex';
        if (hint) hint.style.display = 'none';
        if (uploadArea) uploadArea.classList.remove('has-preview');
      }

      async function runAdminCarryOCR(base64DataUrl) {
        if (!adminCarryOcrController) {
          setAdminCarryOcrStatus('info', 'OCR tidak tersedia. Isi bank dan nominal manual.');
          return;
        }
        await adminCarryOcrController.runOCR(base64DataUrl);
      }

      async function handleAdminCarryProofChange(event) {
        const input = event && event.target ? event.target : document.getElementById('carryProofFile');
        const file = input && input.files && input.files[0] ? input.files[0] : null;
        if (!input || !file) return;

        if (file.size > ADMIN_CARRY_MAX_FILE_SIZE) {
          input.value = '';
          resetAdminCarryPreview();
          setAdminCarryOcrStatus('error', 'File terlalu besar. Maksimal 5MB.');
          return;
        }

        const reader = new FileReader();
        reader.onload = async (loadEvent) => {
          const dataUrl = String(loadEvent && loadEvent.target && loadEvent.target.result || '');
          if (!dataUrl) {
            setAdminCarryOcrStatus('error', 'Gagal membaca file.');
            return;
          }

          const uploadArea = document.getElementById('carryUploadArea');
          const preview = document.getElementById('carryProofPreview');
          const placeholder = document.getElementById('carryUploadPlaceholder');
          const hint = document.getElementById('carryChangeHint');

          if (preview) {
            preview.src = dataUrl;
            preview.style.display = 'block';
          }
          if (placeholder) placeholder.style.display = 'none';
          if (hint) hint.style.display = 'flex';
          if (uploadArea) uploadArea.classList.add('has-preview');

          await runAdminCarryOCR(dataUrl);
        };
        reader.readAsDataURL(file);
      }

      function resetAdminCarryUploadForm() {
        adminCarryUploadContext = null;
        document.getElementById('carryCabangInput').value = '';
        document.getElementById('carryCabangSearch').value = '';
        document.getElementById('carryBankInput').value = '';
        document.getElementById('carryTargetDate').value = '';
        document.getElementById('carryNominalInput').value = '';
        document.getElementById('carryProofFile').value = '';
        document.getElementById('carryReasonInput').value = '';
        document.getElementById('carryKetInput').value = '';
        setAdminCarryBadge('bankBadge', false);
        setAdminCarryBadge('nominalBadge', false);
        setAdminCarryOcrStatus('', '');
        resetAdminCarryPreview();
        renderAdminCarryCabangOptions('');
        updateAdminCarryCabangMeta();
        closeAdminCarryCabangDropdown();
        if (adminCarryOcrController) adminCarryOcrController.resetState();
      }

      async function openAdminCarryUploadModal(prefill = {}) {
        resetAdminCarryUploadForm();
        adminCarryUploadContext = { ...prefill };

        await ensureAdminCarryCabangData();

        if (prefill.cabang) setAdminCarrySelectedCabang(String(prefill.cabang || '').trim());
        document.getElementById('carryBankInput').value = normalizeAdminCarryBankInput(String(prefill.bank || '').trim());
        document.getElementById('carryTargetDate').value = String(prefill.targetDate || '').trim();
        if (prefill.nominal) document.getElementById('carryNominalInput').value = toNominal(prefill.nominal);
        if (prefill.reason) document.getElementById('carryReasonInput').value = String(prefill.reason || '').trim();
        if (prefill.ket) document.getElementById('carryKetInput').value = String(prefill.ket || '').trim();

        openModal('modalAdminCarryUpload');
      }

      async function openAdminCarryUploadFromCase(encodedCabang, targetDate, nominal) {
        const cabang = decodeURIComponent(encodedCabang || '');
        const normalizedTargetDate = String(targetDate || '').trim();
        await openAdminCarryUploadModal({
          cabang,
          targetDate: normalizedTargetDate,
          nominal: toNominal(nominal),
          reason: 'Sisa dari bukti ini menunggu NONCOD update',
        });
      }

      async function submitAdminCarryUpload() {
        maybeSelectAdminCarryCabangFromInput(false);
        normalizeAdminCarryBankField();

        const cabang = String(document.getElementById('carryCabangInput').value || '').trim().toUpperCase();
        const bank = String(document.getElementById('carryBankInput').value || '').trim().toUpperCase();
        const targetDate = String(document.getElementById('carryTargetDate').value || '').trim();
        const nominal = toNominal(document.getElementById('carryNominalInput').value);
        const reason = String(document.getElementById('carryReasonInput').value || '').trim();
        const ket = String(document.getElementById('carryKetInput').value || '').trim();
        const fileInput = document.getElementById('carryProofFile');
        const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        const btn = document.getElementById('btnAdminCarryUpload');

        if (!cabang) {
          showToast('Pilih cabang dari daftar', 'error');
          return;
        }
        if (!bank || !targetDate || nominal <= 0) {
          showToast('Semua field wajib diisi', 'error');
          return;
        }
        if (!file) {
          showToast('Bukti transfer wajib diupload', 'error');
          return;
        }
        if (file.size > ADMIN_CARRY_MAX_FILE_SIZE) {
          showToast('Bukti transfer maksimal 5MB', 'error');
          return;
        }
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Mengupload...';

        try {
          const formData = new FormData();
          formData.append('proof', file);
          formData.append('nama_cabang', cabang);
          formData.append('nama_bank', bank);
          formData.append('nominal', String(nominal));
          formData.append('target_date', targetDate);
          if (reason) formData.append('pending_reason', reason);
          if (ket) formData.append('ket', ket);

          const { response: res, json } = await fetchJsonWithTimeout('/api/input?admin_pending=1', {
            method: 'POST',
            headers: { 'X-Admin-Token': getOpsToken() },
            body: formData,
          }, 30000);

          if (!res.ok) {
            showToast(json.error || 'Gagal upload split admin', 'error');
            return;
          }

          const pendingNominal = toNominal(json && json.pendingNominal);
          if (pendingNominal > 0) {
            const afterDate = String(json && json.pendingAfterDate || '').trim();
            showToast('Upload split tersimpan. Sisa pending Rp ' + pendingNominal.toLocaleString('id-ID') + (afterDate ? ' setelah ' + fmtTanggalId(afterDate) : ''), 'success');
          } else if (json && json.split) {
            showToast('Upload split admin tersimpan dan langsung ditempel ke beberapa tanggal', 'success');
          } else {
            showToast('Upload split admin tersimpan', 'success');
          }
          closeModal('modalAdminCarryUpload');
          resetAdminCarryUploadForm();
          if (document.getElementById('modalTransfer').classList.contains('show')) {
            await loadTransfers();
          }
          await refreshAdminViewsAfterWrite({ source: 'admin_carry_upload' });
        } catch {
          showToast('Kesalahan jaringan', 'error');
        } finally {
          btn.disabled = false;
          btn.innerHTML = '<i class="bi bi-cloud-arrow-up me-1"></i>Upload Split';
        }
      }

      if (adminCarryOcrModule && typeof adminCarryOcrModule.createInputOcrController === 'function') {
        adminCarryOcrController = adminCarryOcrModule.createInputOcrController({
          compressImage: compressAdminCarryImage,
          fetchImpl: window.fetch.bind(window),
          setStatus: setAdminCarryOcrStatus,
          showFields() {},
          setBadge: setAdminCarryBadge,
          setBankValue(value) {
            document.getElementById('carryBankInput').value = normalizeAdminCarryBankInput(value);
          },
          setNominalValue(value) {
            document.getElementById('carryNominalInput').value = String(toNominal(value));
          },
          onReadyChange() {},
          log: console.error.bind(console),
        });
      }

      const carryProofInputEl = document.getElementById('carryProofFile');
      if (carryProofInputEl) carryProofInputEl.addEventListener('change', handleAdminCarryProofChange);

      const carryCabangSearchEl = document.getElementById('carryCabangSearch');
      if (carryCabangSearchEl) {
        carryCabangSearchEl.addEventListener('input', handleAdminCarryCabangInput);
        carryCabangSearchEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            maybeSelectAdminCarryCabangFromInput(true);
          } else if (event.key === 'Escape') {
            closeAdminCarryCabangDropdown();
          }
        });
      }

      document.addEventListener('click', (event) => {
        const dropdown = document.getElementById('carryCabangDD');
        if (!dropdown || dropdown.contains(event.target)) return;
        maybeSelectAdminCarryCabangFromInput(false);
        closeAdminCarryCabangDropdown();
      });

      function openTransferModal() {
        openModal('modalTransfer');
        const sel = document.getElementById('periodeSelect');
        const wasInitialized = sel.options.length > 1;
        initPeriodeSelect();
        if (wasInitialized) {
          loadTransfers({ forceRefresh: true, silent: true, resetFilters: false });
        }
      }

      function openManualStatusModal() {
        document.getElementById('searchManualStatus').value = '';
        manualStatusEditingResi = '';
        openModal('modalManualStatus');
        loadManualStatusModal({ silent: true });
        setTimeout(() => document.getElementById('searchManualStatus').focus(), 60);
      }

      function scheduleManualStatusSearch() {
        clearTimeout(manualStatusSearchTimer);
        manualStatusSearchTimer = setTimeout(() => {
          loadManualStatusModal();
        }, 260);
      }

      function getManualStatusQuery() {
        return (document.getElementById('searchManualStatus').value || '').trim().toUpperCase();
      }

      function getManualStatusRow(nomorResi) {
        return manualStatusRows.find(row => row.nomor_resi === nomorResi) || null;
      }

      async function loadManualStatusModal(options = {}) {
        const { forceRefresh = false, silent = false } = options;
        const listEl = document.getElementById('manualStatusList');
        const countEl = document.getElementById('manualStatusCount');
        const query = getManualStatusQuery();
        manualStatusEditingResi = '';
        const hasSnapshot = manualStatusSnapshotLoaded;
        if (!hasSnapshot && !silent) {
          countEl.textContent = 'Memuat...';
          listEl.innerHTML = '<div class="empty-state"><span class="spinner-border spinner-border-sm"></span></div>';
        } else if (hasSnapshot) {
          applyManualStatusSnapshot(query);
          renderManualStatusList();
        }

        try {
          if (!hasSnapshot || forceRefresh) {
            await fetchManualStatusSnapshot({ forceRefresh });
          }
          applyManualStatusSnapshot(query);
          renderManualStatusList();
        } catch (err) {
          if (hasSnapshot) {
            if (!silent) showToast(err.message || 'Gagal memuat data', 'error');
            return;
          }
          manualStatusRows = [];
          listEl.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-circle"></i>' + escHtmlAdmin(err.message || 'Gagal memuat data') + '</div>';
          countEl.textContent = 'Gagal memuat';
        }
      }

      function renderManualStatusList() {
        const listEl = document.getElementById('manualStatusList');
        const query = getManualStatusQuery();

        if (!manualStatusRows.length) {
          listEl.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i>' + (query ? 'Resi tidak ditemukan' : 'Belum ada resi yang dioverride') + '</div>';
          return;
        }

        listEl.innerHTML = '<div class="status-list">' + manualStatusRows.map((row) => {
          const nomorResi = row.nomor_resi || '';
          const encodedResi = encodeURIComponent(nomorResi);
          const domId = safeDomId(nomorResi);
          const isEditing = manualStatusEditingResi === nomorResi;
          const metaParts = [row.cabang || '-', row.periode || '-'];
          if (row.tanggal_buat) metaParts.push(fmtTanggalId(row.tanggal_buat));
          if (row.metode_pembayaran) metaParts.push(String(row.metode_pembayaran).toUpperCase());
          const sourceStatus = row.source_status_terakhir || '-';
          const effectiveStatus = row.effective_status_terakhir || sourceStatus;
          const badges = [
            row.override_active
              ? '<span class="status-pill manual"><i class="bi bi-pencil-square"></i>' + escHtmlAdmin(row.manual_status_terakhir || '-') + '</span>'
              : '<span class="status-pill live"><i class="bi bi-arrow-repeat"></i>Sync</span>',
            '<span class="status-pill sync">Sync: ' + escHtmlAdmin(sourceStatus) + '</span>',
            row.found_in_sync
              ? ''
              : '<span class="status-pill warn"><i class="bi bi-exclamation-triangle"></i>Row sync tidak ditemukan</span>'
          ].filter(Boolean).join('');

          const editHtml = isEditing
            ? '<div class="status-edit-row">' +
                '<input type="text" id="manualStatusInput-' + domId + '" value="' + escHtmlAdmin(row.manual_status_terakhir || effectiveStatus || 'VOID') + '" maxlength="50" placeholder="Contoh: VOID">' +
                '<button class="status-action warn" id="manualStatusSaveBtn-' + domId + '" type="button" data-admin-click="save-manual-status" data-resi="' + encodedResi + '"><i class="bi bi-check-lg"></i>Simpan</button>' +
                '<button class="status-action" type="button" data-admin-click="cancel-manual-status-edit"><i class="bi bi-x-lg"></i>Batal</button>' +
              '</div>'
            : '<div class="status-actions">' +
                '<button class="status-action warn" type="button" data-admin-click="edit-manual-status" data-resi="' + encodedResi + '"><i class="bi bi-pencil"></i>' + (row.override_active ? 'Edit Status' : 'Set Status') + '</button>' +
                (row.override_active
                  ? '<button class="status-action danger" type="button" data-admin-click="clear-manual-status" data-resi="' + encodedResi + '"><i class="bi bi-trash3"></i>Hapus Override</button>'
                  : '') +
              '</div>';

          return '<div class="status-item' + (isEditing ? ' editing' : '') + '">' +
            '<div class="status-top">' +
              '<div class="status-resi">' + escHtmlAdmin(nomorResi) + '</div>' +
              '<div class="status-badges">' + badges + '</div>' +
            '</div>' +
            '<div class="status-meta">' + escHtmlAdmin(metaParts.join(' · ')) + '</div>' +
            '<div class="status-meta">Status aktif: <strong>' + escHtmlAdmin(effectiveStatus || '-') + '</strong>' + (row.updated_at ? ' · override terakhir ' + escHtmlAdmin(new Date(row.updated_at).toLocaleString('id-ID')) : '') + '</div>' +
            (row.ongkir > 0 ? '<div class="status-meta">Ongkir Rp ' + Number(row.ongkir || 0).toLocaleString('id-ID') + (row.total_pengiriman > 0 ? ' · Total Rp ' + Number(row.total_pengiriman || 0).toLocaleString('id-ID') : '') + '</div>' : '') +
            editHtml +
          '</div>';
        }).join('') + '</div>';

        if (manualStatusEditingResi) {
          const input = document.getElementById('manualStatusInput-' + safeDomId(manualStatusEditingResi));
          if (input) input.focus();
        }
      }

      function startEditManualStatus(encodedResi) {
        manualStatusEditingResi = decodeURIComponent(encodedResi || '');
        renderManualStatusList();
      }

      function cancelManualStatusEdit() {
        manualStatusEditingResi = '';
        renderManualStatusList();
      }

      async function saveManualStatus(encodedResi) {
        const nomorResi = decodeURIComponent(encodedResi || '');
        const row = getManualStatusRow(nomorResi);
        const domId = safeDomId(nomorResi);
        const input = document.getElementById('manualStatusInput-' + domId);
        const saveBtn = document.getElementById('manualStatusSaveBtn-' + domId);
        const statusTerakhir = String((input && input.value) || '').trim().toUpperCase();

        if (!row) {
          showToast('Data resi tidak ditemukan', 'error');
          return;
        }
        if (!statusTerakhir) {
          showToast('Status manual tidak boleh kosong', 'error');
          return;
        }

        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
        }

        try {
          const res = await fetch('/api/noncod-status', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'X-Admin-Token': getOpsToken()
            },
            body: JSON.stringify({
              nomor_resi: row.nomor_resi,
              status_terakhir: statusTerakhir,
              periode: row.periode,
              cabang: row.cabang,
              tanggal_buat: row.tanggal_buat,
              metode_pembayaran: row.metode_pembayaran,
            })
          });
          const json = await res.json();
          if (!res.ok) {
            showToast(json.error || 'Gagal menyimpan status manual', 'error');
            return;
          }
          manualStatusEditingResi = '';
          showToast('Status manual disimpan', 'success');
          await loadManualStatusModal({ forceRefresh: true, silent: true });
          await refreshAdminViewsAfterWrite({ source: 'admin_manual_status_save' });
        } catch {
          showToast('Kesalahan jaringan', 'error');
        } finally {
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="bi bi-check-lg"></i>Simpan';
          }
        }
      }

      async function clearManualStatus(encodedResi) {
        const nomorResi = decodeURIComponent(encodedResi || '');
        if (!nomorResi) return;
        if (!confirm('Hapus override status manual untuk resi ini?')) return;

        try {
          const res = await fetch('/api/noncod-status?nomor_resi=' + encodeURIComponent(nomorResi), {
            method: 'DELETE',
            headers: { 'X-Admin-Token': getOpsToken() }
          });
          const json = await res.json();
          if (!res.ok) {
            showToast(json.error || 'Gagal menghapus override', 'error');
            return;
          }
          manualStatusEditingResi = '';
          showToast('Override dihapus', 'success');
          await loadManualStatusModal({ forceRefresh: true, silent: true });
          await refreshAdminViewsAfterWrite({ source: 'admin_manual_status_clear' });
        } catch {
          showToast('Kesalahan jaringan', 'error');
        }
      }

      // ── Kelola Transfer ──
      let splitTarget = null;
      let splitSuggestionsByTransferId = {};
      let transferLookupById = {};
      let allTransfers = []; // cache data dari API
      let duplicateTransferIds = new Set();
      const BULAN_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

      function initPeriodeSelect() {
        const sel = document.getElementById('periodeSelect');
        if (sel.options.length > 1) return; // sudah di-init
        const now = new Date();
        sel.innerHTML = '<option value="">-- Pilih Periode --</option>';
        for (let i = 0; i < 3; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const val = d.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit' }).slice(0, 7);
          const label = BULAN_ID[d.getMonth()] + ' ' + d.getFullYear();
          const o = document.createElement('option');
          o.value = val; o.textContent = label;
          sel.appendChild(o);
        }
        const defaultVal = now.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit' }).slice(0, 7);
        sel.value = defaultVal;
        loadTransfers({ forceRefresh: true, silent: true, resetFilters: true });
      }

      async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
        const requestLabel = String(options.requestLabel || url || 'Permintaan').trim();
        const fetchOptions = { ...options };
        delete fetchOptions.requestLabel;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
          const rawText = await response.text();
          let json = {};
          if (rawText) {
            try {
              json = JSON.parse(rawText);
            } catch {
              json = { error: rawText };
            }
          }
          return { response, json };
        } catch (err) {
          if (err && err.name === 'AbortError') {
            const timeoutError = new Error(requestLabel + ' terlalu lama (' + timeoutMs + 'ms). Sistem akan coba lagi otomatis.');
            timeoutError.requestLabel = requestLabel;
            timeoutError.requestUrl = String(url || '').slice(0, 300);
            timeoutError.timeoutMs = timeoutMs;
            throw timeoutError;
          }
          throw err;
        } finally {
          window.clearTimeout(timer);
        }
      }

      async function loadTransfers(options = {}) {
        const { forceRefresh = false, silent = false } = options;
        const periode = document.getElementById('periodeSelect').value;
        const listEl = document.getElementById('trList');
        const sumEl = document.getElementById('trSummary');
        const filterBar = document.getElementById('trFilters');
        const shouldResetFilters = Object.prototype.hasOwnProperty.call(options, 'resetFilters')
          ? !!options.resetFilters
          : activeTransferPeriode !== periode;
        if (!periode) {
          listEl.innerHTML = '<div class="empty-state"><i class="bi bi-calendar3"></i>Pilih periode untuk melihat data</div>';
          sumEl.style.display = 'none';
          filterBar.style.display = 'none';
          allTransfers = [];
          transferLookupById = {};
          duplicateTransferIds = new Set();
          activeTransferPeriode = '';
          return;
        }

        const cachedSnapshot = getTransferSnapshot(periode);
        if (cachedSnapshot) {
          applyTransferSnapshot(cachedSnapshot, { resetFilters: shouldResetFilters });
        } else if (!silent) {
          listEl.innerHTML = '<div class="empty-state"><span class="spinner-border spinner-border-sm me-2"></span>Memuat...</div>';
          sumEl.style.display = 'none';
          filterBar.style.display = 'none';
        }

        try {
          const snapshot = await fetchTransferSnapshot(periode, { forceRefresh: forceRefresh || !cachedSnapshot });
          applyTransferSnapshot(snapshot, { resetFilters: !cachedSnapshot && shouldResetFilters });
        } catch (err) {
          if (cachedSnapshot) {
            if (!silent) showToast(err.message || 'Gagal memuat data transfer', 'error');
            return;
          }
          listEl.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-circle"></i>' + escHtmlAdmin(err.message || 'Gagal memuat data') + '</div>';
          sumEl.style.display = 'none';
          filterBar.style.display = 'none';
        }
      }

      // Normalize tgl_inputan ke YYYY-MM-DD dalam timezone WITA
      // Handles both pure date "YYYY-MM-DD" and timestamptz "YYYY-MM-DDT..." from Supabase
      function normTgl(raw) {
        if (!raw) return '';
        if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw; // pure date
        return new Date(raw).toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });
      }

      function normalizeLooseText(val) {
        return String(val || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      }

      function normalizeBankKey(val) {
        const key = normalizeLooseText(val);
        return key === 'MTRANSFER' ? 'BCA' : key;
      }

      function buildDuplicateTransferSet(transfers) {
        const groups = new Map();
        const duplicateIds = new Set();

        transfers.forEach(item => {
          const key = [
            normalizeLooseText(item.nama_cabang),
            normTgl(item.tgl_inputan),
            normalizeBankKey(item.nama_bank),
            toNominal(item.nominal),
            normalizeLooseText(item.ket),
          ].join('|');
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(item);
        });

        groups.forEach(items => {
          if (items.length < 2) return;
          const sorted = [...items].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
          let hasClosePair = false;
          for (let i = 1; i < sorted.length; i++) {
            const prevTs = new Date(sorted[i - 1].timestamp || 0).getTime();
            const curTs = new Date(sorted[i].timestamp || 0).getTime();
            if (!Number.isFinite(prevTs) || !Number.isFinite(curTs) || Math.abs(curTs - prevTs) <= 5 * 60 * 1000) {
              hasClosePair = true;
              break;
            }
          }
          if (!hasClosePair) return;
          sorted.forEach(item => duplicateIds.add(String(item.id)));
        });

        return duplicateIds;
      }

      function getTransferProofUrl(transfer) {
        const raw = String(transfer?.bukti || transfer?.bukti_url || '').trim();
        if (!raw) return '';
        // Already a proxy-image URL from API normalizeProofUrl
        if (raw.startsWith('/api/proxy-image')) return raw;
        // Full Supabase signed URL → extract filename and route through proxy
        if (/^https?:\/\//.test(raw)) {
          const m = raw.match(/\/bukti-transfer\/([^?]+)/);
          if (m) return '/api/proxy-image?path=' + encodeURIComponent(m[1]);
          return raw;
        }
        // Bare filename → route through proxy-image
        return '/api/proxy-image?path=' + encodeURIComponent(raw);
      }

      function applyTrFilter() {
        const q = document.getElementById('trSearchCabang').value.trim().toLowerCase();
        const tgl = document.getElementById('trSearchTgl').value; // 'YYYY-MM-DD'
        const hasFilter = q || tgl;
        document.getElementById('trClearFilter').classList.toggle('active', !!hasFilter);
        const filtered = allTransfers.filter(t => {
          const matchCabang = !q || (t.nama_cabang || '').toLowerCase().includes(q);
          const matchTgl = !tgl || normTgl(t.tgl_inputan) === tgl;
          return matchCabang && matchTgl;
        });
        if (!filtered.length) {
          document.getElementById('trList').innerHTML = '<div class="empty-state"><i class="bi bi-funnel"></i>Tidak ada data cocok filter</div>';
        } else {
          renderTransferList(filtered);
        }
      }

      function clearTrFilter() {
        document.getElementById('trSearchCabang').value = '';
        document.getElementById('trSearchTgl').value = '';
        document.getElementById('trClearFilter').classList.remove('active');
        renderTransferList(allTransfers);
      }

      function getTransferById(id) {
        return transferLookupById[String(id)] || allTransfers.find(t => String(t.id) === String(id)) || null;
      }

      function startEditTrById(id) {
        const transfer = getTransferById(id);
        if (!transfer) {
          showToast('Data transfer tidak ditemukan', 'error');
          return;
        }
        startEditTr(transfer);
      }

      function openSplitById(id) {
        const transfer = getTransferById(id);
        if (!transfer) {
          showToast('Data transfer tidak ditemukan', 'error');
          return;
        }
        openSplit(transfer);
      }

      async function deleteTransferById(id) {
        const transfer = getTransferById(id);
        if (!transfer) {
          showToast('Data transfer tidak ditemukan', 'error');
          return;
        }

        const tgl = normTgl(transfer.tgl_inputan);
        const nominal = toNominal(transfer.nominal).toLocaleString('id-ID');
        const prompt = 'Hapus transfer ini?\n\n' +
          transfer.nama_cabang + '\n' +
          'Tanggal: ' + (tgl || '-') + '\n' +
          'Nominal: Rp ' + nominal + '\n\n' +
          'Gunakan untuk row duplikat atau salah input.';
        if (!confirm(prompt)) return;

        try {
          const res = await fetch('/api/transfer?id=' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'X-Admin-Token': getOpsToken() }
          });
          const json = await res.json();
          if (!res.ok) {
            showToast(json.error || 'Gagal menghapus transfer', 'error');
            return;
          }
          showToast('Transfer dihapus', 'success');
          await loadTransfers({ forceRefresh: true, silent: true, resetFilters: false });
          await refreshAdminViewsAfterWrite({ source: 'admin_transfer_delete' });
        } catch {
          showToast('Kesalahan jaringan', 'error');
        }
      }

      function isAllowedProofUrl(src) {
        if (!src) return false;
        try {
          const url = new URL(src, window.location.origin);
          if (url.origin === window.location.origin && (url.pathname === '/api/proxy-image' || url.pathname === '/api/image')) {
            return true;
          }
          return /^https:\/\/.*\.supabase\.co\/storage\//.test(url.href);
        } catch {
          return false;
        }
      }

      const adminProofViewerModule = window.AdminProofViewer;
      const proofViewer = adminProofViewerModule
        ? adminProofViewerModule.createProofViewer({
            overlay: document.getElementById('proofOverlay'),
            stage: document.getElementById('proofStage'),
            actions: document.getElementById('proofActions'),
            image: document.getElementById('proofImg'),
            error: document.getElementById('proofErr'),
          })
        : null;

      function handleProofOverlay(event) {
        if (!proofViewer) return;
        proofViewer.handleOverlay(event);
      }

      function scheduleProofActionsPosition() {
        if (!proofViewer) return;
        proofViewer.scheduleActionsPosition();
      }

      function positionProofActions() {
        if (!proofViewer) return;
        proofViewer.positionActions();
      }

      function handleProofLoad() {
        if (!proofViewer) return;
        proofViewer.handleLoad();
      }

      function handleProofError() {
        if (!proofViewer) return;
        proofViewer.handleError();
      }

      function openProof(src) {
        if (!isAllowedProofUrl(src)) return false;
        if (!proofViewer) return true;
        try {
          proofViewer.open(src);
          return false;
        } catch {
          return true;
        }
      }

      function closeProof() {
        if (!proofViewer) return;
        proofViewer.close();
      }

      function rotateProof() {
        if (!proofViewer) return;
        proofViewer.rotate();
      }

      if (proofViewer) {
        document.addEventListener('keydown', proofViewer.handleKeydown);
        document.getElementById('proofImg').addEventListener('transitionend', proofViewer.scheduleActionsPosition);
        window.addEventListener('resize', proofViewer.scheduleActionsPosition);
        document.getElementById('proofOverlay').addEventListener('scroll', proofViewer.positionActions);
      }

      async function openTransferReview(periode, cabangEncoded = '', tgl = '', transferId = '', action = '') {
        const cabang = cabangEncoded ? decodeURIComponent(cabangEncoded) : '';
        const wantsSplit = !!transferId && action === 'split';
        const cachedTransfer = wantsSplit ? getTransferById(transferId) : null;
        if (wantsSplit && cachedTransfer) {
          openSplit(cachedTransfer);
          return;
        }
        if (!wantsSplit) openModal('modalTransfer');

        const sel = document.getElementById('periodeSelect');
        if (!Array.from(sel.options).some(opt => opt.value === periode)) {
          const [year, month] = periode.split('-');
          const option = document.createElement('option');
          option.value = periode;
          option.textContent = BULAN_ID[parseInt(month, 10) - 1] + ' ' + year;
          sel.appendChild(option);
        }

        sel.value = periode;
        await loadTransfers({ forceRefresh: true, silent: true, resetFilters: true });

        if (wantsSplit) {
          openSplitById(transferId);
          return;
        }

        document.getElementById('trSearchCabang').value = cabang;
        document.getElementById('trSearchTgl').value = tgl || '';
        if (cabang || tgl) applyTrFilter();

        if (transferId && action === 'edit') startEditTrById(transferId);

        const rowEl = transferId ? document.getElementById('tri-' + transferId) : null;
        if (rowEl) rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      function renderTransferList(transfers) {
        const listEl = document.getElementById('trList');
        listEl.innerHTML = transfers.map(t => {
          const transferId = String(t.id).replace(/'/g, "\\'");
          const duplicateBadge = duplicateTransferIds.has(String(t.id))
            ? '<span class="tr-dup-flag">Duplikat?</span>'
            : '';
          const proofUrl = getTransferProofUrl(t);
          const proofButton = proofUrl
            ? '<a class="btn-proof-tr" href="' + escHtmlAdmin(proofUrl) + '" target="_blank" rel="noopener noreferrer" data-admin-click="open-proof" title="Lihat bukti transfer"><i class="bi bi-image"></i> Bukti</a>'
            : '';
          const tglDisplay = t.tgl_inputan
            ? new Date(normTgl(t.tgl_inputan) + 'T00:00:00').toLocaleDateString('id-ID', { day:'2-digit', month:'2-digit', year:'numeric' })
            : '-';
          const nom = parseFloat(t.nominal).toLocaleString('id-ID');
          return `<div class="tr-item" id="tri-${t.id}">
            <div class="tr-item-main">
              <div class="tr-item-icon"><i class="bi bi-arrow-up-right"></i></div>
              <div class="tr-item-body">
                <div class="tr-item-top">
                  <span class="tr-item-cabang">${escHtmlAdmin(t.nama_cabang)}</span>
                  <span class="tr-item-bank">${escHtmlAdmin(t.nama_bank)}</span>
                  ${duplicateBadge}
                </div>
                <div class="tr-item-meta"><span class="tm-label">Tgl Input:</span> ${tglDisplay}${t.ket ? ' · ' + escHtmlAdmin(t.ket) : ''}</div>
              </div>
              <div class="tr-item-right">
                <span class="tr-item-nominal">${nom}</span>
                <div style="display:flex;gap:4px;justify-content:flex-end">
                  ${proofButton}
                  <span class="btn-edit-tr" data-admin-click="edit-transfer" data-transfer-id="${transferId}" title="Edit tanggal, nominal, atau catatan transfer"><i class="bi bi-pencil"></i> Edit</span>
                  <span class="btn-split-item" data-admin-click="split-transfer" data-transfer-id="${transferId}" title="Gunakan bila satu bukti transfer mencakup beberapa tanggal NONCOD"><i class="bi bi-scissors"></i> Split Tgl</span>
                  <span class="btn-del-tr" data-admin-click="delete-transfer" data-transfer-id="${transferId}" title="Hapus row transfer yang duplikat atau salah input"><i class="bi bi-trash3"></i> Hapus</span>
                </div>
              </div>
            </div>
          </div>`;
        }).join('');
      }

      function startEditTr(t) {
        if (!t || !t.id) return;
        const item = document.getElementById('tri-' + t.id);
        if (!item) return;
        const tglVal = normTgl(t.tgl_inputan);
        const nominalVal = Math.round(Number(t.nominal || 0));
        const ketVal = escHtmlAdmin(t.ket || '');
        item.classList.add('tr-editing');
        // Ganti main row jadi non-interactive
        item.querySelector('.tr-item-main').style.opacity = '0.6';
        item.querySelector('.tr-item-main').style.pointerEvents = 'none';
        // Inject edit bar
        const bar = document.createElement('div');
        bar.className = 'tr-edit-bar';
        bar.id = 'tr-edit-bar-' + t.id;
        bar.innerHTML = `
          <span class="tr-edit-label"><i class="bi bi-pencil me-1"></i>Edit Transfer</span>
          <input type="date" id="tr-edit-tgl-${t.id}" value="${tglVal}">
          <input type="number" id="tr-edit-nom-${t.id}" value="${nominalVal}" min="1" step="1" inputmode="numeric" placeholder="Nominal">
          <input type="text" id="tr-edit-ket-${t.id}" value="${ketVal}" placeholder="Keterangan (opsional)">
          <div class="tr-edit-actions">
            <button class="tr-ebtn tr-ebtn-save" type="button" data-admin-click="save-edit-transfer" data-transfer-id="${t.id}"><i class="bi bi-check-lg"></i> Simpan</button>
            <button class="tr-ebtn tr-ebtn-cancel" type="button" data-admin-click="cancel-edit-transfer" data-transfer-id="${t.id}">Batal</button>
          </div>`;
        item.appendChild(bar);
        document.getElementById('tr-edit-tgl-' + t.id).focus();
      }

      function cancelEditTr(id) {
        const item = document.getElementById('tri-' + id);
        if (!item) return;
        item.classList.remove('tr-editing');
        item.querySelector('.tr-item-main').style.opacity = '';
        item.querySelector('.tr-item-main').style.pointerEvents = '';
        const bar = document.getElementById('tr-edit-bar-' + id);
        if (bar) bar.remove();
      }

      async function saveEditTr(id) {
        const tgl = document.getElementById('tr-edit-tgl-' + id).value;
        const nominal = document.getElementById('tr-edit-nom-' + id).value;
        const ket = document.getElementById('tr-edit-ket-' + id).value;
        if (!tgl) { showToast('Tanggal tidak boleh kosong', 'error'); return; }
        if (!(Number(nominal) > 0)) { showToast('Nominal harus lebih dari 0', 'error'); return; }
        const saveBtn = document.querySelector(`#tr-edit-bar-${id} .tr-ebtn-save`);
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
        try {
          const res = await fetch('/api/transfer', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': getOpsToken() },
            body: JSON.stringify({ id, tgl_inputan: tgl, nominal, ket }),
          });
          const json = await res.json();
          if (!res.ok) { showToast(json.error || 'Gagal menyimpan', 'error'); }
          else {
            showToast('Data transfer diperbarui', 'success');
            cancelEditTr(id);
            await loadTransfers({ forceRefresh: true, silent: true, resetFilters: false });
            await refreshAdminViewsAfterWrite({ source: 'admin_transfer_edit' });
          }
        } catch { showToast('Kesalahan jaringan', 'error'); }
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> Simpan';
      }

      // ── Split ──
      function openSplit(t) {
        if (!t || !t.id) return;
        splitTarget = t;
        const suggestion = splitSuggestionsByTransferId[String(t.id)] || null;
        const tgl = normTgl(t.tgl_inputan);
        const tglDisplay = tgl ? new Date(tgl + 'T00:00:00').toLocaleDateString('id-ID', { day:'2-digit', month:'2-digit', year:'numeric' }) : '-';
        const nom = parseFloat(t.nominal).toLocaleString('id-ID');
        document.getElementById('splitOrigInfo').innerHTML = `
          <div style="width:30px;height:30px;border-radius:8px;background:rgba(19,27,46,0.08);color:#131b2e;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="bi bi-geo-alt-fill"></i></div>
          <div class="so-body">
            <div class="so-cabang">${escHtmlAdmin(t.nama_cabang)}</div>
            <div class="so-sub">${escHtmlAdmin(t.nama_bank)} · Tgl input saat ini: ${tglDisplay}</div>
          </div>
          <div class="so-nom">Rp ${nom}</div>`;
        const suggestionEl = document.getElementById('splitSuggestionInfo');
        if (suggestionEl) suggestionEl.innerHTML = renderSplitSuggestionHtml(suggestion);
        const list = document.getElementById('rincianList');
        list.innerHTML = '';
        if (suggestion && suggestion.dates && suggestion.dates.length > 1) {
          suggestion.dates.forEach(item => addRincianRow(item.date, item.ongkir));
        } else {
          addRincianRow(tgl, '');
          addRincianRow('', '');
        }
        updateSisa();
        document.getElementById('splitOverlay').classList.add('show');
      }

      function closeSplit() {
        document.getElementById('splitOverlay').classList.remove('show');
        const suggestionEl = document.getElementById('splitSuggestionInfo');
        if (suggestionEl) suggestionEl.innerHTML = '';
        splitTarget = null;
      }

      function addRincianRow(tgl = '', nominal = '') {
        const div = document.createElement('div');
        div.className = 'rincian-row';
        div.innerHTML = `
          <input type="date" value="${tgl}" title="Tanggal NONCOD yang dibebankan" aria-label="Tanggal NONCOD yang dibebankan" data-admin-input="update-sisa">
          <input type="number" placeholder="Nominal rincian" value="${nominal}" title="Nominal untuk tanggal ini" aria-label="Nominal untuk tanggal ini" data-admin-input="update-sisa" min="1">
          <button class="btn-del-row" type="button" data-admin-click="delete-rincian-row" title="Hapus rincian tanggal"><i class="bi bi-trash3"></i></button>`;
        document.getElementById('rincianList').appendChild(div);
        updateSisa();
      }

      function delRincianRow(btn) {
        btn.closest('.rincian-row').remove();
        updateSisa();
      }

      function updateSisa() {
        if (!splitTarget) return;
        const total = parseFloat(splitTarget.nominal);
        const inputs = document.querySelectorAll('#rincianList input[type=number]');
        const sum = Array.from(inputs).reduce((s, i) => s + (parseFloat(i.value) || 0), 0);
        const bar = document.getElementById('sisaBar');
        const diff = Math.round((total - sum) * 100) / 100;
        const btn = document.getElementById('btnSplitConfirm');
        if (diff === 0) {
          bar.className = 'sisa-bar';
          bar.innerHTML = `<span class="sb-label"><i class="bi bi-check-circle-fill me-1"></i>Siap disimpan untuk sinkron ke NONCOD</span><span class="sb-val">Rp ${total.toLocaleString('id-ID')} ✓</span>`;
          btn.disabled = false;
        } else if (diff > 0) {
          bar.className = 'sisa-bar danger';
          bar.innerHTML = `<span class="sb-label"><i class="bi bi-exclamation-triangle-fill me-1"></i>Nominal belum habis dibagi</span><span class="sb-val">Rp ${diff.toLocaleString('id-ID')}</span>`;
          btn.disabled = true;
        } else {
          bar.className = 'sisa-bar danger';
          bar.innerHTML = `<span class="sb-label"><i class="bi bi-exclamation-triangle-fill me-1"></i>Nominal rincian melebihi transfer asli</span><span class="sb-val">+Rp ${Math.abs(diff).toLocaleString('id-ID')}</span>`;
          btn.disabled = true;
        }
      }

      async function doSplit() {
        if (!splitTarget) return;
        const rows = Array.from(document.querySelectorAll('#rincianList .rincian-row')).map(row => {
          const inputs = row.querySelectorAll('input');
          return { tgl_inputan: inputs[0].value, nominal: parseFloat(inputs[1].value) || 0 };
        });
        const btn = document.getElementById('btnSplitConfirm');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Menyinkronkan...';
        try {
          const res = await fetch('/api/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': getOpsToken() }, body: JSON.stringify({ action: 'split', id: splitTarget.id, rows }) });
          const json = await res.json();
          if (!res.ok) { showToast(json.error || 'Gagal sinkronkan tanggal', 'error'); }
          else {
            showToast('Sinkronisasi berhasil (' + json.inserted + ' baris)', 'success');
            closeSplit();
            await loadTransfers({ forceRefresh: true, silent: true, resetFilters: false });
            await refreshAdminViewsAfterWrite({ source: 'admin_transfer_split' });
          }
        } catch { showToast('Kesalahan jaringan', 'error'); }
        btn.innerHTML = '<i class="bi bi-scissors me-1"></i>Simpan Sinkronisasi';
        btn.disabled = false;
      }

      function getMonitorPeriode() {
        return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar', year: 'numeric', month: '2-digit' }).slice(0, 7);
      }

      function getPeriodeLabel(periode) {
        if (!periode || !/^\d{4}-\d{2}$/.test(periode)) return '-';
        const [year, month] = periode.split('-');
        return BULAN_ID[parseInt(month, 10) - 1] + ' ' + year;
      }

      function renderSplitSuggestionHtml(suggestion) {
        if (!suggestion || !Array.isArray(suggestion.dates) || suggestion.dates.length <= 1) return '';
        const diffTotal = Math.abs(toNominal(suggestion.transferTotal) - toNominal(suggestion.total));
        let html = '<div class="split-table"><div class="split-title"><i class="bi bi-lightbulb"></i> Kemungkinan gabungan ' + suggestion.dates.length + ' tanggal NONCOD</div><table><thead><tr><th>Tanggal</th><th style="text-align:right">NONCOD</th></tr></thead><tbody>';
        suggestion.dates.forEach(item => {
          html += '<tr><td>' + fmtTanggalId(item.date) + '</td><td style="text-align:right">Rp ' + toNominal(item.ongkir).toLocaleString('id-ID') + '</td></tr>';
        });
        html += '<tr class="split-total"><td><b>Total</b></td><td style="text-align:right"><b>Rp ' + toNominal(suggestion.total).toLocaleString('id-ID') + '</b></td></tr>';
        if (diffTotal > 0) {
          html += '<tr><td>Selisih</td><td style="text-align:right">Rp ' + diffTotal.toLocaleString('id-ID') + '</td></tr>';
        }
        html += '</tbody></table></div>';
        return html;
      }

      function fmtTanggalId(ymd) {
        if (!ymd) return '-';
        return new Date(ymd + 'T00:00:00').toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
      }

      function getTodayYmdWita() {
        return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });
      }

      function toNominal(val) {
        return Math.round(parseFloat(val) || 0);
      }

      function buildPendingAllocationItems(pendingData) {
        const rows = Array.isArray(pendingData && pendingData.rows) ? pendingData.rows : [];
        return rows
          .map((row) => ({
            transferId: String(row && row.root_transfer_id || '').trim(),
            cabang: String(row && row.cabang || '').trim(),
            afterDate: normTgl(row && row.after_date),
            nominal: toNominal(row && row.nominal),
            transferBank: String(row && row.transfer_bank || '').trim(),
            reason: String(row && row.reason || '').trim(),
            createdAt: String(row && row.created_at || '').trim(),
          }))
          .filter((row) => row.transferId && row.cabang && row.afterDate && row.nominal > 0)
          .sort((a, b) => b.nominal - a.nominal || a.afterDate.localeCompare(b.afterDate) || a.cabang.localeCompare(b.cabang));
      }

      function buildMismatchState(periode, ncData, trData, pendingData) {
        const ADMIN_TRANSFER_FEE_TOLERANCE = 500;
        const ncByDay = ncData.byDay || {};
        const transferRows = Array.isArray(trData.transfers) ? trData.transfers : [];
        const ncByCabangDate = {};
        const trByCabangDate = {};
        const trRowsByCabangDate = {};
        const todayYmd = getTodayYmdWita();

        Object.keys(ncByDay).forEach(date => {
          if (!String(date).startsWith(periode + '-')) return;
          const cabangMap = ncByDay[date] || {};
          Object.keys(cabangMap).forEach(cabang => {
            const nominal = toNominal(cabangMap[cabang] && cabangMap[cabang].ongkir);
            if (nominal <= 0) return;
            if (!ncByCabangDate[cabang]) ncByCabangDate[cabang] = {};
            ncByCabangDate[cabang][date] = nominal;
          });
        });

        transferRows.forEach(row => {
          const cabang = String(row.nama_cabang || '').trim();
          const date = normTgl(row.tgl_inputan);
          const nominal = toNominal(row.nominal);
          if (!cabang || !date || nominal <= 0) return;
          if (!trByCabangDate[cabang]) trByCabangDate[cabang] = {};
          if (!trRowsByCabangDate[cabang]) trRowsByCabangDate[cabang] = {};
          trByCabangDate[cabang][date] = (trByCabangDate[cabang][date] || 0) + nominal;
          if (!trRowsByCabangDate[cabang][date]) trRowsByCabangDate[cabang][date] = [];
          trRowsByCabangDate[cabang][date].push(row);
        });

        const cabangSet = new Set([...Object.keys(ncByCabangDate), ...Object.keys(trByCabangDate)]);
  const pendingAllocations = buildPendingAllocationItems(pendingData);
        const suspects = [];
        const pendingCases = [];
        const mismatchCases = [];

        cabangSet.forEach(cabang => {
          const ncDates = ncByCabangDate[cabang] || {};
          const trDates = trByCabangDate[cabang] || {};
          const allDates = [...new Set([...Object.keys(ncDates), ...Object.keys(trDates)])].sort();
          const shortages = [];
          const extras = [];

          allDates.forEach(date => {
            const noncod = toNominal(ncDates[date] || 0);
            const transfer = toNominal(trDates[date] || 0);
            const diff = noncod - transfer;
            if (diff > 0) shortages.push({ date, amount: diff, noncod, transfer });
            if (diff < 0) {
              const extraAmount = Math.abs(diff);
              if (noncod > 0 && extraAmount <= ADMIN_TRANSFER_FEE_TOLERANCE) return;
              extras.push({ date, amount: extraAmount, noncod, transfer });
            }
          });

          const usedShort = new Set();
          const usedExtra = new Set();
          extras.forEach((extra, extraIndex) => {
            const shortIndex = shortages.findIndex((short, idx) => !usedShort.has(idx) && short.amount === extra.amount);
            if (shortIndex === -1) return;

            const target = shortages[shortIndex];
            const rows = ((trRowsByCabangDate[cabang] || {})[extra.date] || []).filter(row => toNominal(row.nominal) === extra.amount);
            const exactRow = rows.length === 1 ? rows[0] : null;

            usedShort.add(shortIndex);
            usedExtra.add(extraIndex);

            suspects.push({
              cabang,
              nominal: extra.amount,
              transferDate: extra.date,
              targetDate: target.date,
              transferId: exactRow ? exactRow.id : '',
              transferBank: exactRow ? (exactRow.nama_bank || '') : '',
            });
          });

          extras.forEach((extra, index) => {
            if (usedExtra.has(index)) return;
            // Detect multi-date split: can the transfer amount cover this date + some unpaid shortages?
            let splitSuggestion = null;
            const dateRows = (trRowsByCabangDate[cabang] || {})[extra.date] || [];
            const matchedTransferRows = dateRows.filter(row => toNominal(row.nominal) === toNominal(extra.transfer));
            const splitRow = matchedTransferRows.length === 1
              ? matchedTransferRows[0]
              : (dateRows.length === 1 ? dateRows[0] : null);
            const unusedShortages = shortages.filter((s, i) => !usedShort.has(i)).sort((a, b) => a.date.localeCompare(b.date));
            if (unusedShortages.length > 0) {
              // Try to find combination of NONCOD dates that sum to transfer amount (within tolerance)
              const ncThisDate = toNominal(extra.noncod);
              const transferTotal = toNominal(extra.transfer);
              const splitDates = [];
              if (ncThisDate > 0) splitDates.push({ date: extra.date, ongkir: ncThisDate });
              let runningTotal = ncThisDate;
              for (const s of unusedShortages) {
                if (s.date === extra.date) continue;
                splitDates.push({ date: s.date, ongkir: s.noncod });
                runningTotal += s.noncod;
                if (Math.abs(runningTotal - transferTotal) <= ADMIN_TRANSFER_FEE_TOLERANCE) {
                  splitSuggestion = { dates: splitDates.slice(), total: runningTotal, transferTotal };
                  break;
                }
                if (runningTotal > transferTotal + ADMIN_TRANSFER_FEE_TOLERANCE) break;
              }
            }
            mismatchCases.push({
              kind: 'transfer',
              cabang,
              date: extra.date,
              nominal: extra.amount,
              noncod: extra.noncod,
              transfer: extra.transfer,
              filterDate: extra.date,
              transferId: splitRow ? splitRow.id : '',
              splitSuggestion,
              hint: splitSuggestion
                ? 'Kemungkinan pembayaran gabungan beberapa tanggal.'
                : extra.noncod > 0
                  ? 'Transfer lebih besar dari NONCOD di tanggal ini.'
                  : 'Ada transfer, tetapi NONCOD tanggal ini kosong.'
            });
          });

          shortages.forEach((short, index) => {
            if (usedShort.has(index)) return;
            if (short.date >= todayYmd) return;
            const targetList = short.transfer > 0 ? mismatchCases : pendingCases;
            targetList.push({
              kind: 'noncod',
              cabang,
              date: short.date,
              nominal: short.amount,
              noncod: short.noncod,
              transfer: short.transfer,
              canUploadPending: short.transfer <= 0,
              filterDate: short.transfer > 0 ? short.date : '',
              hint: short.transfer > 0
                ? 'Nominal transfer belum menutup total NONCOD.'
                : 'NONCOD sudah ada, tetapi transfer belum masuk di tanggal ini.'
            });
          });
        });

        suspects.sort((a, b) => b.nominal - a.nominal || a.transferDate.localeCompare(b.transferDate) || a.cabang.localeCompare(b.cabang));
        pendingCases.sort((a, b) => b.nominal - a.nominal || a.date.localeCompare(b.date) || a.cabang.localeCompare(b.cabang));
        mismatchCases.sort((a, b) => b.nominal - a.nominal || a.date.localeCompare(b.date) || a.cabang.localeCompare(b.cabang));

        return { pendingAllocations, suspects, pendingCases, mismatchCases, periode };
      }

      function renderMonitorAction(periode, cabang, filterDate, transferId, action, label, className) {
        const encodedCabang = encodeURIComponent(cabang || '');
        const icon = action === 'edit' ? 'pencil' : (action === 'split' ? 'scissors' : 'search');
        return `<span class="${className}" data-admin-click="open-transfer-review" data-periode="${periode}" data-cabang="${encodedCabang}" data-filter-date="${filterDate || ''}" data-transfer-id="${transferId || ''}" data-review-action="${action || ''}"><i class="bi bi-${icon}"></i> ${label}</span>`;
      }

      async function clearPendingAllocation(encodedTransferId) {
        const transferId = decodeURIComponent(encodedTransferId || '');
        if (!transferId) return;
        if (!confirm('Hapus pending tempel NONCOD ini?')) return;

        try {
          const res = await fetch('/api/transfer?pending_allocation=1&transfer_id=' + encodeURIComponent(transferId), {
            method: 'DELETE',
            headers: { 'X-Admin-Token': getOpsToken() }
          });
          const json = await res.json();
          if (!res.ok) {
            showToast(json.error || 'Gagal menghapus pending tempel NONCOD', 'error');
            return;
          }
          showToast('Pending tempel NONCOD dihapus', 'success');
          await refreshAdminViewsAfterWrite({ source: 'admin_pending_allocation_delete' });
        } catch {
          showToast('Kesalahan jaringan', 'error');
        }
      }

      function renderPendingAllocationItem(item, periode) {
        const reviewAction = renderMonitorAction(periode, item.cabang, item.afterDate, item.transferId, 'edit', 'Cek Transfer', 'btn-edit-tr');
        const clearAction = `<span class="btn-del-tr" data-admin-click="clear-pending-allocation" data-transfer-id="${encodeURIComponent(item.transferId || '')}"><i class="bi bi-x-circle"></i> Hapus Pending</span>`;

        return `<div class="mon-item">
          <div class="mon-item-left">
            <div class="mon-dot teal"></div>
            <div class="mon-info">
              <div class="mon-name">${escHtmlAdmin(item.cabang)}</div>
              <div class="mon-meta">Menunggu NONCOD setelah ${fmtTanggalId(item.afterDate)}${item.transferBank ? ' · ' + escHtmlAdmin(item.transferBank) : ''}</div>
              <div class="mon-meta">${escHtmlAdmin(item.reason || 'Sisa nominal akan ditempel otomatis saat NONCOD baru tersedia.')}</div>
            </div>
          </div>
          <div class="mon-right">
            <div class="mon-nom teal">Rp ${item.nominal.toLocaleString('id-ID')}</div>
            <div class="mon-actions">${reviewAction}${clearAction}</div>
          </div>
        </div>`;
      }

      function renderSuspectItem(item, periode) {
        const actionHtml = item.transferId
          ? renderMonitorAction(periode, item.cabang, item.transferDate, item.transferId, 'edit', 'Edit Tgl', 'btn-edit-tr')
          : renderMonitorAction(periode, item.cabang, item.transferDate, '', '', 'Cek Transfer', 'btn-split-item');
        const detailHint = 'Nominalnya sama dengan kekurangan NONCOD tanggal ' + fmtTanggalId(item.targetDate) + '. Cek apakah transfer ini perlu dipindah atau di-split.';

        return `<div class="mon-item">
          <div class="mon-item-left">
            <div class="mon-dot amber"></div>
            <div class="mon-info">
              <div class="mon-name">${escHtmlAdmin(item.cabang)}</div>
              <div class="mon-meta">Kelebihan transfer Rp ${item.nominal.toLocaleString('id-ID')} tercatat ${fmtTanggalId(item.transferDate)}${item.transferBank ? ' · ' + escHtmlAdmin(item.transferBank) : ''} dan nominalnya sama dengan kekurangan NONCOD ${fmtTanggalId(item.targetDate)}</div>
              <div class="mon-meta">${escHtmlAdmin(detailHint)}</div>
            </div>
          </div>
          <div class="mon-right">
            <div class="mon-nom amber">Rp ${item.nominal.toLocaleString('id-ID')}</div>
            <div class="mon-actions">${actionHtml}</div>
          </div>
        </div>`;
      }

      function renderPendingCaseItem(item, periode) {
        const actionHtml = renderMonitorAction(periode, item.cabang, '', '', '', 'Buka Transfer', 'btn-edit-tr');
        const uploadAction = item.canUploadPending
          ? `<span class="btn-approve-h1" data-admin-click="open-admin-carry-upload-from-case" data-cabang="${encodeURIComponent(item.cabang || '')}" data-date="${item.date}" data-nominal="${item.nominal}"><i class="bi bi-cloud-arrow-up"></i> Upload Split</span>`
          : '';
        const hint = item.canUploadPending
          ? item.hint + ' Jika bukti ini perlu langsung ditempel ke tanggal ini dan sisanya menunggu NONCOD berikutnya, pakai Upload Split.'
          : item.hint;

        return `<div class="mon-item">
          <div class="mon-item-left">
            <div class="mon-dot blue"></div>
            <div class="mon-info">
              <div class="mon-name">${escHtmlAdmin(item.cabang)}</div>
              <div class="mon-meta">NONCOD ${fmtTanggalId(item.date)} · NONCOD Rp ${item.noncod.toLocaleString('id-ID')} · Transfer Rp ${item.transfer.toLocaleString('id-ID')}</div>
              <div class="mon-meta">${escHtmlAdmin(hint)}</div>
            </div>
          </div>
          <div class="mon-right">
            <div class="mon-nom blue">Rp ${item.nominal.toLocaleString('id-ID')}</div>
            <div class="mon-actions">${actionHtml}${uploadAction}</div>
          </div>
        </div>`;
      }

      function renderOpenCaseItem(item, periode) {
        const canSplit = item.kind === 'transfer' && item.transferId && item.splitSuggestion && item.splitSuggestion.dates.length > 1;
        const label = canSplit ? 'Split Tgl' : (item.kind === 'transfer' ? 'Cek Transfer' : 'Buka Transfer');
        const actionHtml = canSplit
          ? renderMonitorAction(periode, item.cabang, item.filterDate, item.transferId, 'split', label, 'btn-split-item')
          : renderMonitorAction(periode, item.cabang, item.filterDate, '', '', label, 'btn-edit-tr');
        const meta = item.kind === 'transfer'
          ? `Transfer ${fmtTanggalId(item.date)} · NONCOD Rp ${item.noncod.toLocaleString('id-ID')} · Transfer Rp ${item.transfer.toLocaleString('id-ID')}`
          : `NONCOD ${fmtTanggalId(item.date)} · NONCOD Rp ${item.noncod.toLocaleString('id-ID')} · Transfer Rp ${item.transfer.toLocaleString('id-ID')}`;

        const displayNominal = (item.splitSuggestion && item.splitSuggestion.dates.length > 1)
          ? Math.abs(item.splitSuggestion.transferTotal - item.splitSuggestion.total)
          : item.nominal;
        const nomClass = displayNominal === 0 ? 'green' : 'red';

        return `<div class="mon-item">
          <div class="mon-item-left">
            <div class="mon-dot ${nomClass}"></div>
            <div class="mon-info">
              <div class="mon-name">${escHtmlAdmin(item.cabang)}</div>
              <div class="mon-meta">${meta}</div>
              <div class="mon-meta">${escHtmlAdmin(item.hint)}</div>
            </div>
          </div>
          <div class="mon-right">
            <div class="mon-nom ${nomClass}">${displayNominal === 0 ? '✓ Cocok' : 'Rp ' + displayNominal.toLocaleString('id-ID')}</div>
            <div class="mon-actions">${actionHtml}</div>
          </div>
        </div>`;
      }

      function renderMismatchMonitorSnapshot(snapshot) {
        const contentEl = document.getElementById('mismatchContent');
        const sumEl = document.getElementById('mismatchSummary');
        const periode = snapshot && snapshot.periode ? snapshot.periode : getMonitorPeriode();
        document.getElementById('mismatchDateLabel').textContent = getPeriodeLabel(periode) + ' · cek selisih NONCOD vs transfer';
        const mismatchState = buildMismatchState(periode, snapshot.ncData, snapshot.trData, snapshot.pendingData);
        splitSuggestionsByTransferId = {};
        transferLookupById = {};
        (snapshot.trData.transfers || []).forEach(item => {
          if (item && item.id) transferLookupById[String(item.id)] = item;
        });
        mismatchState.mismatchCases.forEach(item => {
          if (item.transferId && item.splitSuggestion && item.splitSuggestion.dates && item.splitSuggestion.dates.length > 1) {
            splitSuggestionsByTransferId[String(item.transferId)] = item.splitSuggestion;
          }
        });
        document.getElementById('mismatchSuspect').textContent = mismatchState.suspects.length;
        document.getElementById('mismatchOpen').textContent = mismatchState.mismatchCases.length + mismatchState.pendingCases.length + mismatchState.pendingAllocations.length;
        sumEl.style.display = 'grid';
        let html = '<div class="today-body">';

        html += `<div class="today-sec amber"><i class="bi bi-calendar-event"></i>Indikasi Kelebihan vs Kekurangan <span class="sec-badge">${mismatchState.suspects.length}</span></div>`;
        if (!mismatchState.suspects.length) {
          html += '<div class="mon-empty">Belum ada kandidat kelebihan transfer yang nilainya sama dengan kekurangan NONCOD di tanggal lain.</div>';
        } else {
          mismatchState.suspects.forEach(item => { html += renderSuspectItem(item, periode); });
        }

        html += `<div class="today-sec green"><i class="bi bi-hourglass-split"></i>Pending Tempel NONCOD <span class="sec-badge">${mismatchState.pendingAllocations.length}</span></div>`;
        if (!mismatchState.pendingAllocations.length) {
          html += '<div class="mon-empty">Belum ada nominal yang menunggu NONCOD baru untuk ditempel otomatis.</div>';
        } else {
          mismatchState.pendingAllocations.forEach(item => { html += renderPendingAllocationItem(item, periode); });
        }

        html += `<div class="today-sec blue"><i class="bi bi-hourglass-split"></i>Belum Transfer <span class="sec-badge">${mismatchState.pendingCases.length}</span></div>`;
        if (!mismatchState.pendingCases.length) {
          html += '<div class="mon-empty">Tidak ada NONCOD yang masih menunggu transfer.</div>';
        } else {
          mismatchState.pendingCases.forEach(item => { html += renderPendingCaseItem(item, periode); });
        }

        html += `<div class="today-sec red"><i class="bi bi-exclamation-triangle-fill"></i>Belum Cocok <span class="sec-badge">${mismatchState.mismatchCases.length}</span></div>`;
        if (!mismatchState.mismatchCases.length) {
          html += '<div class="mon-empty">Semua data NONCOD dan transfer periode ini sudah cocok.</div>';
        } else {
          mismatchState.mismatchCases.forEach(item => { html += renderOpenCaseItem(item, periode); });
        }

        html += '</div>';
        contentEl.innerHTML = html;
      }

      async function loadMismatchMonitor(options = {}) {
        const { forceRefresh = false, silent = false } = options;
        const contentEl = document.getElementById('mismatchContent');
        const sumEl = document.getElementById('mismatchSummary');
        const refreshBtn = document.getElementById('mismatchRefreshBtn');
        const periode = getMonitorPeriode();
        const cachedSnapshot = monitorDataCache && monitorDataCache.periode === periode ? monitorDataCache : null;

        if (refreshBtn) refreshBtn.classList.add('spinning');
        if (!cachedSnapshot && !silent) {
          contentEl.innerHTML = '<div class="empty-state" style="padding:16px 0"><span class="spinner-border spinner-border-sm"></span></div>';
          sumEl.style.display = 'none';
        } else if (cachedSnapshot) {
          renderMismatchMonitorSnapshot(cachedSnapshot);
        }

        try {
          const snapshot = await fetchMonitorSnapshot(periode, { forceRefresh: forceRefresh || !cachedSnapshot });
          renderMismatchMonitorSnapshot(snapshot);
        } catch (err) {
          if (cachedSnapshot) {
            if (!silent) showToast(err.message || 'Gagal memuat data', 'error');
            return;
          }
          monitorDataCache = null;
          contentEl.innerHTML = '<div class="empty-state" style="padding:16px 0"><i class="bi bi-exclamation-circle text-danger me-1"></i>' + escHtmlAdmin(err.message || 'Gagal memuat data') + '</div>';
          sumEl.style.display = 'none';
        } finally {
          if (refreshBtn) refreshBtn.classList.remove('spinning');
        }
      }

      // ── Utilities ──
      function escHtmlAdmin(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      }

      function showToast(msg, type = '') {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.className = 'toast-box show ' + type;
        setTimeout(() => t.className = 'toast-box', 2200);
      }

      initAdminEventBindings();

      // ── Date filter event (reliable cross-browser) ──
      document.getElementById('trSearchTgl').addEventListener('change', applyTrFilter);
      document.getElementById('trSearchTgl').addEventListener('input', applyTrFilter);

      // ── Session Guard ── (30-min timeout, admin only)
      (function() {
        if (!hasActiveSession('admin')) {
          try {
            if (window.top && window.top !== window.self) {
              window.top.location.replace('/dashboard.html');
              return;
            }
          } catch {}
          location.replace('/dashboard.html');
          return;
        }
        setInterval(() => {
          if (!hasActiveSession('admin')) {
            exitWorkspace();
          }
        }, 5000);
        notifyParentAdminEmbed('started');
        const bootstrapWatch = window.FrontendOpsReporter
          ? window.FrontendOpsReporter.watch('Admin loading lebih dari 20 detik', {
              action: 'admin_bootstrap_stalled',
              component: 'admin-panel',
              timeoutMs: 20000,
            })
          : null;
        ensureAdminBootstrap().catch(err => {
          if (window.FrontendOpsReporter) {
            window.FrontendOpsReporter.report(err, { action: 'admin_bootstrap', component: 'admin-panel' });
          }
        }).finally(() => {
          if (bootstrapWatch) bootstrapWatch.stop();
        });
      })();

let logData = [];

      async function openLogs() {
        document.getElementById('logOverlay').classList.add('show');
        document.getElementById('logBody').innerHTML = '<div class="log-empty"><span class="spinner-border spinner-border-sm me-2"></span>Memuat log...</div>';
        try {
          const res = await fetch('/api/auth?ops=logs&limit=200', {
            headers: { 'X-Admin-Token': getOpsToken() }
          });
          if (!res.ok) { document.getElementById('logBody').innerHTML = '<div class="log-empty">Gagal memuat log ('+res.status+')</div>'; return; }
          logData = await res.json();
          renderLogs();
        } catch { document.getElementById('logBody').innerHTML = '<div class="log-empty">Kesalahan jaringan</div>'; }
      }

      function renderLogs() {
        const el = document.getElementById('logBody');
        document.getElementById('logCount').textContent = logData.length ? '(' + logData.length + ')' : '';
        if (!logData.length) { el.innerHTML = '<div class="log-empty"><i class="bi bi-check-circle me-1"></i>Tidak ada error log</div>'; return; }
        el.innerHTML = logData.map(l => {
          const dt = new Date(l.created_at);
          const time = dt.toLocaleDateString('id-ID', {day:'2-digit',month:'short',year:'numeric'}) + ' ' + dt.toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
          let metaStr = '';
          try { const m = JSON.parse(l.meta||'{}'); metaStr = Object.entries(m).map(([k,v])=>k+': '+v).join(' · '); } catch {}
          return '<div class="log-item"><span class="log-time">' + escHtmlAdmin(time) + '</span><span class="log-src">' + escHtmlAdmin(l.source||'?') + '</span><div class="log-msg">' + escHtmlAdmin(l.message||'') + '</div>' + (metaStr ? '<div class="log-meta">' + escHtmlAdmin(metaStr) + '</div>' : '') + '</div>';
        }).join('');
      }

      function closeLogs() { document.getElementById('logOverlay').classList.remove('show'); }

      function downloadLogs() {
        if (!logData.length) { showToast('Tidak ada log', 'error'); return; }
        const lines = logData.map(l => {
          const dt = new Date(l.created_at).toISOString();
          let meta = '';
          try { const m = JSON.parse(l.meta||'{}'); meta = Object.entries(m).map(([k,v])=>k+'='+v).join(' '); } catch {}
          return dt + ' [' + (l.source||'?') + '] ' + (l.message||'') + (meta ? ' {' + meta + '}' : '');
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'error-log-' + new Date().toISOString().slice(0,10) + '.txt';
        a.click();
        URL.revokeObjectURL(a.href);
      }

      async function clearLogs() {
        if (!confirm('Hapus semua error log?')) return;
        try {
          const res = await fetch('/api/auth?ops=logs', { method: 'DELETE', headers: { 'X-Admin-Token': getOpsToken() } });
          if (res.ok) { logData = []; renderLogs(); showToast('Log dihapus', 'success'); }
          else { showToast('Gagal menghapus', 'error'); }
        } catch { showToast('Kesalahan jaringan', 'error'); }
      }

