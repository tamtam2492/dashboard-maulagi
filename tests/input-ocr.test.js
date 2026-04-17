const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInputOcrController,
  matchBank,
  normalizeBankNameInput,
  parseOcrApiResponse,
} = require('../lib/input-ocr');

test('normalizeBankNameInput menormalkan variasi penulisan bank', () => {
  assert.equal(normalizeBankNameInput('  bri  '), 'BRI');
  assert.equal(normalizeBankNameInput('m-transfer bca'), 'BCA');
  assert.equal(normalizeBankNameInput(''), '');
});

test('matchBank memetakan channel OCR ke nama bank yang dipakai form', () => {
  assert.equal(matchBank('BRImo transfer'), 'BRI');
  assert.equal(matchBank('Livin by Mandiri'), 'MANDIRI');
  assert.equal(matchBank('m-Banking BCA'), 'BCA');
  assert.equal(matchBank('Unknown'), '');
});

test('parseOcrApiResponse membaca body JSON yang valid', () => {
  assert.deepEqual(parseOcrApiResponse(200, '{"channel":"BRI","nominal":132000}'), {
    channel: 'BRI',
    nominal: 132000,
  });
});

test('parseOcrApiResponse memberi pesan timeout yang jelas', () => {
  assert.throws(
    () => parseOcrApiResponse(504, '<html>timeout</html>'),
    /Server timeout/
  );
});

test('parseOcrApiResponse memberi pesan server error untuk body non-JSON', () => {
  assert.throws(
    () => parseOcrApiResponse(502, '<html>bad gateway</html>'),
    /Server error \(502\)/
  );
});

test('createInputOcrController mengabaikan hasil OCR lama saat file diganti', async () => {
  const state = {
    bank: '',
    nominal: 0,
  };
  const pendingStartRequests = [];
  let pollCount = 0;

  const controller = createInputOcrController({
    compressImage: async (dataUrl) => dataUrl,
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/input?ocr=1' && options.method === 'POST') {
        return new Promise((resolve, reject) => {
          const abort = () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          };

          if (options.signal) {
            if (options.signal.aborted) {
              abort();
              return;
            }
            options.signal.addEventListener('abort', abort, { once: true });
          }

          pendingStartRequests.push({ resolve, reject });
        });
      }

      if (url === '/api/input?ocr=1&job_id=job-2' && options.method === 'GET') {
        pollCount += 1;
        return {
          status: 200,
          ok: true,
          text: async () => (pollCount === 1
            ? '{"status":"processing"}'
            : '{"status":"succeeded","result":{"channel":"BRI","nominal":125000}}'),
        };
      }

      throw new Error('Unexpected fetch call: ' + url + ' (' + (options.method || 'GET') + ')');
    },
    setStatus() {},
    showFields() {},
    setBadge() {},
    setBankValue(value) {
      state.bank = value;
    },
    setNominalValue(value) {
      state.nominal = value;
    },
    onReadyChange() {},
    log() {},
    pollIntervalMs: 0,
    maxPollMs: 2000,
  });

  const firstRun = controller.runOCR('first-image', { force: true });
  await Promise.resolve();
  const secondRun = controller.runOCR('second-image', { force: true });
  await Promise.resolve();

  assert.equal(pendingStartRequests.length, 2);

  pendingStartRequests[1].resolve({
    status: 202,
    ok: true,
    text: async () => '{"accepted":true,"jobId":"job-2","status":"queued"}',
  });

  const secondResult = await secondRun;
  const firstResult = await firstRun;

  assert.deepEqual(firstResult, { ok: false, reason: 'aborted' });
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.reason, 'success');
  assert.equal(state.bank, 'BRI');
  assert.equal(state.nominal, 125000);
  assert.deepEqual(controller.getFilledState(), { bank: true, nominal: true });
});