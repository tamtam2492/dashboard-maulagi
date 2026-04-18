const ADMIN_WRITE_MARKER_KEY = 'admin_write_marker';
const ADMIN_WRITE_MARKER_WINDOW_MS = Math.max(10000, Number(process.env.ADMIN_WRITE_MARKER_WINDOW_MS || 60000) || 60000);
const ADMIN_WRITE_MARKER_RPC_NAME = 'touch_admin_write_marker';
const PERIODE_RE = /^\d{4}-\d{2}$/;
const FALLBACK_MARKER_SCOPES = Object.freeze([
  'overview',
  'noncod',
  'dfod',
  'transfer',
  'pending_allocation',
  'carryover',
  'audit',
  'admin_monitor',
  'admin_cabang',
  'manual_status',
]);

function normalizeMarkerVersion(value) {
  const version = Number(value || 0);
  return Number.isInteger(version) && version > 0 ? version : 0;
}

function normalizeMarkerTimestamp(value, fallback = '') {
  const normalized = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return normalized;
  const timestampMs = Date.parse(normalized);
  if (Number.isFinite(timestampMs)) return new Date(timestampMs).toISOString();
  return fallback || '';
}

function normalizeMarkerSource(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 64) || 'admin';
}

function normalizeMarkerScope(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40);
}

function normalizeMarkerScopes(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => normalizeMarkerScope(value))
    .filter(Boolean))];
}

function normalizeMarkerPeriodes(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value || '').trim())
    .filter((value) => PERIODE_RE.test(value)))];
}

function buildAdminWriteMarkerToken(version, changedAt) {
  return String(version || 0) + ':' + String(changedAt || '').trim();
}

function parseAdminWriteMarker(value) {
  if (!value) return null;

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const version = normalizeMarkerVersion(parsed && parsed.version);
    const changedAt = normalizeMarkerTimestamp(parsed && (parsed.changed_at || parsed.changedAt));
    if (!version || !changedAt) return null;

    const windowStartedAt = normalizeMarkerTimestamp(
      parsed && (parsed.window_started_at || parsed.windowStartedAt),
      changedAt,
    );
    const source = normalizeMarkerSource(parsed && parsed.source);
    const scopes = normalizeMarkerScopes(parsed && parsed.scopes);
    const periodes = normalizeMarkerPeriodes(parsed && parsed.periodes);

    return {
      version,
      token: buildAdminWriteMarkerToken(version, changedAt),
      changed_at: changedAt,
      window_started_at: windowStartedAt,
      source,
      scopes,
      periodes,
    };
  } catch {
    return null;
  }
}

function createAdminWriteMarker(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const changedAt = normalizeMarkerTimestamp(options.changed_at || options.changedAt, now.toISOString());
  const version = normalizeMarkerVersion(options.version) || 1;

  return {
    version,
    token: buildAdminWriteMarkerToken(version, changedAt),
    changed_at: changedAt,
    window_started_at: normalizeMarkerTimestamp(options.window_started_at || options.windowStartedAt, changedAt),
    source: normalizeMarkerSource(options.source),
    scopes: normalizeMarkerScopes(options.scopes),
    periodes: normalizeMarkerPeriodes(options.periodes),
  };
}

function shouldCompactMarker(currentMarker, nowMs, windowMs = ADMIN_WRITE_MARKER_WINDOW_MS) {
  if (!currentMarker || !currentMarker.window_started_at) return false;
  const startedAtMs = Date.parse(currentMarker.window_started_at);
  if (!Number.isFinite(startedAtMs)) return false;
  return nowMs - startedAtMs < Math.max(10000, Number(windowMs) || ADMIN_WRITE_MARKER_WINDOW_MS);
}

function mergeAdminWriteMarker(currentMarker, incoming, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const nowMs = now.getTime();
  const nextVersion = normalizeMarkerVersion(currentMarker && currentMarker.version) + 1 || 1;
  const normalizedIncoming = {
    source: normalizeMarkerSource(incoming && incoming.source),
    scopes: normalizeMarkerScopes(incoming && incoming.scopes),
    periodes: normalizeMarkerPeriodes(incoming && incoming.periodes),
  };

  if (shouldCompactMarker(currentMarker, nowMs, options.windowMs)) {
    return createAdminWriteMarker({
      version: nextVersion,
      now,
      changed_at: now.toISOString(),
      window_started_at: currentMarker.window_started_at,
      source: normalizedIncoming.source,
      scopes: [...new Set([...(currentMarker.scopes || []), ...normalizedIncoming.scopes])],
      periodes: [...new Set([...(currentMarker.periodes || []), ...normalizedIncoming.periodes])],
    });
  }

  return createAdminWriteMarker({
    version: nextVersion,
    now,
    changed_at: now.toISOString(),
    window_started_at: now.toISOString(),
    source: normalizedIncoming.source,
    scopes: normalizedIncoming.scopes,
    periodes: normalizedIncoming.periodes,
  });
}

