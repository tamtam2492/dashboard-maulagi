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

function formatMeta(meta) {
  const entries = Object.entries(meta || {}).filter(([, value]) => value !== undefined);
  if (!entries.length) return '';
  return entries
    .slice(0, 8)
    .map(([key, value]) => `${String(key || '').trim()}: ${String(value ?? '').trim()}`)
    .join('\n');
}

function formatMessage(payload) {
  const lines = [];
  lines.push(String(payload.title || 'Ops Alert').trim());

  if (payload.service) lines.push(`service: ${String(payload.service).trim()}`);
  if (payload.severity) lines.push(`severity: ${String(payload.severity).trim()}`);
  if (payload.source) lines.push(`source: ${String(payload.source).trim()}`);
  if (payload.eventType) lines.push(`event: ${String(payload.eventType).trim()}`);
  if (payload.timestamp) lines.push(`time: ${String(payload.timestamp).trim()}`);
  if (payload.message) {
    lines.push('');
    lines.push(String(payload.message).trim());
  }

  const metaBlock = formatMeta(payload.meta);
  if (metaBlock) {
    lines.push('');
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