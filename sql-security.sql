-- =============================================================
-- Security hardening for all app tables in public schema
-- Jalankan setelah backend/server script memakai SUPABASE_SERVICE_ROLE_KEY
-- =============================================================

-- Tujuan:
-- 1. Tutup akses langsung anon/authenticated ke tabel aplikasi.
-- 2. Aktifkan RLS agar Supabase tidak menandai tabel public sebagai terbuka.
-- 3. Paksa semua akses data lewat backend server dengan service role key.

DO $$
DECLARE
  target_table text;
  policy_name text;
BEGIN
  FOR target_table IN
    SELECT unnest(ARRAY[
      'settings',
      'cabang',
      'transfers',
      'noncod',
      'visitors',
      'error_logs'
    ])
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = target_table
    ) THEN
      FOR policy_name IN
        SELECT pol.polname
        FROM pg_policy pol
        JOIN pg_class cls ON cls.oid = pol.polrelid
        JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname = 'public'
          AND cls.relname = target_table
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, target_table);
      END LOOP;

      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target_table);

      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', target_table);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', target_table);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
    END IF;
  END LOOP;
END $$;

-- Tidak dibuat policy anon/authenticated dengan sengaja.
-- Semua akses tabel aplikasi harus lewat backend server atau script maintenance
-- yang menggunakan SUPABASE_SERVICE_ROLE_KEY.