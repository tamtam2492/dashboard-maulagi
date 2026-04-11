-- =============================================================
-- Security hardening for settings table
-- Jalankan setelah SUPABASE_SERVICE_ROLE_KEY dipakai di backend server
-- =============================================================

-- Hapus policy lama di tabel settings agar tidak ada akses langsung yang tertinggal.
DO $$
DECLARE
  policy_name text;
BEGIN
  FOR policy_name IN
    SELECT pol.polname
    FROM pg_policy pol
    JOIN pg_class cls ON cls.oid = pol.polrelid
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    WHERE ns.nspname = 'public'
      AND cls.relname = 'settings'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.settings', policy_name);
  END LOOP;
END $$;

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.settings FROM anon;
REVOKE ALL ON TABLE public.settings FROM authenticated;
REVOKE ALL ON TABLE public.settings FROM PUBLIC;

-- Tidak ada policy anon/authenticated yang dibuat sengaja.
-- Akses tabel settings harus lewat backend server dengan service role key.