function serializeAdminWriteMarker(marker) {
  return JSON.stringify({
    version: marker.version,
    changed_at: marker.changed_at,
    window_started_at: marker.window_started_at,
    source: marker.source,
    scopes: marker.scopes,
    periodes: marker.periodes,
  });
}

function createFallbackMarkerOptions(options = {}) {
  return {
    ...options,
    scopes: [...new Set([...FALLBACK_MARKER_SCOPES, ...normalizeMarkerScopes(options.scopes)])],
    periodes: [],
  };
}

async function readAdminWriteMarker(supabase) {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', ADMIN_WRITE_MARKER_KEY)
    .maybeSingle();

  if (error) throw error;
  return parseAdminWriteMarker(data && data.value);
}

async function writeAdminWriteMarker(supabase, marker) {
  const { error } = await supabase.from('settings').upsert({
    key: ADMIN_WRITE_MARKER_KEY,
    value: serializeAdminWriteMarker(marker),
  });
  if (error) throw error;
  return marker;
}

function isMissingMarkerRpcError(error) {
  const message = String(error && error.message || '');
  return /Could not find the function|function .* does not exist|schema cache/i.test(message);
}

async function publishAdminWriteMarkerViaRpc(supabase, options = {}) {
  const scopes = normalizeMarkerScopes(options.scopes);
  const periodes = normalizeMarkerPeriodes(options.periodes);
  const source = normalizeMarkerSource(options.source);
  const windowSeconds = Math.max(10, Math.ceil((Number(options.windowMs) || ADMIN_WRITE_MARKER_WINDOW_MS) / 1000));

  const { data, error } = await supabase.rpc(ADMIN_WRITE_MARKER_RPC_NAME, {
    p_source: source,
    p_scopes: scopes,
    p_periodes: periodes,
    p_window_seconds: windowSeconds,
  });

  if (error) throw error;
  const marker = parseAdminWriteMarker(Array.isArray(data) ? data[0] : data);
  if (!marker) throw new Error('Payload marker global dari RPC tidak valid.');
  return marker;
}

async function publishAdminWriteMarker(supabase, options = {}) {
  const normalizedScopes = normalizeMarkerScopes(options.scopes);
  const normalizedPeriodes = normalizeMarkerPeriodes(options.periodes);
  const normalizedSource = normalizeMarkerSource(options.source);
  const markerOptions = {
    source: normalizedSource,
    scopes: normalizedScopes.length ? normalizedScopes : ['admin'],
    periodes: normalizedPeriodes,
    windowMs: options.windowMs,
    now: options.now,
  };

  if (options.tryRpc !== false) {
    try {
      return await publishAdminWriteMarkerViaRpc(supabase, markerOptions);
    } catch (error) {
      if (!isMissingMarkerRpcError(error)) throw error;
    }
  }

  const fallbackMarkerOptions = createFallbackMarkerOptions(markerOptions);
  const currentMarker = await readAdminWriteMarker(supabase);
  const nextMarker = mergeAdminWriteMarker(currentMarker, fallbackMarkerOptions, {
    now: options.now,
    windowMs: options.windowMs,
  });
  return writeAdminWriteMarker(supabase, nextMarker);
}

module.exports = {
  ADMIN_WRITE_MARKER_KEY,
  ADMIN_WRITE_MARKER_RPC_NAME,
  ADMIN_WRITE_MARKER_WINDOW_MS,
  FALLBACK_MARKER_SCOPES,
  buildAdminWriteMarkerToken,
  createFallbackMarkerOptions,
  createAdminWriteMarker,
  mergeAdminWriteMarker,
  normalizeMarkerPeriodes,
  normalizeMarkerScopes,
  parseAdminWriteMarker,
  publishAdminWriteMarker,
  readAdminWriteMarker,
  shouldCompactMarker,
};