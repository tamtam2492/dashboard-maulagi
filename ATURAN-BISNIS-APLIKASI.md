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

- Prinsip arsitektur jalur NONCOD saat ini: snapshot dibaca dari database, dan refresh snapshot dilakukan manual oleh admin lewat upload workbook MauKirim.
- Sync NONCOD harus bersifat incremental, bukan `delete periode lalu insert ulang`.
- Refresh snapshot NONCOD tidak lagi dijalankan oleh worker background terjadwal; request baca biasa tetap membaca snapshot database terakhir yang valid.
- Semua pekerjaan refresh snapshot NONCOD dijalankan saat admin melakukan upload workbook manual. Jalur ini mencakup parsing Excel, rekonsiliasi row NONCOD, resolve pending allocation, dan publish snapshot baru.
- Tanggung jawab backend pada jalur NONCOD dibatasi ke validasi request upload, membaca snapshot database terakhir yang valid, melakukan rekonsiliasi incremental by `nomor_resi`, dan menyajikan status snapshot ke UI.
- Write path dari Vercel seperti input, edit, split, dan delete transfer hanya boleh menandai snapshot sebagai `dirty`; refresh data NONCOD tetap menunggu upload workbook manual berikutnya.
- Route manual `POST /api/noncod?pipeline=1` harus tetap dinonaktifkan. Trigger manual dari Vercel tidak boleh menjadi jalur operasional harian atau fallback tersembunyi.
- Upload manual workbook harus mereconcile data periode dengan identitas utama `nomor_resi` agar upload ulang file yang sama tidak membuat duplicate row di database.
- Saat membaca snapshot MauKirim:
  - resi baru -> insert
  - resi lama tetapi field berubah -> update
  - resi yang sudah tidak ada di MauKirim -> delete
- Karena `tanggal_buat` dianggap immutable oleh bisnis, aplikasi tidak boleh mengubah logika periode di luar nilai yang datang dari MauKirim.

## Aturan Snapshot Admin dan Refresh UI

- Loader penuh workspace admin hanya boleh muncul saat bootstrap login pertama ketika snapshot lokal belum tersedia.
- Setelah bootstrap selesai, workspace admin, NONCOD, DFOD, audit, transfer, cabang, dan panel lain harus tetap menampilkan snapshot terakhir yang valid sambil mengambil snapshot baru di background.
- Refresh sesudah bootstrap tidak boleh mengosongkan panel atau menampilkan UI `Memuat data...` selama snapshot lama masih tersedia.
- Semua perubahan data bisnis, baik dari input public maupun aksi manual admin, harus memicu marker global perubahan di server.
- Marker global perubahan harus ditulis server-side secara atomic, memakai `version` monotonic, dan menyimpan `changed_at`, `scopes`, serta `periodes` terdampak.
- Marker global adalah invalidation cursor, bukan event log penuh. Client hanya membaca marker; client tidak boleh mereset marker setelah membaca.
- `scopes` dan `periodes` pada marker global harus memakai compaction window server-side agar tidak terus menumpuk tanpa batas.
- Nilai awal yang dipakai adalah polling parent 10 detik dan compaction window 60 detik. Jika diubah setelah observasi production, window tetap harus minimal 4-6x interval polling.
- Parent workspace menjadi satu-satunya watcher marker global. Child panel tidak boleh melakukan polling penuh sendiri-sendiri hanya untuk mendeteksi perubahan.
- Jika marker berubah, hanya panel yang relevan yang boleh mengambil snapshot baru, dan pengambilan itu harus berupa silent snapshot swap.
- Jika panel sedang dalam mode edit atau split, snapshot baru tidak boleh langsung menimpa form aktif; refresh boleh ditunda sampai save atau cancel.
- Jika belum ada upload workbook terbaru, API tetap harus menyajikan snapshot terakhir yang valid; request baca biasa tidak boleh mengambil alih refresh data secara inline.
- Status snapshot di workspace admin/dashboard harus merefleksikan mode upload manual yang sebenarnya. Jika upload manual gagal, snapshot lama tetap dipakai sampai admin berhasil mengunggah workbook baru.

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
- Exact match upload public tidak memakai toleransi nominal; nominal OCR harus sama persis dengan outstanding yang sedang diuji.
- Matcher upload public mengutamakan exact match satu tanggal terlebih dahulu dari seluruh tanggal outstanding (bukan hanya tertua). Jika ditemukan satu tanggal yang outstanding-nya sama persis dengan nominal transfer, tanggal tersebut langsung dipakai meskipun ada outstanding lebih tua yang belum lunas.
- Jika tidak ada exact match satu tanggal, matcher baru menjalankan FIFO prefix dari tanggal tertua yang belum lunas: tanggal 1, tanggal 1 + 2, tanggal 1 + 2 + 3, dan seterusnya.
- Matcher upload public tidak boleh mencari kombinasi bebas dan tidak boleh meloncati tanggal kecuali ditemukan exact match satu tanggal seperti di atas.
- Setelah transfer cocok exact dengan outstanding NONCOD, transfer ditempel ke bucket `tanggal_buat` NONCOD yang sesuai.
- Jika satu transfer mencakup beberapa tanggal NONCOD, nominal dipecah ke beberapa bucket tanggal yang berurutan sesuai prefix exact tersebut.
- `transfer_datetime`, waktu pada struk bank, hasil OCR, dan teks `ket` tidak boleh dipakai sebagai anchor bucket harian; dashboard, admin, dan audit tetap harus membaca `tgl_inputan`.

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

## Aturan Bukti Transfer dan Proof Registry

- Setiap bukti transfer publik disimpan di registry `settings` dengan key `proof_signature_<sha256 file>` sebagai guard anti-reuse struk.
- Registry bukti harus menyimpan metadata bukti, `transferId`/`transferIds`, `tglInputanList`, dan `splitRows` agar satu bukti bisa dilacak ke satu atau beberapa row transfer aktif.
- Upload bukti yang sama harus diblokir selama registry masih menunjuk ke row transfer yang masih hidup.
- Jika registry menunjuk hanya ke row transfer yang sudah terhapus, entry orphan itu harus dibersihkan otomatis dan upload bukti yang sama boleh diproses ulang.
- Jika sebagian row split lama sudah hilang tetapi sebagian lain masih hidup, registry harus dipruning ke row yang masih hidup; sistem tidak boleh mempertahankan `transferIds` basi.
- Aksi admin split harus memindahkan registry bukti dari `transferId` lama ke hasil split baru, termasuk memperbarui `tglInputan`, `tglInputanList`, dan `splitRows`.
- Aksi admin delete harus memangkas `transferId` terkait dari registry bukti; jika tidak ada row hidup tersisa, entry registry harus ikut dihapus.
- Koreksi data transfer tidak boleh meninggalkan proof registry orphan yang kemudian memblokir re-upload bukti yang sah.

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
- proof registry SHA-256 = guard anti-reuse bukti yang wajib selalu sinkron dengan row transfer hidup
- MauKirim = sumber data NONCOD mentah
- Override admin = lapisan efektif setelah sync mentah masuk
- workspace admin = berbasis snapshot terakhir yang valid, update silent via marker global server-side
