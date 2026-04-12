(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.NoncodAggregation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PERIODE_RE = /^\d{4}-\d{2}$/;

  function buildDateRange(from, to) {
    const dates = [];
    if (!from || !to) return dates;
    let current = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    const pad = n => String(n).padStart(2, '0');

    while (current <= end) {
      dates.push(current.getFullYear() + '-' + pad(current.getMonth() + 1) + '-' + pad(current.getDate()));
      current.setDate(current.getDate() + 1);
    }

    return dates;
  }

  function getPeriodeDateRange(periode) {
    if (!PERIODE_RE.test(String(periode || ''))) return [];
    const [year, month] = String(periode).split('-').map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    return buildDateRange(
      periode + '-01',
      periode + '-' + String(lastDay).padStart(2, '0')
    );
  }

  function getScopedDates(dates, periode) {
    const prefix = periode ? periode + '-' : '';
    return Array.from(new Set((dates || []).filter(date => !prefix || String(date).startsWith(prefix)))).sort();
  }

  function getAggregatedRekonBaseRows(options) {
    const dates = options && options.dates;
    const periode = options && options.periode;
    const ncByDay = (options && options.ncByDay) || {};
    const trByCabang = (options && options.trByCabang) || {};
    const scopedDates = getScopedDates(dates, periode);
    const aggregatedNoncod = {};
    const aggregatedTransfer = {};

    for (const selectedDate of scopedDates) {
      const ncDay = ncByDay[selectedDate] || {};
      for (const cabang in ncDay) {
        if (!cabang || cabang === '-') continue;
        if (!aggregatedNoncod[cabang]) aggregatedNoncod[cabang] = { ongkir: 0, resi: 0 };
        aggregatedNoncod[cabang].ongkir += Number(ncDay[cabang].ongkir || 0);
        aggregatedNoncod[cabang].resi += Number(ncDay[cabang].resi || 0);
      }

      for (const cabang in trByCabang) {
        if (!cabang || cabang === '-') continue;
        const transferList = Array.isArray(trByCabang[cabang] && trByCabang[cabang].list)
          ? trByCabang[cabang].list
          : [];
        const sameDateTransfers = transferList.filter(item => item.periode === periode && item.tglRaw === selectedDate);
        if (!sameDateTransfers.length) continue;
        if (!aggregatedTransfer[cabang]) aggregatedTransfer[cabang] = 0;
        aggregatedTransfer[cabang] += sameDateTransfers.reduce((sum, item) => sum + Number(item.nominal || 0), 0);
      }
    }

    return [...new Set([...Object.keys(aggregatedNoncod), ...Object.keys(aggregatedTransfer)])].map(cabang => {
      const ongkir = aggregatedNoncod[cabang] ? aggregatedNoncod[cabang].ongkir : 0;
      const resi = aggregatedNoncod[cabang] ? aggregatedNoncod[cabang].resi : 0;
      const transfer = aggregatedTransfer[cabang] || 0;
      return {
        cabang,
        resi,
        ongkir,
        transfer,
        belum: ongkir - transfer,
      };
    });
  }

  function filterRekonRows(baseRows, options) {
    const query = String(options && options.query || '').trim().toLowerCase();
    const status = options && options.status ? options.status : 'semua';
    const filterByArea = options && typeof options.filterByArea === 'function' ? options.filterByArea : null;

    return (baseRows || []).filter(row => {
      if (!row.cabang || row.cabang === '-') return false;
      if (filterByArea && !filterByArea(row.cabang)) return false;
      if (query && !String(row.cabang).toLowerCase().includes(query)) return false;
      if (status === 'sudah' && row.belum > 0) return false;
      if (status === 'belum' && row.belum <= 0) return false;
      return true;
    });
  }

  function getAggregatedShipmentRows(options) {
    const dates = options && options.dates;
    const periode = options && options.periode;
    const ncByDay = (options && options.ncByDay) || {};
    const scopedDates = getScopedDates(dates, periode);
    const aggregated = {};

    for (const selectedDate of scopedDates) {
      const shipDay = ncByDay[selectedDate] || {};
      for (const cabang in shipDay) {
        if (!cabang || cabang === '-') continue;
        if (!aggregated[cabang]) aggregated[cabang] = { resi: 0, ongkir: 0, total: 0 };
        aggregated[cabang].resi += Number(shipDay[cabang].resi || 0);
        aggregated[cabang].ongkir += Number(shipDay[cabang].ongkir || 0);
        aggregated[cabang].total += Number(shipDay[cabang].total || 0);
      }
    }

    return Object.keys(aggregated).map(cabang => ({
      cabang,
      resi: aggregated[cabang].resi,
      ongkir: aggregated[cabang].ongkir,
      total: aggregated[cabang].total,
    }));
  }

  return {
    buildDateRange,
    filterRekonRows,
    getAggregatedRekonBaseRows,
    getAggregatedShipmentRows,
    getPeriodeDateRange,
    getScopedDates,
  };
});