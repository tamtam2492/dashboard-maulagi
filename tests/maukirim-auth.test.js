const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeMaukirimRedirectPath,
  performMaukirimCredentialLogin,
} = require('../api/_maukirim');

function createRequestSequence(steps) {
  const queue = Array.isArray(steps) ? steps.slice() : [];
  const calls = [];

  const request = async (options, body) => {
    calls.push({ options: { ...options }, body });
    if (!queue.length) throw new Error('Unexpected request call');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };

  request.calls = calls;
  return request;
}

test('normalizeMaukirimRedirectPath mengambil pathname dan search dari URL penuh', () => {
  assert.equal(
    normalizeMaukirimRedirectPath('https://app.maukirim.id/orders?page=2'),
    '/orders?page=2',
  );
  assert.equal(normalizeMaukirimRedirectPath('/dashboard'), '/dashboard');
});

test('performMaukirimCredentialLogin sukses saat login redirect ke halaman internal', async () => {
  const request = createRequestSequence([
    {
      status: 200,
      headers: { 'set-cookie': ['XSRF-TOKEN=csrf123; Path=/', 'laravel_session=sess1; Path=/'] },
      body: '<input type="hidden" name=_token value=token123>',
    },
    {
      status: 302,
      headers: { 'set-cookie': ['laravel_session=sess2; Path=/'], location: '/dashboard' },
      body: '',
    },
    {
      status: 200,
      headers: {},
      body: '<html><body>Selamat Datang</body></html>',
    },
  ]);

  const cookies = await performMaukirimCredentialLogin(request, '08123456789', 'secret-pass');

  assert.equal(request.calls.length, 3);
  assert.match(String(request.calls[1].body || ''), /whatsapp=08123456789/);
  assert.equal(cookies.laravel_session, 'sess2');
});

test('performMaukirimCredentialLogin menolak credential bila redirect balik ke login', async () => {
  const request = createRequestSequence([
    {
      status: 200,
      headers: { 'set-cookie': ['XSRF-TOKEN=csrf123; Path=/', 'laravel_session=sess1; Path=/'] },
      body: '<input type="hidden" name=_token value=token123>',
    },
    {
      status: 302,
      headers: { location: '/login' },
      body: '',
    },
  ]);

  await assert.rejects(
    () => performMaukirimCredentialLogin(request, '08123456789', 'wrong-pass'),
    (err) => err && err.code === 'MAUKIRIM_AUTH_FAILED',
  );
});