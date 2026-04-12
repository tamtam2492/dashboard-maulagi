# Dashboard Maulagi

Dashboard internal untuk input bukti transfer, rekap transfer cabang, monitoring NONCOD/DFOD, dan operasi admin. Aplikasi memakai halaman HTML statis di root project dan API serverless di folder `api/`, dengan penyimpanan data dan file di Supabase.

## Ringkasan

- Login admin berbasis password yang disimpan di tabel `settings`.
- Input transfer dengan upload bukti ke bucket `bukti-transfer`.
- Rekap transfer dan monitoring aktivitas cabang.
- Dashboard NONCOD dan DFOD dengan sinkronisasi data MauKirim.
- OCR bukti transfer untuk bantu baca nominal dan channel bank.
- Panel admin untuk kelola cabang, transfer, password, dan log error.

## Tech Stack

- Vercel untuk static hosting dan serverless functions.
- Supabase untuk database dan object storage.
- HTML, CSS, dan JavaScript tanpa framework untuk frontend.
- Node.js untuk runtime API dan utilitas lokal.

## Struktur Proyek

```text
.
|-- api/           # Vercel serverless functions dan helper backend
|-- lib/           # Modul browser/shared logic
|-- scripts/       # Utilitas pengecekan lokal
|-- tests/         # Test Node bawaan
|-- *.html         # Halaman aplikasi
|-- code.gs        # Skrip pendukung Google Apps Script
|-- sql-*.sql      # SQL tambahan untuk index dan security
|-- vercel.json    # Konfigurasi deployment Vercel
```

## Halaman Utama

- `/index.html` untuk landing dan akses awal.
- `/dashboard.html` untuk workspace utama.
- `/input.html` untuk input transfer dan OCR bukti.
- `/rekap.html` untuk rekap transfer per cabang.
- `/noncod.html` untuk monitoring NONCOD dan DFOD.
- `/admin.html` untuk operasi admin.

## Endpoint API

- `/api/auth` untuk login, setup password awal, dan ganti password.
- `/api/dashboard` untuk ringkasan transfer dashboard.
- `/api/input` untuk simpan transfer baru dan upload bukti.
- `/api/cabang` untuk list dan CRUD data cabang.
- `/api/transfer` untuk list, edit, hapus, dan split transfer.
- `/api/noncod` untuk summary NONCOD/DFOD dan sinkron data MauKirim.
- `/api/check-update` untuk ringkasan update transfer.
- `/api/check-dupe` untuk cek duplikasi sebelum input.
- `/api/ocr` untuk ekstraksi data bukti transfer.
- `/api/logs`, `/api/visit`, dan `/api/proxy-image` untuk kebutuhan operasional.

## Persiapan Lokal

### Prasyarat

- Node.js 18 atau lebih baru.
- Akun dan project Supabase.
- Project Vercel untuk menjalankan API secara lokal maupun production.

### Menjalankan Lokal

Ikuti langkah berikut untuk menjalankan proyek di environment lokal:

1. Install dependency:

```bash
npm install
```

2. Salin `.env.example` menjadi `.env`.
3. Isi environment variable di `.env` sesuai environment Anda.
4. Jalankan aplikasi lokal:

```bash
npx vercel dev
```

5. Buka URL lokal yang ditampilkan oleh Vercel.

## Environment Variables

Template tersedia di `.env.example`.

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
ALLOWED_ORIGIN=https://your-domain.vercel.app
MAUKIRIM_WA=628xxxxxxxxxx
MAUKIRIM_PASS=your-maukirim-password
GROQ_API_KEY=your-groq-api-key
UPSTASH_REDIS_REST_URL=https://your-upstash-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-upstash-token
EXCEL_PATH=C:/path/to/source.xlsx
```

Kebutuhan utama:

- `SUPABASE_URL` dan `SUPABASE_ANON_KEY` wajib untuk API.
- `SUPABASE_SERVICE_ROLE_KEY` dipakai endpoint server yang butuh akses penuh.
- `MAUKIRIM_WA` dan `MAUKIRIM_PASS` dipakai untuk sync NONCOD/DFOD.
- `GROQ_API_KEY` dipakai fitur OCR.
- `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN` dipakai rate limiter lintas instance.
- `EXCEL_PATH` hanya dipakai script migrasi lokal.

## Resource Supabase

Project ini mengandalkan resource berikut:

- Tabel `settings`
- Tabel `cabang`
- Tabel `transfers`
- Tabel `noncod`
- Tabel `visitors`
- Tabel `error_logs`
- Bucket storage `bukti-transfer`

Tambahan SQL di repo:

- `sql-indexes.sql` untuk indeks tambahan.
- `sql-security.sql` untuk hardening akses tabel `settings`.

## Scripts

- `npm run lint` untuk syntax check file JavaScript.
- `npm run test` untuk menjalankan seluruh test.
- `npm run check` untuk menjalankan lint dan test sekaligus.

## Deployment

1. Hubungkan repository ke project Vercel.
2. Isi semua environment variable di Vercel Project Settings.
3. Pastikan konfigurasi Supabase sudah sesuai dengan resource yang dibutuhkan.
4. Deploy branch `main`.

## Pengembangan

- Helper backend ada di `api/_*.js`.
- Shared frontend logic ada di `lib/`.
- Test memakai `node --test` tanpa framework tambahan.
- File HTML utama tetap menjadi entry point tiap modul halaman.