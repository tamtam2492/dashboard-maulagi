/**
 * Migration script: Excel -> Supabase
 * Jalankan sekali: node migrate.js
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

function excelDateToISO(val) {
  if (!val) return null;
  if (val instanceof Date) {
    return val.toISOString().split('T')[0];
  }
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

async function migrate() {
  console.log('📖 Membaca Excel:', EXCEL_PATH);
  const wb = await loadWorkbookFromFile(EXCEL_PATH);

  // Ambil semua data dari semua sheet bulanan + Form Responses
  // Deduplikasi berdasarkan timestamp + nama_cabang + nominal
  const allRows = new Map();

  const TARGET_SHEETS = ['JANUARI', 'FEBRUARI', 'MARET', 'Form Responses'];

  for (const sheetName of TARGET_SHEETS) {
    const ws = getWorksheetByName(wb, sheetName);
    if (!ws) continue;
    const rows = worksheetToMatrix(ws);
    console.log(`  Sheet "${sheetName}": ${rows.length - 1} baris data`);

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
      const key = tsISO + '|' + nama_cabang + '|' + nominal;

      if (!allRows.has(key)) {
        allRows.set(key, {
          timestamp: tsISO,
          tgl_inputan: excelDateToISO(tgl_inputan),
          nama_bank: normalizeBankName(nama_bank),
          nama_cabang: String(nama_cabang).trim(),
          bukti_url: bukti_url ? String(bukti_url).trim() : null,
          nominal: Number(nominal),
          ket: ket ? String(ket).trim() : null,
        });
      }
    }
  }

  const transfers = Array.from(allRows.values());
  console.log(`\n✅ Total unique transfers: ${transfers.length}`);

  // Kumpulkan unik cabang
  const cabangSet = new Set(transfers.map(t => t.nama_cabang));
  const cabangList = Array.from(cabangSet).sort().map(nama => ({ nama }));
  console.log(`📍 Unique cabang: ${cabangList.length}`);

  // --- Insert cabang ---
  console.log('\n⬆️  Inserting cabang...');
  const { error: cabangErr } = await supabase
    .from('cabang')
    .upsert(cabangList, { onConflict: 'nama', ignoreDuplicates: true });
  if (cabangErr) {
    console.error('❌ Cabang error:', cabangErr.message);
  } else {
    console.log(`✅ ${cabangList.length} cabang inserted/upserted`);
  }

  // --- Insert transfers in batches ---
  console.log('\n⬆️  Inserting transfers...');
  const BATCH = 100;
  let inserted = 0;
  for (let i = 0; i < transfers.length; i += BATCH) {
    const batch = transfers.slice(i, i + BATCH);
    const { error } = await supabase.from('transfers').insert(batch);
    if (error) {
      console.error(`❌ Batch ${i}-${i + BATCH} error:`, error.message);
    } else {
      inserted += batch.length;
      process.stdout.write(`   ${inserted}/${transfers.length}\r`);
    }
  }
  console.log(`\n✅ ${inserted} transfers inserted`);

  console.log('\n🎉 Migration selesai!');
}

migrate().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
