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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeLabel(value, fallback = '') {
  return String(value || fallback).trim();
}

function buildHeadline(payload) {
  const title = normalizeLabel(payload.title);
  if (title) return title;

  const severity = normalizeLabel(payload.severity, 'error').toUpperCase();
  const source = normalizeLabel(payload.source, 'backend').toUpperCase();
  const meta = payload && payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const method = normalizeLabel(meta.method).toUpperCase();
  const path = normalizeLabel(meta.path);
  const requestLabel = [method, path].filter(Boolean).join(' ').trim();
  return [severity, source, requestLabel].filter(Boolean).join(' • ');
}

function getOrderedMetaEntries(meta) {
  const sourceMeta = meta && typeof meta === 'object' ? meta : {};
  const preferredKeys = ['page', 'action', 'component', 'reason', 'method', 'path', 'url', 'line', 'column', 'periode', 'periodes', 'transferId', 'resi', 'cabang', 'statusCode', 'requestId', 'eventId', 'requestedAt'];
  const seen = new Set();
  const entries = [];

  for (const key of preferredKeys) {
    if (!(key in sourceMeta)) continue;
    const value = sourceMeta[key];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    entries.push([key, value]);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(sourceMeta)) {
    if (seen.has(key)) continue;
    if (value === undefined || value === null || String(value).trim() === '') continue;
    entries.push([key, value]);
  }

  return entries.slice(0, 10);
}

function formatMeta(meta) {
  const entries = getOrderedMetaEntries(meta);
  if (!entries.length) return '';

  return entries
    .map(([key, value]) => `<b>${escapeHtml(String(key || '').trim())}:</b> <code>${escapeHtml(String(value ?? '').trim())}</code>`)
    .join('\n');
}

function formatMessage(payload) {
  const lines = [];
  lines.push(`<b>${escapeHtml(buildHeadline(payload) || 'Ops Alert')}</b>`);

  const summary = [];
  if (payload.service) summary.push(`<b>Service:</b> <code>${escapeHtml(normalizeLabel(payload.service))}</code>`);
  if (payload.timestamp) summary.push(`<b>Waktu:</b> <code>${escapeHtml(normalizeLabel(payload.timestamp))}</code>`);
  if (payload.eventType && normalizeLabel(payload.eventType).toLowerCase() !== 'backend_error') {
    summary.push(`<b>Event:</b> <code>${escapeHtml(normalizeLabel(payload.eventType))}</code>`);
  }
  if (summary.length) {
    lines.push('');
    lines.push(summary.join('\n'));
  }

  if (payload.message) {
    lines.push('');
    lines.push('<b>Error:</b>');
    lines.push(`<pre>${escapeHtml(normalizeLabel(payload.message).slice(0, 1200))}</pre>`);
  }

  const metaBlock = formatMeta(payload.meta);
  if (metaBlock) {
    lines.push('');
    lines.push('<b>Konteks:</b>');
    lines.push(metaBlock);
  }

  return lines.join('\n');
}

export const handler = async (event) => {
  try {
    const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
    const sharedSecret = String(process.env.TELEGRAM_NOTIFY_SECRET || '').trim();
    const threadId = String(process.env.TELEGRAM_MESSAGE_THREAD_ID || '').trim();

    if (!botToken || !chatId) {
      return json(500, { error: 'TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID wajib diisi.' });
    }

    const hasHttpEnvelope = !!(event && (event.body !== undefined || event.headers));
    if (hasHttpEnvelope && sharedSecret) {
      const headers = normalizeHeaders(event.headers);
      const inboundSecret = headers['x-ops-secret'] || headers['x-telegram-notify-secret'] || '';
      if (inboundSecret !== sharedSecret) {
        return json(401, { error: 'Unauthorized.' });
      }
    }

    const payload = parseBody(event);
    const message = formatMessage(payload);
    if (!message.trim()) {
      return json(400, { error: 'Payload notifikasi kosong.' });
    }

    const requestBody = {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };

    if (threadId) {
      const numericThreadId = Number(threadId);
      if (Number.isFinite(numericThreadId) && numericThreadId > 0) {
        requestBody.message_thread_id = numericThreadId;
      }
    }

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return json(502, {
        error: 'Telegram API error.',
        status: response.status,
        preview: String(errorText || '').slice(0, 500),
      });
    }

    return json(200, { ok: true });
  } catch (err) {
    return json(500, {
      error: err && err.message ? err.message : 'Unexpected Lambda error.',
    });
  }
};
