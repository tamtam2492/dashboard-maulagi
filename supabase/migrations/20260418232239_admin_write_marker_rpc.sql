-- =============================================================
-- Atomic admin write marker RPC for workspace refresh.
-- Generated from sql-admin-write-marker.sql.
-- Safe to re-run.
-- =============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_key
	ON public.settings (key);

-- ---------------------------------------------------------------
-- Internal helpers — stateless, immutable, independently testable.
-- ---------------------------------------------------------------

-- Normalize a scope identifier: lowercase, collapse invalid chars to _, cap 40.
CREATE OR REPLACE FUNCTION public._mk_norm_scope(rv text)
RETURNS text LANGUAGE sql IMMUTABLE CALLED ON NULL INPUT AS $$
	SELECT LEFT(regexp_replace(LOWER(TRIM(COALESCE(rv, ''))), '[^a-z0-9_-]+', '_', 'g'), 40)
$$;

-- Validate and normalize a periode string (YYYY-MM); returns NULL if invalid.
CREATE OR REPLACE FUNCTION public._mk_norm_periode(rv text)
RETURNS text LANGUAGE sql IMMUTABLE CALLED ON NULL INPUT AS $$
	SELECT CASE WHEN TRIM(COALESCE(rv, '')) ~ '^\d{4}-\d{2}$' THEN TRIM(rv) ELSE NULL END
$$;

-- Drop both overloads to ensure clean recreation.
DROP FUNCTION IF EXISTS public.touch_admin_write_marker(text, text[], text[], integer);
DROP FUNCTION IF EXISTS public.touch_admin_write_marker(text, text[], text[]);

