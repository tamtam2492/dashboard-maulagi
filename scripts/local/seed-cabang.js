/**
 * Seed master data cabang resmi ke Supabase
 * Jalankan: node scripts/local/seed-cabang.js
 *
 * PENTING: Jalankan SQL ini dulu di Supabase SQL Editor:
 *   ALTER TABLE cabang ADD COLUMN IF NOT EXISTS area text;
 *   TRUNCATE TABLE cabang RESTART IDENTITY;
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY sebelum menjalankan seed-cabang.');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const CABANG_DATA = [
  // SULTRA
  { nama: 'CABANG KENDARI 01', area: 'SULTRA' },
  { nama: 'CABANG KADIA', area: 'SULTRA' },
  { nama: 'CABANG PUUWATU', area: 'SULTRA' },
  { nama: 'CABANG PANJAITAN', area: 'SULTRA' },
  { nama: 'CABANG BENU BENUA', area: 'SULTRA' },
  { nama: 'CABANG POASIA 01', area: 'SULTRA' },
  { nama: 'CABANG POASIA 02', area: 'SULTRA' },
  { nama: 'CABANG MT HARYONO 01', area: 'SULTRA' },
  { nama: 'CABANG MT HARYONO 02', area: 'SULTRA' },
  { nama: 'CABANG PIERE TANDEAN 01', area: 'SULTRA' },
  { nama: 'CABANG PIERE TANDEAN 02', area: 'SULTRA' },
  { nama: 'CABANG KAMBU 01', area: 'SULTRA' },
  { nama: 'CABANG KAMBU 02', area: 'SULTRA' },
  { nama: 'CABANG LASOLO 01', area: 'SULTRA' },
  { nama: 'CABANG LASOLO 02', area: 'SULTRA' },
  { nama: 'CABANG ANDOWIA 01', area: 'SULTRA' },
  { nama: 'CABANG ANDOWIA 02', area: 'SULTRA' },
  { nama: 'CABANG UNAAHA', area: 'SULTRA' },
  { nama: 'CABANG WAWOTOBI', area: 'SULTRA' },
  { nama: 'CABANG MOROSI', area: 'SULTRA' },
  { nama: 'CABANG TIRAWUTA', area: 'SULTRA' },
  { nama: 'CABANG KOLAKA', area: 'SULTRA' },
  { nama: 'CABANG POMALAA', area: 'SULTRA' },
  { nama: 'CABANG LATAMBAGA', area: 'SULTRA' },
  { nama: 'CABANG WOLO', area: 'SULTRA' },
  { nama: 'CABANG TANGGETADA', area: 'SULTRA' },
  { nama: 'CABANG LASUSUA', area: 'SULTRA' },
  { nama: 'CABANG NGAPA', area: 'SULTRA' },
  { nama: 'CABANG WANGGODO', area: 'SULTRA' },
  { nama: 'CABANG TUGU MOWILA', area: 'SULTRA' },
  { nama: 'CABANG LAEYA', area: 'SULTRA' },
  { nama: 'CABANG MORAMO', area: 'SULTRA' },
  { nama: 'CABANG TINANGGEA', area: 'SULTRA' },
  { nama: 'CABANG RUMBIA', area: 'SULTRA' },
  { nama: 'CABANG POLEANG', area: 'SULTRA' },
  { nama: 'CABANG RAHA', area: 'SULTRA' },
  { nama: 'CABANG WANGI', area: 'SULTRA' },
  { nama: 'CABANG BAU-BAU', area: 'SULTRA' },
  { nama: 'CABANG BETOAMBARI', area: 'SULTRA' },
  { nama: 'CABANG LOMBE', area: 'SULTRA' },
  { nama: 'CABANG PASAR_WAJO2', area: 'SULTRA' },
  { nama: 'CABANG ULOE', area: 'SULTRA' },
  // MKS OUTER
  { nama: 'CABANG PAMMANA', area: 'MKS OUTER' },
  { nama: 'CABANG KAJUARA', area: 'MKS OUTER' },
  { nama: 'CABANG BONTOBAHARI', area: 'MKS OUTER' },
  { nama: 'CABANG RILAU ALE', area: 'MKS OUTER' },
  { nama: 'CABANG BIKERU', area: 'MKS OUTER' },
  { nama: 'CABANG LAPRI', area: 'MKS OUTER' },
  { nama: 'CABANG PALATTAE', area: 'MKS OUTER' },
  { nama: 'CABANG MARE', area: 'MKS OUTER' },
  { nama: 'CABANG ULAWENG', area: 'MKS OUTER' },
  { nama: 'CABANG BULUKUMBA', area: 'MKS OUTER' },
  { nama: 'CABANG WATAMPONE', area: 'MKS OUTER' },
  { nama: 'CABANG SELAYAR', area: 'MKS OUTER' },
  { nama: 'CABANG SINJAI', area: 'MKS OUTER' },
  { nama: 'CABANG MALILI', area: 'MKS OUTER' },
  { nama: 'CABANG PAREPARE', area: 'MKS OUTER' },
  { nama: 'CABANG PINRANG', area: 'MKS OUTER' },
  { nama: 'CABANG SENGKANG', area: 'MKS OUTER' },
  { nama: 'CABANG WATANSOPPENG', area: 'MKS OUTER' },
  { nama: 'CABANG SIDENRENG', area: 'MKS OUTER' },
  { nama: 'CABANG TANRU TEDONG', area: 'MKS OUTER' },
  { nama: 'CABANG AMPARITA', area: 'MKS OUTER' },
  { nama: 'CABANG MAKALE', area: 'MKS OUTER' },
  { nama: 'CABANG TORAJA', area: 'MKS OUTER' },
  { nama: 'CABANG TIKALA', area: 'MKS OUTER' },
  { nama: 'CABANG PANGKAJENE', area: 'MKS OUTER' },
  { nama: 'CABANG PAREPARE 02', area: 'MKS OUTER' },
  { nama: 'CABANG BUKIT INDAH', area: 'MKS OUTER' },
  { nama: 'CABANG RAPPANG', area: 'MKS OUTER' },
  { nama: 'CABANG ATTAPANGE', area: 'MKS OUTER' },
  { nama: 'CABANG BELOPA', area: 'MKS OUTER' },
  { nama: 'CABANG WALENGRAN', area: 'MKS OUTER' },
  { nama: 'CABANG PALOPO', area: 'MKS OUTER' },
  { nama: 'CABANG RAMPOANG', area: 'MKS OUTER' },
  { nama: 'CABANG SOROAKO', area: 'MKS OUTER' },
  { nama: 'CABANG WOTU', area: 'MKS OUTER' },
  { nama: 'CABANG WAWONDULA', area: 'MKS OUTER' },
  { nama: 'CABANG MASAMBA', area: 'MKS OUTER' },
  { nama: 'CABANG BONE BONE', area: 'MKS OUTER' },
  { nama: 'CABANG PAMMANU', area: 'MKS OUTER' },
  { nama: 'CABANG PALETEANG', area: 'MKS OUTER' },
  // CUSTUMER
  { nama: 'UNI SHOP', area: 'CUSTUMER' },
];

async function seed() {
  console.log('🗑️  Clearing existing cabang data...');
  const { error: delErr } = await supabase.from('cabang').delete().neq('id', 0);
  if (delErr) {
    console.error('❌ Delete error:', delErr.message);
    console.log('   Coba jalankan TRUNCATE TABLE cabang RESTART IDENTITY; di Supabase SQL Editor');
    return;
  }

  console.log(`⬆️  Inserting ${CABANG_DATA.length} cabang...`);
  const { error: insErr } = await supabase.from('cabang').insert(CABANG_DATA);
  if (insErr) {
    console.error('❌ Insert error:', insErr.message);
    if (insErr.message.includes('area')) {
      console.log('\n⚠️  Kolom "area" belum ada. Jalankan di Supabase SQL Editor:\n');
      console.log('  ALTER TABLE cabang ADD COLUMN IF NOT EXISTS area text;\n');
    }
    return;
  }

  const counts = {};
  CABANG_DATA.forEach(c => { counts[c.area] = (counts[c.area] || 0) + 1; });
  Object.entries(counts).forEach(([area, n]) => console.log(`  ${area}: ${n} cabang`));
  console.log(`\n✅ ${CABANG_DATA.length} cabang berhasil di-seed!`);
}

seed().catch(err => { console.error('Fatal:', err); process.exit(1); });
