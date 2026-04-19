function normalizeViewerWa(value) {
  return String(value || '').replace(/\s+/g, '').trim().slice(0, 20);
}

function normalizeCabangSyncName(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .slice(0, 100);
}

function buildSenderMap(senders) {
  const senderMap = new Map();
  for (const sender of (Array.isArray(senders) ? senders : [])) {
    const name = normalizeCabangSyncName(sender && sender.name);
    const wa = normalizeViewerWa(sender && sender.wa);
    if (!name || !wa) continue;
    senderMap.set(name, wa);
  }
  return senderMap;
}

async function syncCabangViewerFromSenders(supabase, senders, options = {}) {
  const senderList = Array.isArray(senders) ? senders : [];
  const senderMap = buildSenderMap(senderList);
  const cabangIds = Array.isArray(options.cabangIds)
    ? options.cabangIds.map((value) => Number.parseInt(value, 10)).filter(Boolean)
    : [];

  let query = supabase
    .from('cabang')
    .select('id, nama, no_wa');

  if (cabangIds.length) {
    query = query.in('id', cabangIds);
  }

  const { data: cabangList, error: fetchErr } = await query;
  if (fetchErr) throw fetchErr;

  let updated = 0;
  let matched = 0;
  let skipped = 0;

  for (const cabang of (cabangList || [])) {
    const senderWa = senderMap.get(normalizeCabangSyncName(cabang && cabang.nama));
    if (!senderWa) {
      skipped++;
      continue;
    }

    matched++;
    if (normalizeViewerWa(cabang && cabang.no_wa) === senderWa) {
      skipped++;
      continue;
    }

    const { error: updateErr } = await supabase
      .from('cabang')
      .update({ no_wa: senderWa })
      .eq('id', cabang.id);
    if (updateErr) throw updateErr;
    updated++;
  }

  return {
    updated,
    matched,
    skipped,
    total_maukirim: senderList.length,
    total_cabang: (cabangList || []).length,
  };
}

module.exports = {
  buildSenderMap,
  normalizeCabangSyncName,
  normalizeViewerWa,
  syncCabangViewerFromSenders,
};