CREATE OR REPLACE FUNCTION public.touch_admin_write_marker(
	p_source   text    DEFAULT 'admin',
	p_scopes   text[]  DEFAULT ARRAY[]::text[],
	p_periodes text[]  DEFAULT ARRAY[]::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_marker_key   constant text    := 'admin_write_marker';
	v_window_secs  constant integer := 60;
	v_max_scopes   constant integer := 20;
	v_max_periodes constant integer := 24;

	-- clock_timestamp() (not now()) so elapsed-time check is accurate
	-- even when this function runs inside a long-lived transaction.
	v_now               timestamptz := clock_timestamp();
	v_now_text          text;
	v_source            text;
	v_input_scopes      text[];
	v_input_periodes    text[];
	v_current_raw       text;
	v_current           jsonb;
	v_current_version   integer := 0;
	v_win_start         timestamptz;
	v_win_start_text    text;
	v_in_window         boolean := false;
	v_next_version      integer;
	v_next_win_text     text;
	v_existing_scopes   text[] := ARRAY[]::text[];
	v_existing_periodes text[] := ARRAY[]::text[];
	v_merged_scopes     text[];
	v_merged_periodes   text[];
	v_payload           jsonb;
BEGIN
	v_now_text := to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

	-- Normalize source in one expression.
	v_source := COALESCE(
		NULLIF(LEFT(regexp_replace(LOWER(TRIM(COALESCE(p_source, ''))), '[^a-z0-9_-]+', '_', 'g'), 64), ''),
		'admin'
	);

	-- Normalize and deduplicate input scopes.
	-- p_scopes is a function parameter — PL/pgSQL substitutes it correctly in static SQL,
	-- including inside nested subqueries. No EXECUTE needed here.
	SELECT COALESCE(array_agg(n ORDER BY fp), ARRAY[]::text[])
		INTO v_input_scopes
	FROM (
		SELECT n, MIN(i) AS fp
		FROM (
			SELECT public._mk_norm_scope(rv) AS n, i
			FROM unnest(COALESCE(p_scopes, ARRAY[]::text[])) WITH ORDINALITY AS t(rv, i)
		) inner_q
		WHERE n <> ''
		GROUP BY n
	) outer_q;

	-- Normalize and deduplicate input periodes.
	SELECT COALESCE(array_agg(n ORDER BY fp), ARRAY[]::text[])
		INTO v_input_periodes
	FROM (
		SELECT n, MIN(i) AS fp
		FROM (
			SELECT public._mk_norm_periode(rv) AS n, i
			FROM unnest(COALESCE(p_periodes, ARRAY[]::text[])) WITH ORDINALITY AS t(rv, i)
		) inner_q
		WHERE n IS NOT NULL
		GROUP BY n
	) outer_q;

	-- Ensure marker row exists.
	INSERT INTO public.settings (key, value)
	VALUES (v_marker_key, '{}')
	ON CONFLICT (key) DO NOTHING;

	-- Read and lock the current marker row for the duration of this transaction.
	SELECT value
		INTO v_current_raw
	FROM public.settings
	WHERE key = v_marker_key
	FOR UPDATE;

	-- Parse stored marker JSON (silently resets to empty state on corruption).
	IF v_current_raw IS NOT NULL AND v_current_raw <> '' THEN
		BEGIN
			v_current := v_current_raw::jsonb;
		EXCEPTION WHEN others THEN
			v_current := NULL;
		END;
	END IF;

	IF v_current IS NOT NULL THEN
		BEGIN
			v_current_version := GREATEST(COALESCE((v_current ->> 'version')::integer, 0), 0);
		EXCEPTION WHEN others THEN
			v_current_version := 0;
		END;

		v_win_start_text := NULLIF(TRIM(COALESCE(v_current ->> 'window_started_at', '')), '');
		IF v_win_start_text IS NOT NULL THEN
			BEGIN
				v_win_start := v_win_start_text::timestamptz;
			EXCEPTION WHEN others THEN
				v_win_start := NULL;
				v_win_start_text := NULL;
			END;
		END IF;
	END IF;

	v_in_window := v_win_start IS NOT NULL
		AND EXTRACT(EPOCH FROM (v_now - v_win_start)) < v_window_secs;

	v_next_version := CASE WHEN v_current_version > 0 THEN v_current_version + 1 ELSE 1 END;

	IF v_in_window THEN
		v_next_win_text := COALESCE(v_win_start_text, v_now_text);

		SELECT COALESCE(array_agg(ev), ARRAY[]::text[])
			INTO v_existing_scopes
		FROM jsonb_array_elements_text(COALESCE(v_current -> 'scopes', '[]'::jsonb)) AS t(ev);

		SELECT COALESCE(array_agg(ev), ARRAY[]::text[])
			INTO v_existing_periodes
		FROM jsonb_array_elements_text(COALESCE(v_current -> 'periodes', '[]'::jsonb)) AS t(ev);

		-- Merge + deduplicate scopes (existing first, then new additions).
		-- EXECUTE USING is required for the merge queries: PL/pgSQL does NOT substitute
		-- local DECLARE-block variables (v_existing_scopes, v_input_scopes) when they
		-- appear as unnest() arguments inside nested subqueries — PostgreSQL tries to
		-- resolve them as relation names and throws 42P01 at runtime.
		-- Passing the concatenated array as a bound $1 parameter via USING avoids this.
		EXECUTE $q$
			SELECT COALESCE(array_agg(n ORDER BY fp), ARRAY[]::text[])
			FROM (
				SELECT n, MIN(i) AS fp
				FROM (
					SELECT public._mk_norm_scope(rv) AS n, i
					FROM unnest($1) WITH ORDINALITY AS t(rv, i)
				) inner_q
				WHERE n <> ''
				GROUP BY n
			) outer_q
		$q$ INTO v_merged_scopes USING (v_existing_scopes || v_input_scopes);

		-- Merge + deduplicate periodes.
		EXECUTE $q$
			SELECT COALESCE(array_agg(n ORDER BY fp), ARRAY[]::text[])
			FROM (
				SELECT n, MIN(i) AS fp
				FROM (
					SELECT public._mk_norm_periode(rv) AS n, i
					FROM unnest($1) WITH ORDINALITY AS t(rv, i)
				) inner_q
				WHERE n IS NOT NULL
				GROUP BY n
			) outer_q
		$q$ INTO v_merged_periodes USING (v_existing_periodes || v_input_periodes);

	ELSE
		v_next_win_text   := v_now_text;
		v_merged_scopes   := v_input_scopes;
		v_merged_periodes := v_input_periodes;
	END IF;

	-- Cap to prevent unbounded growth in a burst window.
	v_merged_scopes   := COALESCE(v_merged_scopes[1:v_max_scopes],    ARRAY[]::text[]);
	v_merged_periodes := COALESCE(v_merged_periodes[1:v_max_periodes], ARRAY[]::text[]);

	v_payload := jsonb_build_object(
		'version',           v_next_version,
		'changed_at',        v_now_text,
		'window_started_at', v_next_win_text,
		'source',            v_source,
		'scopes',            to_jsonb(v_merged_scopes),
		'periodes',          to_jsonb(v_merged_periodes)
	);

	INSERT INTO public.settings (key, value)
	VALUES (v_marker_key, v_payload::text)
	ON CONFLICT (key) DO UPDATE
		SET value = EXCLUDED.value;

	RETURN v_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_admin_write_marker(text, text[], text[]) FROM PUBLIC;

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON FUNCTION public.touch_admin_write_marker(text, text[], text[]) FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON FUNCTION public.touch_admin_write_marker(text, text[], text[]) FROM authenticated;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
		GRANT EXECUTE ON FUNCTION public.touch_admin_write_marker(text, text[], text[]) TO service_role;
	END IF;
END $$;
