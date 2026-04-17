/**
 * cleanup.js
 * Hapus data transfers + foto bukti lebih dari 2 bulan
 * Jalankan: node -r dotenv/config scripts/local/cleanup.js
 * Atau dry-run: node -r dotenv/config scripts/local/cleanup.js --dry-run
 */
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');
const MONTHS_KEEP = 2;
const BUCKET = 'bukti-transfer';
const BATCH_SIZE = 100;

function getSupabase() {
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function getCutoffDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - MONTHS_KEEP);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function run() {
  const supabase = getSupabase();
  const cutoff = getCutoffDate();

  console.log(`Mode    : ${DRY_RUN ? 'DRY-RUN (tidak menghapus)' : 'LIVE (akan menghapus permanen)'}`);
  console.log(`Cutoff  : data sebelum ${cutoff.slice(0, 10)}\n`);

  // ── Step 1: Ambil semua data lama ──────────────────────────────────────────
  let allRows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('transfers')
      .select('id, tgl_inputan, timestamp, bukti_url, nama_cabang')
      .lt('timestamp', cutoff)
      .order('timestamp', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);
    if (error) { console.error('Fetch error:', error.message); break; }
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    if (data.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  console.log(`Ditemukan ${allRows.length} rows yang akan dihapus`);
  if (allRows.length === 0) { console.log('Tidak ada data untuk dihapus.'); return; }

  // ── Step 2: Hapus foto dari Storage ───────────────────────────────────────
  const filePaths = allRows.map(r => r.bukti_url).filter(f => f && !f.startsWith('http'));
  console.log(`File foto: ${filePaths.length}`);

  if (filePaths.length > 0) {
    if (DRY_RUN) {
      console.log('[DRY-RUN] Akan hapus file:', filePaths.slice(0, 5), filePaths.length > 5 ? `...+${filePaths.length - 5} lainnya` : '');
    } else {
      // Hapus batch per 100
      for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
        const batch = filePaths.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.storage.from(BUCKET).remove(batch);
        if (error) console.warn(`  Storage batch ${i}-${i+batch.length} error:`, error.message);
        else console.log(`  Storage: hapus ${batch.length} file (${i+1}-${i+batch.length})`);
      }
    }
  }

  // ── Step 3: Hapus rows dari DB ─────────────────────────────────────────────
  const ids = allRows.map(r => r.id);
  if (DRY_RUN) {
    console.log(`[DRY-RUN] Akan hapus ${ids.length} rows dari DB`);
    console.log('Contoh:', allRows.slice(0, 3).map(r => `${r.tgl_inputan} ${r.nama_cabang}`));
  } else {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from('transfers').delete().in('id', batch);
      if (error) console.warn(`  DB batch ${i}-${i+batch.length} error:`, error.message);
      else console.log(`  DB: hapus ${batch.length} rows (${i+1}-${i+batch.length})`);
    }
    console.log(`\nSelesai. Total dihapus: ${ids.length} rows + ${filePaths.length} foto.`);
  }

  if (DRY_RUN) {
    console.log('\nJalankan tanpa --dry-run untuk menghapus permanen:');
    console.log('  node -r dotenv/config scripts/local/cleanup.js');
  }
}

run().catch(err => { console.error(err); process.exit(1); });
