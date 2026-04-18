# Aturan Bisnis Aplikasi

Catatan ini merangkum aturan bisnis yang harus diikuti aplikasi agar hasil rekonsiliasi sama dengan alur kerja MauKirim dan proses operasional Maulagi.

## Prinsip Utama

- MauKirim adalah source of truth untuk data NONCOD mentah.
- Tabel `noncod` di database harus mengikuti snapshot MauKirim untuk periode yang disinkronkan.
- Jika suatu resi berubah di MauKirim, row `noncod` yang sama harus ikut berubah.
- Jika suatu resi hilang dari MauKirim, row `noncod` harus ikut terhapus saat sync berikutnya.
- Kolom `metode_pembayaran` dari MauKirim adalah acuan final: `noncod` tetap `noncod`, `dfod` tetap `dfod`.

## Identitas Data

- `nomor_resi` adalah identity teknis utama untuk mengenali row NONCOD yang sama saat sync.
- `tanggal_buat` adalah anchor bisnis yang stabil untuk:
  - periode
  - bucket harian
  - rekonsiliasi NONCOD
- `periode` adalah turunan dari `tanggal_buat`, bukan penentu identitas row.

## Aturan Sync NONCOD

- Sync NONCOD harus bersifat incremental, bukan `delete periode lalu insert ulang`.
- Saat membaca snapshot MauKirim:
  - resi baru -> insert
  - resi lama tetapi field berubah -> update
  - resi yang sudah tidak ada di MauKirim -> delete
- Karena `tanggal_buat` dianggap immutable oleh bisnis, aplikasi tidak boleh mengubah logika periode di luar nilai yang datang dari MauKirim.

## Aturan Rekonsiliasi Transfer

- Hanya data dengan `metode_pembayaran = noncod` yang masuk jalur rekonsiliasi transfer.
- Data `dfod` tidak direkonsiliasi terhadap transfer.
- Rekonsiliasi NONCOD tidak bertumpu pada tanggal real admin submit bukti transfer.
- Untuk bisnis ini, `nama_cabang` dan `ongkir` dari MauKirim dianggap stabil dan menjadi dasar matching rekonsiliasi.
- Yang dicocokkan lebih dulu adalah `nama_cabang` dan nominal outstanding `ongkir`.
- Untuk upload public, pencocokan nominal dilakukan terhadap akumulasi harian per cabang (`tanggal_buat` + `cabang`), bukan terhadap row NONCOD individual.
- Akumulasi harian dihitung dari seluruh row NONCOD efektif pada tanggal yang sama, setelah filter `metode_pembayaran = noncod` dan pengecualian status `BATAL`/`VOID`.
- Outstanding bucket harian = total akumulasi harian - total transfer yang sudah menempel pada `tgl_inputan` yang sama.
- Outstanding parsial harus tetap terkunci pada tanggal aslinya; sisa tanggal lama tidak boleh dipindah atau dilompati ke tanggal berikutnya.
- Exact match upload public tidak memakai toleransi nominal; nominal OCR harus sama persis dengan outstanding prefix yang sedang diuji.
- Matcher upload public berjalan FIFO prefix dari tanggal tertua yang belum lunas: tanggal 1, tanggal 1 + 2, tanggal 1 + 2 + 3, dan seterusnya.
- Matcher upload public tidak boleh mencari kombinasi bebas dan tidak boleh meloncati tanggal yang masih memiliki outstanding.
- Setelah transfer cocok exact dengan outstanding NONCOD, transfer ditempel ke bucket `tanggal_buat` NONCOD yang sesuai.
- Jika satu transfer mencakup beberapa tanggal NONCOD, nominal dipecah ke beberapa bucket tanggal yang berurutan sesuai prefix exact tersebut.

## Aturan Hold Cabang

- Jika user transfer lebih besar dari outstanding exact yang valid, hanya bagian exact yang ditempel sebagai transfer.
- Sisa nominal menjadi hold per cabang, bukan bucket tanggal baru.
- Hold tidak memiliki `tgl_inputan` saat dibuat dan tidak boleh langsung dianggap sebagai transfer hari berikutnya.
- Hold dipakai untuk mengurangi akumulasi harian snapshot berikutnya pada cabang yang sama secara FIFO per tanggal.
- Pengurangan hold dilakukan di level total harian per cabang; untuk admin, yang penting adalah total efektif harian setelah potongan hold, bukan distribusi ke row NONCOD individual.
- Jika total snapshot hari berikutnya lebih kecil dari saldo hold, bucket hari itu dianggap lunas dan sisa hold berlanjut ke tanggal berikutnya sampai habis.
- Angka yang dibagikan admin ke user adalah outstanding harian efektif setelah transfer existing dan potongan hold.

## Aturan DFOD dan Omset

- `dfod` dipertahankan dari MauKirim apa adanya berdasarkan kolom `metode_pembayaran`.
- `dfod` tidak ikut rekonsiliasi transfer.
- Data `dfod` hanya dipakai untuk kebutuhan pelaporan total omset dan pemisahan nilai antara `dfod` dan `noncod`.
- Ringkasan omset `dfod` dan `noncod` harus mengikuti nilai `ongkir` sesuai pembagian metode pembayaran dari MauKirim.

## Arti Tanggal pada Transfer

- `timestamp` atau `created_at` transfer menyimpan waktu asli submit admin atau waktu row dibuat.
- `tgl_inputan` transfer adalah tanggal bucket bisnis hasil tempel ke `tanggal_buat` NONCOD.
- Karena itu, `tgl_inputan` memang harus mengikuti `tanggal_buat` NONCOD yang matched.
- Jalur upload normal tetap harus menempel otomatis ke bucket `tanggal_buat` NONCOD hasil matching exact prefix; kelebihan nominal user tidak membuat bucket tanggal baru dan harus masuk hold cabang.
- Khusus admin, koreksi manual `tgl_inputan` tetap diperbolehkan jika memang perlu memperbaiki penempatan nominal transfer ke bucket NONCOD yang benar.
- Jika satu bukti transfer mencakup beberapa tanggal NONCOD, admin boleh melakukan split ke beberapa bucket tanggal yang sesuai.

## Status dan Override

- Data sync mentah dari MauKirim tetap disimpan apa adanya.
- Override admin adalah lapisan terpisah untuk hasil efektif rekonsiliasi.
- Saat ini, hasil efektif NONCOD mengecualikan status:
  - `BATAL`
  - `VOID`
- `VOID` adalah hak override admin dan harus tetap dihormati pada agregasi serta matching.

## Implikasi Operasional

- Jika ada transfer tetapi row NONCOD hilang dari MauKirim, transfer tidak boleh diam-diam dihapus.
- Kasus seperti itu harus muncul sebagai selisih rekonsiliasi agar bisa diaudit.
- Tujuan akhir sistem ini adalah:
  - data `noncod` mengikuti MauKirim
  - transfer mengikuti bukti transaksi nyata
  - hasil rekonsiliasi menunjukkan selisih nyata, bukan menyembunyikannya

## Ringkasan Singkat

- `nomor_resi` = identity teknis sync
- `tanggal_buat` = anchor bisnis rekonsiliasi
- `tgl_inputan` transfer = tanggal hasil tempel ke bucket NONCOD
- upload public exact = match terhadap outstanding akumulasi harian per cabang secara FIFO prefix tanpa toleransi
- hold cabang = saldo lebih yang mengurangi total harian berikutnya, bukan transfer bertanggal baru
- MauKirim = sumber data NONCOD mentah
- Override admin = lapisan efektif setelah sync mentah masuk
