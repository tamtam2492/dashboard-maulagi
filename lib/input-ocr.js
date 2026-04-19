(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.InputOcrModule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeBankNameInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const upper = raw.toUpperCase();
    const compact = upper.replace(/[^A-Z0-9]/g, '');
    if (['MTRANSFER', 'MTRANSFERBCA', 'MBCA', 'BCAMOBILE', 'MBANKINGBCA', 'MYBANK'].includes(compact)) return 'BCA';
    return upper;
  }

  function matchBank(channel) {
    if (!channel || channel === 'Unknown') return '';
    const normalizedChannel = String(channel).toUpperCase();
    const directMatch = normalizeBankNameInput(normalizedChannel);
    if (directMatch === 'BCA') return 'BCA';
    const banks = ['BCA', 'MANDIRI', 'BNI', 'BRI', 'BSI', 'DANA', 'OVO', 'GOPAY', 'SHOPEEPAY'];

    for (const bank of banks) {
      if (normalizedChannel.includes(bank)) return bank;
    }

    if (normalizedChannel.includes('LIVIN')) return 'MANDIRI';
    if (normalizedChannel.includes('BRIMO')) return 'BRI';
    if (normalizedChannel.includes('MYBANK') || normalizedChannel.includes('M-BANKING BCA') || normalizedChannel.includes('MBCA') || normalizedChannel.includes('BCA MOBILE')) return 'BCA';
    if (normalizedChannel.includes('BSI MOBILE')) return 'BSI';
    if (normalizedChannel.includes('BNI MOBILE') || normalizedChannel.includes('BNI M-BANKING')) return 'BNI';
    return String(channel);
  }

  function parseOcrApiResponse(status, text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      if (status === 504 || status === 408) {
        throw new Error('Server timeout — gambar mungkin terlalu besar. Coba screenshot yang lebih kecil.');
      }
      const parseError = new Error('Server error (' + status + '). Coba lagi dengan bukti yang lebih jelas.');
      parseError.cause = err;
      throw parseError;
    }
  }

  function encodeBytesToBase64(bytes) {
    if (typeof Buffer === 'function') {
      return Buffer.from(bytes).toString('base64');
    }

    if (typeof btoa === 'function') {
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }
      return btoa(binary);
    }

    throw new Error('Encoder base64 tidak tersedia.');
  }

  async function readFileAsDataUrl(file) {
    if (!file) throw new Error('File wajib diisi.');

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

    const mimeType = String(file.type || 'application/octet-stream').trim() || 'application/octet-stream';
    let arrayBuffer = null;

    if (typeof file.arrayBuffer === 'function') {
      arrayBuffer = await file.arrayBuffer();
    } else if (typeof Response === 'function') {
      arrayBuffer = await new Response(file).arrayBuffer();
    }

    if (!arrayBuffer) {
      throw new Error('Browser ini belum mendukung pembacaan file.');
    }

    const base64 = encodeBytesToBase64(new Uint8Array(arrayBuffer));
    return 'data:' + mimeType + ';base64,' + base64;
  }

  function delayWithSignal(waitMs, signal) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', handleAbort);
        resolve();
      }, waitMs);

      function handleAbort() {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', handleAbort);
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      }

      if (signal) {
        if (signal.aborted) {
          handleAbort();
          return;
        }
        signal.addEventListener('abort', handleAbort, { once: true });
      }
    });
  }

  function createInputOcrController(options) {
    const compressImage = options.compressImage;
    const fetchImpl = options.fetchImpl;
    const setStatus = options.setStatus;
    const showFields = options.showFields;
    const setBadge = options.setBadge;
    const setBankValue = options.setBankValue;
    const setNominalValue = options.setNominalValue;
    const onReadyChange = options.onReadyChange;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const log = typeof options.log === 'function' ? options.log : () => {};
    const pollIntervalMs = Math.max(0, Number(options.pollIntervalMs) || 1500);
    const maxPollMs = Math.max(1000, Number(options.maxPollMs) || 45000);

    let busy = false;
    let cooldownUntil = 0;
    let filledState = {};
    let activeRunId = 0;
    let activeAbortController = null;

    async function requestJson(url, requestOptions, signal) {
      const response = await fetchImpl(url, {
        ...(requestOptions || {}),
        signal,
      });
      const text = await response.text();
      const json = parseOcrApiResponse(response.status, text);
      return { response, json };
    }

    async function pollOcrJob(jobId, runId, signal) {
      const startedAt = now();

      while (true) {
        if (runId !== activeRunId) {
          return { ok: false, reason: 'stale' };
        }

        if (now() - startedAt > maxPollMs) {
          throw new Error('OCR terlalu lama diproses. Upload ulang bukti transfer.');
        }

        await delayWithSignal(pollIntervalMs, signal);

        const { response, json } = await requestJson(
          '/api/input?ocr=1&job_id=' + encodeURIComponent(jobId),
          { method: 'GET' },
          signal
        );

        if (runId !== activeRunId) {
          return { ok: false, reason: 'stale' };
        }

        if (!response.ok) {
          throw new Error(json.error || 'Gagal cek status OCR.');
        }

        const status = String(json.status || '').trim().toLowerCase();
        if (status === 'queued') {
          setStatus('scanning', 'Bukti diterima. Worker OCR sedang antre...');
          continue;
        }

        if (status === 'processing') {
          setStatus('scanning', 'Worker OCR sedang membaca bukti transfer...');
          continue;
        }

        if (status === 'succeeded') {
          return { ok: true, reason: 'success', result: json.result || null };
        }

        if (status === 'failed') {
          throw new Error(json.error || 'Gagal scan');
        }

        throw new Error('Status OCR tidak valid.');
      }
    }

    function resetState() {
      activeRunId += 1;
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
      busy = false;
      cooldownUntil = 0;
      filledState = {};
    }

    async function runOCR(base64DataUrl, runOptions = {}) {
      const force = !!(runOptions && runOptions.force);

      if (busy && !force) {
        setStatus('error', 'Scan sedang berjalan, tunggu sebentar...');
        return { ok: false, reason: 'busy' };
      }

      const cooldownLeft = Math.ceil((cooldownUntil - now()) / 1000);
      if (cooldownLeft > 0 && !force) {
        setStatus('error', 'Tunggu ' + cooldownLeft + ' detik sebelum scan berikutnya.');
        showFields();
        return { ok: false, reason: 'cooldown' };
      }

      activeRunId += 1;
      const runId = activeRunId;
      if (activeAbortController) {
        activeAbortController.abort();
      }
      activeAbortController = typeof AbortController === 'function' ? new AbortController() : null;

      busy = true;
      filledState = {};
      setBadge('bankBadge', false);
      setBadge('nominalBadge', false);
      setStatus('scanning', 'Mengirim bukti ke worker OCR...');

      try {
        const compressed = await compressImage(base64DataUrl, 800);
        const sizeKB = Math.round(compressed.length * 0.75 / 1024);
        if (sizeKB > 3500) {
          throw new Error('Gambar terlalu besar (' + sizeKB + 'KB). Gunakan screenshot yang lebih kecil.');
        }

        const { response, json } = await requestJson('/api/input?ocr=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: compressed }),
        }, activeAbortController ? activeAbortController.signal : undefined);

        if (runId !== activeRunId) {
          return { ok: false, reason: 'stale' };
        }

        if (!response.ok) throw new Error(json.error || 'Gagal scan');

        if (!json.jobId) {
          throw new Error('Job OCR tidak valid.');
        }

        setStatus('scanning', 'Bukti diterima. Worker OCR sedang memproses...');

        const polled = await pollOcrJob(
          json.jobId,
          runId,
          activeAbortController ? activeAbortController.signal : undefined
        );

        if (!polled.ok) {
          return polled;
        }

        const ocrResult = polled.result || {};

        let filled = 0;
        const bank = matchBank(ocrResult.channel);
        if (bank) {
          setBankValue(bank);
          filledState.bank = true;
          setBadge('bankBadge', true);
          filled += 1;
        }

        if (ocrResult.nominal !== null && ocrResult.nominal > 0) {
          setNominalValue(ocrResult.nominal);
          filledState.nominal = true;
          setBadge('nominalBadge', true);
          filled += 1;
        }

        onReadyChange();

        if (filled === 2) {
          setStatus('success', 'Bank & nominal berhasil dibaca. Sistem siap lanjut mencocokkan NONCOD.');
        } else if (filled > 0) {
          const missing = [];
          if (!filledState.bank) missing.push('Bank');
          if (!filledState.nominal) missing.push('Nominal');
          setStatus('info', 'OCR belum lengkap: ' + missing.join(', ') + ' belum terbaca. Upload ulang bukti yang lebih jelas.');
        } else {
          setStatus('info', 'OCR belum bisa membaca data transfer. Upload ulang bukti yang lebih jelas.');
        }

        showFields();
        return {
          ok: filled === 2,
          reason: filled === 2 ? 'success' : 'partial',
          filledState: { ...filledState },
        };
      } catch (err) {
        if (err && err.name === 'AbortError') {
          return { ok: false, reason: 'aborted' };
        }
        log('OCR error:', err);
        setStatus('error', 'Gagal scan: ' + (err.message || 'coba lagi'));
        showFields();
        return { ok: false, reason: 'error', error: err };
      } finally {
        if (runId === activeRunId) {
          busy = false;
          activeAbortController = null;
          cooldownUntil = now() + 8000;
        }
      }
    }

    return {
      getFilledState: () => ({ ...filledState }),
      resetState,
      runOCR,
    };
  }

  return {
    createInputOcrController,
    matchBank,
    normalizeBankNameInput,
    parseOcrApiResponse,
    readFileAsDataUrl,
  };
});