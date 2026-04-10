-- =============================================================
-- Recommended Indexes for Production
-- Run this on Supabase SQL Editor (one-time)
-- =============================================================

-- transfers: filter by periode + order by timestamp (dashboard, admin)
CREATE INDEX IF NOT EXISTS idx_transfers_periode_ts
  ON transfers (periode, timestamp);

-- transfers: duplicate check (input form)
CREATE INDEX IF NOT EXISTS idx_transfers_dupe_check
  ON transfers (nama_cabang, tgl_inputan, nominal);

-- noncod: filter & delete by periode
CREATE INDEX IF NOT EXISTS idx_noncod_periode
  ON noncod (periode);

-- cabang: unique name lookup & duplicate check
CREATE UNIQUE INDEX IF NOT EXISTS idx_cabang_nama
  ON cabang (nama);

-- cabang: order by area, nama (list display)
CREATE INDEX IF NOT EXISTS idx_cabang_area_nama
  ON cabang (area, nama);

-- settings: lookup by key (auth check — called on every write request)
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_key
  ON settings (key);

-- visitors: daily dedup check (tgl + visitor_id)
CREATE INDEX IF NOT EXISTS idx_visitors_tgl_vid
  ON visitors (tgl, visitor_id);

-- visitors: cleanup old records
CREATE INDEX IF NOT EXISTS idx_visitors_tgl
  ON visitors (tgl);
