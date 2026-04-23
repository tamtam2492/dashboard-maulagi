const { publishAdminWriteMarker } = require('../../../api/_admin-write-marker');
const { logError } = require('../../../api/_logger');
const {
  markNoncodSyncBuilding,
  markNoncodSyncFailed,
  markNoncodSyncPublished,
  normalizePeriodeList,
  queueNoncodPipelineTrigger,
} = require('../../../api/_noncod-sync-pipeline');
const { getSupabase } = require('../../../api/_supabase');
const noncodModule = require('../../../api/noncod');

const {
  getAutoSyncPeriods,
  isNoncodManualUploadOnly,
  isValidPeriodeParam,
  syncMaukirimPeriodes,
} = noncodModule;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  };
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[String(key || '').toLowerCase()] = String(value || '');
  }
  return normalized;
}

function parseBody(event) {
  if (event && typeof event.body === 'string' && event.body.trim()) {
    return JSON.parse(event.body);
  }
  if (event && event.body && typeof event.body === 'object') {
    return event.body;
  }
  return event || {};
}

function getRequestedPeriodes(payload) {
  const configuredPeriodes = normalizePeriodeList(process.env.NONCOD_SYNC_PERIODES || '');
  return normalizePeriodeList(payload && payload.periodes ? payload.periodes : configuredPeriodes)
    .filter((periode) => isValidPeriodeParam(periode));
}

function shouldForceSync(payload) {
  if (payload && payload.force !== undefined) return payload.force !== false;
  return String(process.env.NONCOD_SYNC_FORCE || '').trim().toLowerCase() !== 'false';
}

async function markWorkerFailed(reason, periodes, errorMessage) {
  try {
    const supabase = getSupabase();
    return await markNoncodSyncFailed(supabase, {
      reason,
      periodes,
      error: errorMessage,
    });
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  let reason = 'lambda_background_sync';
  let requestedPeriodes = [];

  try {
    const triggerSecret = String(process.env.NONCOD_PIPELINE_TRIGGER_SECRET || '').trim();
    const hasHttpEnvelope = !!(event && (event.body !== undefined || event.headers));
    if (hasHttpEnvelope && triggerSecret) {
      const headers = normalizeHeaders(event.headers);
      const inboundSecret = headers['x-noncod-secret'] || '';
      if (inboundSecret !== triggerSecret) {
        return json(401, { error: 'Unauthorized.' });
      }
    }

    const payload = parseBody(event);
    reason = String(payload.reason || 'lambda_background_sync').trim() || 'lambda_background_sync';
    requestedPeriodes = getRequestedPeriodes(payload);
    const force = shouldForceSync(payload);

    if (typeof isNoncodManualUploadOnly === 'function' && isNoncodManualUploadOnly()) {
      return json(410, {
        error: 'Sync MauKirim NONCOD dinonaktifkan. Gunakan upload workbook manual.',
      });
    }

    const supabase = getSupabase();
    const started = await markNoncodSyncBuilding(supabase, {
      reason,
      periodes: requestedPeriodes,
    });

    if (started.alreadyBuilding) {
      return json(202, {
        success: true,
        status: 'building',
        state: started.state,
      });
    }

    const periodesToSync = started.state.buildPeriodes.length
      ? started.state.buildPeriodes
      : getAutoSyncPeriods();

    const results = await syncMaukirimPeriodes(supabase, periodesToSync, { force });
    const nextState = await markNoncodSyncPublished(supabase, {
      periodes: periodesToSync,
      reason,
    });

    await publishAdminWriteMarker(supabase, {
      source: 'noncod_sync_published',
      scopes: ['overview', 'noncod', 'dfod', 'transfer', 'pending_allocation', 'audit', 'admin_monitor'],
      periodes: periodesToSync,
    });

    if (nextState.dirty && nextState.pendingPeriodes.length) {
      queueNoncodPipelineTrigger({
        reason: 'coalesced_rebuild',
        periodes: nextState.pendingPeriodes,
        source: 'noncod-sync-lambda',
      });
    }

    return json(200, {
      success: true,
      status: nextState.status,
      results,
      state: nextState,
    });
  } catch (err) {
    const detail = err && err.message ? err.message : 'Unexpected Lambda error.';
    const failedState = await markWorkerFailed(reason, requestedPeriodes, detail);
    logError('noncod-sync-worker', detail, {
      method: 'LAMBDA',
      reason,
      periodes: requestedPeriodes,
    });
    return json(500, {
      error: 'Gagal menjalankan Lambda sync NONCOD.',
      detail,
      state: failedState,
    });
  }
};