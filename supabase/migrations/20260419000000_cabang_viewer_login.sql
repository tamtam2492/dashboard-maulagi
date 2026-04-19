-- Viewer login per cabang
-- no_wa  : nomor WhatsApp cabang (sebagai username login, unik per cabang)
-- viewer_pw_hash : bcrypt hash password Maukirim cabang (tidak pernah dikembalikan ke client)
ALTER TABLE cabang ADD COLUMN IF NOT EXISTS no_wa text;
ALTER TABLE cabang ADD COLUMN IF NOT EXISTS viewer_pw_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS cabang_no_wa_unique
  ON cabang (no_wa)
  WHERE no_wa IS NOT NULL;
