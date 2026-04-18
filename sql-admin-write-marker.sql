-- =============================================================
-- Atomic admin write marker RPC for workspace refresh
-- Run this on Supabase SQL Editor after the settings table exists.
-- Safe to re-run.
-- =============================================================

-- RPC relies on a unique key lookup so the marker row stays singleton.
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_key
  ON public.settings (key);

CREATE OR REPLACE FUNCTION public.touch_admin_write_marker(
  p_source text DEFAULT 'admin',
  p_scopes text[] DEFAULT ARRAY[]::text[],
  p_periodes text[] DEFAULT ARRAY[]::text[],
  p_window_seconds integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  marker_key constant text := 'admin_write_marker';
  window_seconds integer := GREATEST(COALESCE(p_window_seconds, 60), 10);
  next_changed_at timestamptz := clock_timestamp();
  next_changed_at_text text := to_char(next_changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  normalized_source text := LEFT(regexp_replace(LOWER(TRIM(COALESCE(p_source, 'admin'))), '[^a-z0-9_-]+', '_', 'g'), 64);
  normalized_scopes text[];
  normalized_periodes text[];
  current_value text;
  current_json jsonb;
  current_version integer := 0;
  current_window_started_at timestamptz;
  current_window_started_at_text text;
  should_compact boolean := false;
  next_version integer;
  next_window_started_at_text text;
  merged_scopes text[];
  merged_periodes text[];
  next_payload jsonb;
BEGIN
  IF normalized_source IS NULL OR normalized_source = '' THEN
    normalized_source := 'admin';
  END IF;

  SELECT COALESCE(array_agg(scope_value ORDER BY first_pos), ARRAY[]::text[])
    INTO normalized_scopes
  FROM (
    SELECT scope_value, MIN(ordinality) AS first_pos
    FROM (
      SELECT LEFT(regexp_replace(LOWER(TRIM(COALESCE(raw_scope, ''))), '[^a-z0-9_-]+', '_', 'g'), 40) AS scope_value,
             ordinality
      FROM unnest(COALESCE(p_scopes, ARRAY[]::text[])) WITH ORDINALITY AS scope_rows(raw_scope, ordinality)
    ) normalized_scope_rows
    WHERE scope_value <> ''
    GROUP BY scope_value
  ) deduped_scope_rows;

  SELECT COALESCE(array_agg(periode_value ORDER BY first_pos), ARRAY[]::text[])
    INTO normalized_periodes
  FROM (
    SELECT periode_value, MIN(ordinality) AS first_pos
    FROM (
      SELECT TRIM(COALESCE(raw_periode, '')) AS periode_value,
             ordinality
      FROM unnest(COALESCE(p_periodes, ARRAY[]::text[])) WITH ORDINALITY AS periode_rows(raw_periode, ordinality)
    ) normalized_periode_rows
    WHERE periode_value ~ '^\d{4}-\d{2}$'
    GROUP BY periode_value
  ) deduped_periode_rows;

  INSERT INTO public.settings (key, value)
  VALUES (marker_key, '{}'::jsonb::text)
  ON CONFLICT (key) DO NOTHING;

  SELECT value
    INTO current_value
  FROM public.settings
  WHERE key = marker_key
  FOR UPDATE;

  IF current_value IS NOT NULL THEN
    BEGIN
      current_json := current_value::jsonb;
    EXCEPTION WHEN others THEN
      current_json := NULL;
    END;
  END IF;

  IF current_json IS NOT NULL THEN
    BEGIN
      current_version := GREATEST(COALESCE((current_json ->> 'version')::integer, 0), 0);
    EXCEPTION WHEN others THEN
      current_version := 0;
    END;

    current_window_started_at_text := NULLIF(TRIM(COALESCE(current_json ->> 'window_started_at', '')), '');
    IF current_window_started_at_text IS NOT NULL THEN
      BEGIN
        current_window_started_at := current_window_started_at_text::timestamptz;
      EXCEPTION WHEN others THEN
        current_window_started_at := NULL;
        current_window_started_at_text := NULL;
      END;
    END IF;
  END IF;

  should_compact := current_window_started_at IS NOT NULL
    AND EXTRACT(EPOCH FROM (next_changed_at - current_window_started_at)) < window_seconds;

  next_version := CASE WHEN current_version > 0 THEN current_version + 1 ELSE 1 END;

  IF should_compact THEN
    next_window_started_at_text := COALESCE(current_window_started_at_text, next_changed_at_text);

    SELECT COALESCE(array_agg(scope_value ORDER BY first_pos), ARRAY[]::text[])
      INTO merged_scopes
    FROM (
      SELECT scope_value, MIN(ordinality) AS first_pos
      FROM (
        SELECT LEFT(regexp_replace(LOWER(TRIM(COALESCE(raw_scope, ''))), '[^a-z0-9_-]+', '_', 'g'), 40) AS scope_value,
               ordinality
        FROM unnest(
          COALESCE(
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(current_json -> 'scopes', '[]'::jsonb))),
            ARRAY[]::text[]
          ) || normalized_scopes
        ) WITH ORDINALITY AS scope_rows(raw_scope, ordinality)
      ) merged_scope_rows
      WHERE scope_value <> ''
      GROUP BY scope_value
    ) deduped_scope_rows;

    SELECT COALESCE(array_agg(periode_value ORDER BY first_pos), ARRAY[]::text[])
      INTO merged_periodes
    FROM (
      SELECT periode_value, MIN(ordinality) AS first_pos
      FROM (
        SELECT TRIM(COALESCE(raw_periode, '')) AS periode_value,
               ordinality
        FROM unnest(
          COALESCE(
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(current_json -> 'periodes', '[]'::jsonb))),
            ARRAY[]::text[]
          ) || normalized_periodes
        ) WITH ORDINALITY AS periode_rows(raw_periode, ordinality)
      ) merged_periode_rows
      WHERE periode_value ~ '^\d{4}-\d{2}$'
      GROUP BY periode_value
    ) deduped_periode_rows;
  ELSE
    next_window_started_at_text := next_changed_at_text;
    merged_scopes := normalized_scopes;
    merged_periodes := normalized_periodes;
  END IF;

  next_payload := jsonb_build_object(
    'version', next_version,
    'changed_at', next_changed_at_text,
    'window_started_at', next_window_started_at_text,
    'source', normalized_source,
    'scopes', to_jsonb(COALESCE(merged_scopes, ARRAY[]::text[])),
    'periodes', to_jsonb(COALESCE(merged_periodes, ARRAY[]::text[]))
  );

  INSERT INTO public.settings (key, value)
  VALUES (marker_key, next_payload::text)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value;

  RETURN next_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_admin_write_marker(text, text[], text[], integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.touch_admin_write_marker(text, text[], text[], integer) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.touch_admin_write_marker(text, text[], text[], integer) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.touch_admin_write_marker(text, text[], text[], integer) TO service_role;
  END IF;
END $$;