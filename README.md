# Dashboard Maulagi

Dashboard internal untuk rekap transfer, input bukti transfer, monitoring cabang, dan pengelolaan data noncod/dfod. Frontend disajikan dari file HTML statis di root project, sedangkan backend menggunakan Vercel Serverless Functions dengan penyimpanan utama di Supabase.

## Fitur Utama

- Login admin dan dashboard dengan password yang disimpan di tabel `settings`.
- Input bukti transfer dengan upload gambar ke bucket Supabase `bukti-transfer`.
- Rekap transfer per cabang dan ringkasan aktivitas harian.
- Panel admin untuk kelola cabang, transfer, log error, dan password.
- Modul noncod/dfod dengan sinkron data dari Maukirim.
- OCR bukti transfer melalui Groq untuk bantu isi nominal dan channel.

## Stack

- Vercel untuk hosting static pages dan serverless API.
- Supabase untuk database dan object storage.
- Vanilla HTML, CSS, dan JavaScript untuk UI.
- `@supabase/supabase-js`, `bcryptjs`, `busboy`, `exceljs`, dan utilitas serverless di backend.

## Halaman Utama

- `/index.html` untuk landing dan akses dashboard.
- `/dashboard.html` untuk workspace utama dan ringkasan data.
- `/input.html` untuk upload bukti transfer.
- `/rekap.html` untuk rekap transfer per cabang.
- `/noncod.html` untuk dashboard noncod/dfod.
- `/admin.html` untuk operasi admin.

## API Penting

- `/api/auth` untuk cek password, login, buat password awal, dan ganti password.
- `/api/dashboard` untuk ringkasan transfer dan cleanup data lama.
- `/api/input` untuk simpan transfer baru dan upload bukti.
- `/api/cabang` untuk list dan CRUD cabang.
- `/api/transfer` untuk list, edit, hapus, dan split transfer dari admin.
- `/api/noncod` untuk summary, sinkron data MauKirim, dan hapus data per periode.
- `/api/check-update` untuk ringkasan update transfer.
- `/api/check-dupe` untuk cek duplikasi sebelum input transfer.
- `/api/ocr` untuk ekstraksi data bukti transfer dari gambar.
- `/api/logs`, `/api/visit`, dan `/api/proxy-image` untuk utilitas operasional.

## Environment Variables

Salin `.env.example` menjadi `.env`, lalu isi nilai yang sesuai.

```env
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ALLOWED_ORIGIN=
MAUKIRIM_WA=
MAUKIRIM_PASS=
GROQ_API_KEY=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
EXCEL_PATH=
```

Keterangan singkat:

- `SUPABASE_URL` dan `SUPABASE_ANON_KEY` wajib untuk seluruh API.
- `SUPABASE_SERVICE_ROLE_KEY` sangat disarankan untuk server agar tabel `settings` bisa diproteksi dengan RLS tanpa memutus endpoint auth. Jangan pernah expose key ini ke browser.
- `ALLOWED_ORIGIN` opsional untuk pembatasan CORS tambahan.
- `MAUKIRIM_WA` dan `MAUKIRIM_PASS` dipakai auto sync noncod/dfod.
- `GROQ_API_KEY` dipakai endpoint OCR.
- `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN` opsional untuk rate limiter lintas instance. Jika kosong, limiter fallback ke memory per instance.
- `EXCEL_PATH` hanya dipakai script migrasi lokal.

## Kebutuhan Supabase

Project ini mengandalkan resource berikut di Supabase:

- Tabel `settings`
- Tabel `cabang`
- Tabel `transfers`
- Tabel `noncod`
- Tabel `visitors`
- Tabel `error_logs`
- Storage bucket `bukti-transfer`

File `sql-indexes.sql` berisi indeks tambahan, bukan schema lengkap tabel.
File `sql-security.sql` berisi hardening RLS untuk tabel `settings`.

## Menjalankan Lokal

1. Install dependency dengan `npm install`.
2. Buat file `.env` dari `.env.example`.
3. Isi environment variable yang dibutuhkan.
4. Jalankan lokal dengan `npx vercel dev`.
5. Buka aplikasi di URL lokal yang ditampilkan Vercel.

## Deploy

1. Hubungkan repo ini ke project Vercel.
2. Masukkan semua environment variable di Vercel Project Settings.
3. Pastikan `SUPABASE_SERVICE_ROLE_KEY` terisi sebelum menerapkan `sql-security.sql`.
4. Deploy branch `main`.

## Catatan

- File sensitif seperti `.env`, `.vercel`, dan snapshot akun sudah diabaikan oleh Git.
- Jangan masukkan kredensial asli ke repository.
- `/api/dashboard` sekarang mengambil data Supabase secara bertahap per batch agar tidak menarik seluruh row sekaligus dalam satu query.