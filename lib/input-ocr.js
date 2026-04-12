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
      const parseError = new Error('Server error (' + status + '). Coba lagi atau isi manual.');
      parseError.cause = err;
      throw parseError;
    }
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

    let busy = false;
    let cooldownUntil = 0;
    let filledState = {};

    function resetState() {
      busy = false;
      cooldownUntil = 0;
      filledState = {};
    }

    async function runOCR(base64DataUrl) {
      if (busy) {
        setStatus('error', 'Scan sedang berjalan, tunggu sebentar...');
        return;
      }

      const cooldownLeft = Math.ceil((cooldownUntil - now()) / 1000);
      if (cooldownLeft > 0) {
        setStatus('error', 'Tunggu ' + cooldownLeft + ' detik sebelum scan berikutnya.');
        showFields();
        return;
      }

      busy = true;
      filledState = {};
      setBadge('bankBadge', false);
      setBadge('nominalBadge', false);
      setStatus('scanning', 'Membaca bukti transfer...');

      try {
        const compressed = await compressImage(base64DataUrl, 800);
        const sizeKB = Math.round(compressed.length * 0.75 / 1024);
        if (sizeKB > 3500) {
          throw new Error('Gambar terlalu besar (' + sizeKB + 'KB). Gunakan screenshot yang lebih kecil.');
        }

        const response = await fetchImpl('/api/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: compressed }),
        });

        const text = await response.text();
        const json = parseOcrApiResponse(response.status, text);
        if (!response.ok) throw new Error(json.error || 'Gagal scan');

        let filled = 0;
        const bank = matchBank(json.channel);
        if (bank) {
          setBankValue(bank);
          filledState.bank = true;
          setBadge('bankBadge', true);
          filled += 1;
        }

        if (json.nominal !== null && json.nominal > 0) {
          setNominalValue(json.nominal);
          filledState.nominal = true;
          setBadge('nominalBadge', true);
          filled += 1;
        }

        onReadyChange();

        if (filled === 2) {
          setStatus('success', 'Bank & Nominal terisi otomatis — periksa & edit jika perlu');
        } else if (filled > 0) {
          const missing = [];
          if (!filledState.bank) missing.push('Bank');
          if (!filledState.nominal) missing.push('Nominal');
          setStatus('info', filled + ' field terisi — lengkapi ' + missing.join(', ') + ' secara manual');
        } else {
          setStatus('info', 'Bukti transfer terdeteksi — silahkan masukkan data manual');
        }

        showFields();
      } catch (err) {
        log('OCR error:', err);
        setStatus('error', 'Gagal scan: ' + (err.message || 'coba lagi'));
        showFields();
      } finally {
        busy = false;
        cooldownUntil = now() + 8000;
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
  };
});