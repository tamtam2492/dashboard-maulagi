/**
 * Migrasi gambar dari Google Drive ke Supabase Storage
 * - Aman: DB hanya diupdate setelah upload berhasil
 * - Resume: skip row yang sudah punya URL supabase
 * - Log: tiap baris dicatat hasilnya
 */

const { createClient } = require('./node_modules/@supabase/supabase-js');
require('./node_modules/dotenv/config');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const BATCH_SIZE = 3;       // proses 3 sekaligus
const DELAY_MS   = 1500;    // jeda antar batch (ms)
const SIGNED_URL_TTL = 60 * 60 * 24 * 365 * 5; // 5 tahun

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractDriveId(url) {
  if (!url) return null;
  const byId   = url.match(/[?&]id=([^&]+)/);
  const byPath = url.match(/\/file\/d\/([^/]+)/);
  if (byId)   return byId[1];
  if (byPath) return byPath[1];
  return null;
}

async function downloadDriveImage(fileId) {
  const url = `https://drive.google.com/uc?export=view&id=${fileId}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Drive HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.startsWith('image/')) throw new Error(`Bukan gambar (content-type: ${ct})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpg';
  return { buf, ct, ext };
}

async function uploadToSupabase(id, buf, ct, ext) {
  const filename = `migrated_${id}_${Date.now()}.${ext}`;
  const { error: upErr } = await sb.storage
    .from('bukti-transfer')
    .upload(filename, buf, { contentType: ct, upsert: false });
  if (upErr) throw new Error(`Upload gagal: ${upErr.message}`);

  const { data: urlData, error: urlErr } = await sb.storage
    .from('bukti-transfer')
    .createSignedUrl(filename, SIGNED_URL_TTL);
  if (urlErr || !urlData?.signedUrl) throw new Error(`Signed URL gagal: ${urlErr?.message}`);
  return urlData.signedUrl;
}

async function main() {
  console.log('=== Migrasi Google Drive → Supabase Storage ===\n');

  // Ambil semua row dengan Drive URL
  const { data: rows, error } = await sb
    .from('transfers')
    .select('id, bukti_url')
    .like('bukti_url', '%drive.google.com%')
    .order('id');

  if (error) { console.error('Gagal fetch:', error.message); process.exit(1); }
  console.log(`Total baris Drive: ${rows.length}\n`);

  let ok = 0, fail = 0, skip = 0;
  const failures = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (row) => {
      const fileId = extractDriveId(row.bukti_url);
      if (!fileId) {
        console.log(`[SKIP] ${row.id} — ID tidak ditemukan dari URL`);
        skip++; return;
      }

      try {
        const { buf, ct, ext } = await downloadDriveImage(fileId);
        const newUrl = await uploadToSupabase(row.id, buf, ct, ext);

        const { error: updErr } = await sb
          .from('transfers')
          .update({ bukti_url: newUrl })
          .eq('id', row.id);
        if (updErr) throw new Error(`DB update gagal: ${updErr.message}`);

        console.log(`[OK]   ${row.id}`);
        ok++;
      } catch (err) {
        console.log(`[FAIL] ${row.id} — ${err.message}`);
        failures.push({ id: row.id, url: row.bukti_url, err: err.message });
        fail++;
      }
    }));

    const done = Math.min(i + BATCH_SIZE, rows.length);
    console.log(`  → Progress: ${done}/${rows.length} (ok:${ok} fail:${fail} skip:${skip})`);

    if (done < rows.length) await sleep(DELAY_MS);
  }

  console.log('\n=== SELESAI ===');
  console.log(`OK: ${ok} | FAIL: ${fail} | SKIP: ${skip}`);

  if (failures.length > 0) {
    console.log('\nGagal:');
    failures.forEach(f => console.log(`  ${f.id} — ${f.err}`));
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
