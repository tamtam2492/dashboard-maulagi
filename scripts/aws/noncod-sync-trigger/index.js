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

function normalizePeriodes(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return [...new Set(values
    .map((value) => String(value || '').trim())
    .filter((value) => /^\d{4}-\d{2}$/.test(value)))].sort();
}

exports.handler = async (event) => {
  try {
    const triggerSecret = String(process.env.NONCOD_PIPELINE_TRIGGER_SECRET || '').trim();
    const endpointUrl = String(process.env.NONCOD_SYNC_ENDPOINT_URL || '').trim();
    const endpointSecret = String(process.env.NONCOD_SYNC_ENDPOINT_SECRET || '').trim();
    const defaultPeriodes = normalizePeriodes(process.env.NONCOD_SYNC_PERIODES || '');
    const defaultForce = String(process.env.NONCOD_SYNC_FORCE || '').trim().toLowerCase() !== 'false';

    if (!endpointUrl || !endpointSecret) {
      return json(500, { error: 'NONCOD_SYNC_ENDPOINT_URL dan NONCOD_SYNC_ENDPOINT_SECRET wajib diisi.' });
    }

    const hasHttpEnvelope = !!(event && (event.body !== undefined || event.headers));
    if (hasHttpEnvelope && triggerSecret) {
      const headers = normalizeHeaders(event.headers);
      const inboundSecret = headers['x-sync-secret'] || headers['x-ops-secret'] || '';
      if (inboundSecret !== triggerSecret) {
        return json(401, { error: 'Unauthorized.' });
      }
    }

    const payload = parseBody(event);
    const requestBody = {
      reason: String(payload.reason || 'lambda_background_sync').trim() || 'lambda_background_sync',
      periodes: normalizePeriodes(payload.periodes || defaultPeriodes),
      force: payload.force !== undefined ? payload.force !== false : defaultForce,
    };

    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sync-secret': endpointSecret,
      },
      body: JSON.stringify(requestBody),
    });

    const responseBody = await response.text();
    return json(response.status, {
      ok: response.ok,
      status: response.status,
      preview: String(responseBody || '').slice(0, 1000),
    });
  } catch (err) {
    return json(500, {
      error: err && err.message ? err.message : 'Unexpected Lambda error.',
    });
  }
};