/**
 * fix-periode.js
 * 1. Update kolom `periode` semua data lama berdasarkan sheet asal
 * 2. Import sheet APRIL yang belum ada di DB
 * Jalankan: node fix-periode.js
 */
require('dotenv').config();
const path = require('path');
const { normalizeBankName } = require('./api/_bank');
const { getSupabase } = require('./api/_supabase');
const { excelSerialToDate, getWorksheetByName, loadWorkbookFromFile, worksheetToMatrix } = require('./api/_excel');

const EXCEL_PATH = path.join(
  process.env.EXCEL_PATH || 'C:/Users/Tams/Downloads/FORM BUKTI TRANSFER (1).xlsx'
);

const supabase = getSupabase();

// Mapping nama sheet -> periode (YYYY-MM)
const SHEET_PERIODE = {
  'JANUARI': '2026-01',
  'FEBRUARI': '2026-02',
  'MARET': '2026-03',
  'APRIL': '2026-04',
};

function excelDateToISO(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  if (typeof val === 'number') {
    const date = excelSerialToDate(val);
    return date ? date.toISOString().split('T')[0] : null;
  }
  const parsed = new Date(val);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
  return String(val).split('T')[0];
}

function excelDateToTimestamp(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'number') {
    const date = excelSerialToDate(val);
    return date ? date.toISOString() : null;
  }
  return new Date(val).toISOString();
}

async function run() {
  console.log('📖 Membaca Excel:', EXCEL_PATH);
  const wb = await loadWorkbookFromFile(EXCEL_PATH);

  // Ambil semua data existing dari DB untuk matching
  console.log('\n📥 Mengambil data existing dari Supabase...');
  const { data: existing, error: fetchErr } = await supabase
    .from('transfers')
    .select('id, timestamp, nama_cabang, nominal, periode')
    .order('timestamp', { ascending: true });

  if (fetchErr) { console.error('❌ Gagal fetch:', fetchErr.message); process.exit(1); }
  console.log(`   ${existing.length} baris ditemukan`);

  // Buat lookup map: timestamp|nama_cabang|nominal -> {id, periode}
  const dbMap = new Map();
  for (const row of existing) {
    const ts = new Date(row.timestamp).toISOString();
    const key = ts + '|' + row.nama_cabang + '|' + row.nominal;
    dbMap.set(key, { id: row.id, periode: row.periode });
  }

  const updateBatch = []; // { id, periode }
  const newRows = [];     // baris baru dari APRIL

  for (const [sheetName, periode] of Object.entries(SHEET_PERIODE)) {
    const ws = getWorksheetByName(wb, sheetName);
    if (!ws) {
      console.log(`\n⚠️  Sheet "${sheetName}" tidak ditemukan, skip.`);
      continue;
    }
    const rows = worksheetToMatrix(ws);
    console.log(`\n📋 Sheet "${sheetName}" (${periode}): ${rows.length - 1} baris`);

    let updated = 0, notfound = 0, skipped = 0, added = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const timestamp = row[0];
      const tgl_inputan = row[1];
      const nama_bank = row[2];
      const nama_cabang = row[3];
      const bukti_url = row[4];
      const nominal = row[5];
      const ket = row[6] || null;

      if (!timestamp || !nama_bank || !nama_cabang || !nominal) continue;

      const tsISO = excelDateToTimestamp(timestamp);
      const nominalNum = Number(nominal);
      const key = tsISO + '|' + String(nama_cabang).trim().toUpperCase() + '|' + nominalNum;
      // Coba juga tanpa uppercase (data lama mungkin tidak uppercase)
      const keyRaw = tsISO + '|' + String(nama_cabang).trim() + '|' + nominalNum;

      const found = dbMap.get(key) || dbMap.get(keyRaw);

      if (found) {
        if (found.periode === periode) {
          skipped++;
        } else {
          updateBatch.push({ id: found.id, periode });
          updated++;
        }
      } else {
        // Baris baru (belum ada di DB) — tambahkan
        newRows.push({
          timestamp: tsISO,
          tgl_inputan: excelDateToISO(tgl_inputan),
          periode,
          nama_bank: normalizeBankName(nama_bank),
          nama_cabang: String(nama_cabang).trim().toUpperCase(),
          bukti_url: bukti_url ? String(bukti_url).trim() : null,
          nominal: nominalNum,
          ket: ket ? String(ket).trim() : null,
        });
        added++;
        notfound++;
      }
    }
    console.log(`   update periode: ${updated} | sudah benar: ${skipped} | baru ditambah: ${added}`);
  }

  // --- Update periode batch ---
  if (updateBatch.length > 0) {
    console.log(`\n⬆️  Update periode untuk ${updateBatch.length} baris...`);
    let ok = 0, fail = 0;
    // Update per batch 50
    const BATCH = 50;
    for (let i = 0; i < updateBatch.length; i += BATCH) {
      const chunk = updateBatch.slice(i, i + BATCH);
      for (const item of chunk) {
        const { error } = await supabase
          .from('transfers')
          .update({ periode: item.periode })
          .eq('id', item.id);
        if (error) { console.error('  ERR id', item.id, error.message); fail++; }
        else ok++;
      }
      process.stdout.write(`\r   Progress: ${Math.min(i + BATCH, updateBatch.length)}/${updateBatch.length}`);
    }
    console.log(`\n   ✅ Berhasil: ${ok} | Gagal: ${fail}`);
  } else {
    console.log('\n✅ Semua periode sudah benar, tidak ada yang perlu diupdate.');
  }

  // --- Insert baris baru ---
  // Dedup newRows
  const seenNew = new Set();
  const uniqueNew = newRows.filter(r => {
    const k = r.timestamp + '|' + r.nama_cabang + '|' + r.nominal;
    if (seenNew.has(k)) return false;
    seenNew.add(k); return true;
  });

  if (uniqueNew.length > 0) {
    console.log(`\n➕ Insert ${uniqueNew.length} baris baru...`);
    const BATCH = 100;
    let inserted = 0;
    for (let i = 0; i < uniqueNew.length; i += BATCH) {
      const chunk = uniqueNew.slice(i, i + BATCH);
      const { error } = await supabase.from('transfers').insert(chunk);
      if (error) console.error('  Insert error:', error.message);
      else inserted += chunk.length;
    }
    console.log(`   ✅ Inserted: ${inserted} baris`);
  } else {
    console.log('\n✅ Tidak ada baris baru untuk diinsert.');
  }

  console.log('\n🎉 Selesai!');
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
