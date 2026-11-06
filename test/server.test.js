const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp, activationCode } = require('../server');
const { createGeminiProvider } = require('../gemini');

// Synthetic credentials only. The production license salt is intentionally absent.
const env = { GEMINI_API_KEY: 'test-key-not-a-credential', CARX_LICENSE_SALT: '|test-fixture|' };
const device = '12345678';
const auth = {
  'X-CarX-Device': device,
  'X-CarX-License': activationCode(device, env.CARX_LICENSE_SALT),
  'X-CarX-Package': 'com.bydassistantng',
  'X-CarX-Protocol': '1',
};
const instruction = { parts: [{ text: 'Arabic or English only' }] };
const tools = [{ functionDeclarations: [{ name: 'set_window', description: 'Window', parameters: {
  type: 'OBJECT', properties: { position: { type: 'INTEGER' } },
} }] }];
const generateBody = {
  model: 'gemini-3.6-flash',
  request: { contents: [{ role: 'user', parts: [{ text: 'مرحبا' }] }], systemInstruction: instruction },
};
const liveBody = { model: 'gemini-3.8-live', voiceName: 'Charon', systemInstruction: instruction, tools };
const responseBody = { candidates: [{ content: { role: 'model', parts: [
  { text: 'أهلين إبراهيم' },
  { functionCall: { name: 'set_window', args: { position: 0 } } },
  { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'YWJj' } },
] } }] };

async function fixture(t, { settings = env, upstream, timeoutMs = 35000 } = {}) {
  const outgoing = [];
  const logs = [];
  const provider = createGeminiProvider(env.GEMINI_API_KEY, { timeoutMs, fetchImpl: async (url, options) => {
    outgoing.push({ url: String(url), ...options });
    if (upstream) return upstream(url, options);
    const body = String(url).endsWith('/auth_tokens') ? { name: `auth_tokens/test-${outgoing.length}` } : responseBody;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  } });
  const server = createApp({ env: settings, provider, logger: { error: (...args) => logs.push(args) } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = auth) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { base, post, outgoing, logs };
}

test('missing configuration stays alive but never advertises a ready voice service', async t => {
  for (const settings of [{}, { GEMINI_API_KEY: 'test' }, { CARX_LICENSE_SALT: 'test' }]) {
    const f = await fixture(t, { settings });
    assert.equal((await fetch(f.base + '/healthz')).status, 200);
    assert.equal((await fetch(f.base + '/')).status, 200);
    const health = await fetch(f.base + '/health');
    assert.equal(health.status, 503);
    assert.deepEqual((await health.json()).capabilities, []);
    assert.equal((await f.post('/api/live-token', liveBody)).status, 503);
    assert.equal(f.outgoing.length, 0);
  }
});

test('health satisfies the actual Android capability contract', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', capabilities: ['generate', 'live-token'], protocol: 1 });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(f.outgoing.length, 0);
});

test('audio over the former 100 KB limit, tool calls, results and Gemini responses survive unchanged', async t => {
  const f = await fixture(t);
  const body = structuredClone(generateBody);
  body.request.contents = [
    { role: 'user', parts: [{ inlineData: { mimeType: 'audio/m4a', data: 'YWJj'.repeat(40000) } }] },
    { role: 'model', parts: [{ functionCall: { name: 'set_window', args: { position: 0 } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'set_window', response: { status: 'ok' } } }] },
  ];
  body.request.tools = tools;
  body.request.generationConfig = { maxOutputTokens: 128 };
  const response = await f.post('/api/generate', body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), responseBody);
  assert.deepEqual(JSON.parse(f.outgoing[0].body), body.request);
  assert.equal(f.outgoing[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
  assert.equal(f.outgoing[0].headers['x-goog-api-key'], env.GEMINI_API_KEY);
  assert.equal(f.outgoing[0].redirect, 'error');
});

test('missing activation, another device, a bad license and another package never contact Google', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { ...auth, 'X-CarX-Device': '87654321' },
    { ...auth, 'X-CarX-License': '00000000' }, { ...auth, 'X-CarX-Package': 'untrusted.app' }]) {
    for (const [path, body] of [['/api/generate', generateBody], ['/api/live-token', liveBody], ['/api/chat', { message: 'hi' }]]) {
      const response = await f.post(path, body, headers);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'activation_required');
    }
  }
  assert.equal(f.outgoing.length, 0);
});

test('Live uses the real installed SDK and issues a new constrained single-use token per request', async t => {
  const f = await fixture(t);
  const tokens = [];
  for (let i = 0; i < 2; i++) {
    const start = Date.now();
    const response = await f.post('/api/live-token', liveBody);
    assert.equal(response.status, 200);
    const credentials = await response.json();
    tokens.push(credentials.token);
    assert.equal(credentials.model, liveBody.model);
    assert.ok(Date.parse(credentials.expiresAt) >= start + 29 * 60000);
    assert.ok(!JSON.stringify(credentials).includes(env.GEMINI_API_KEY));
  }
  assert.notEqual(tokens[0], tokens[1]);
  for (const request of f.outgoing) {
    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/auth_tokens');
    const body = JSON.parse(request.body);
    assert.equal(body.uses, 1);
    assert.ok(Date.parse(body.newSessionExpireTime) <= Date.now() + 60000);
    assert.equal(body.bidiGenerateContentSetup.model, 'models/' + liveBody.model);
    assert.deepEqual(body.bidiGenerateContentSetup.tools, tools);
    assert.deepEqual(body.bidiGenerateContentSetup.systemInstruction, instruction);
    assert.deepEqual(body.bidiGenerateContentSetup.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(body.bidiGenerateContentSetup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
    assert.deepEqual(body.bidiGenerateContentSetup.inputAudioTranscription, {});
    assert.deepEqual(body.bidiGenerateContentSetup.outputAudioTranscription, {});
  }
});

test('invalid models and request shapes cannot become a greeting or an upstream URL', async t => {
  const f = await fixture(t);
  for (const body of [{}, null, { ...generateBody, model: 'https://attacker.example' },
    { ...generateBody, model: 'gemini-../other' }, { ...generateBody, request: { contents: [] } }]) {
    assert.equal((await f.post('/api/generate', body)).status, 400);
  }
  for (const body of [{}, { ...liveBody, systemInstruction: {} }, { ...liveBody, tools: {} }, { ...liveBody, voiceName: 42 }]) {
    assert.equal((await f.post('/api/live-token', body)).status, 400);
  }
  assert.equal(f.outgoing.length, 0);
});

test('server model overrides return the effective model to the Live client', async t => {
  const f = await fixture(t, { settings: { ...env, GEMINI_MODEL: 'gemini-test-rest', GEMINI_LIVE_MODEL: 'models/gemini-test-live' } });
  assert.equal((await f.post('/api/generate', generateBody)).status, 200);
  const response = await f.post('/api/live-token', liveBody);
  assert.equal((await response.json()).model, 'gemini-test-live');
  assert.ok(f.outgoing[0].url.includes('/gemini-test-rest:generateContent'));
  assert.equal(JSON.parse(f.outgoing[1].body).bidiGenerateContentSetup.model, 'models/gemini-test-live');
});

test('provider errors are classified without leaking their body or credentials', async t => {
  for (const [upstreamStatus, expectedStatus, expectedCode] of [
    [429, 429, 'service_busy'], [403, 503, 'provider_auth_error'], [404, 503, 'model_unavailable'],
    [402, 503, 'provider_billing_error'],
    [500, 502, 'provider_unavailable'], [400, 400, 'invalid_provider_request'],
  ]) {
    const f = await fixture(t, { upstream: async () => new Response(JSON.stringify({ error: { message: 'private-provider-data', code: upstreamStatus } }), { status: upstreamStatus }) });
    const response = await f.post('/api/generate', generateBody);
    assert.equal(response.status, expectedStatus);
    const result = await response.json();
    assert.equal(result.code, expectedCode);
    if (upstreamStatus === 402) assert.equal(result.error, 'تحتاج فوترة Gemini إلى مراجعة لدى مدير الخدمة');
    assert.ok(result.requestId);
    assert.ok(!JSON.stringify([result, f.logs]).includes('private-provider-data'));
    assert.ok(!JSON.stringify([result, f.logs]).includes(env.GEMINI_API_KEY));
  }
});

test('SDK token failures do not leak raw Google errors either', async t => {
  const f = await fixture(t, { upstream: async () => new Response(JSON.stringify({ error: { code: 403, message: 'private-provider-data' } }), { status: 403 }) });
  const response = await f.post('/api/live-token', liveBody);
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.code, 'provider_auth_error');
  assert.ok(!JSON.stringify([result, f.logs]).includes('private-provider-data'));
});

test('a stalled upstream is aborted within the request deadline', async t => {
  const f = await fixture(t, { timeoutMs: 15, upstream: (url, options) => new Promise((resolve, reject) => {
    if (options.signal.aborted) reject(options.signal.reason);
    else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  const response = await f.post('/api/generate', generateBody);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'provider_timeout');
});

test('the old chat aliases retain their reply shape for activated clients', async t => {
  const f = await fixture(t);
  for (const path of ['/api/chat', '/chat', '/voice', '/']) {
    const response = await f.post(path, { prompt: 'مرحبا' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reply: 'أهلين إبراهيم' });
  }
  assert.equal((await f.post('/chat', {})).status, 400);
});

test('malformed JSON and oversized audio return JSON errors, not an HTML stack trace', async t => {
  const f = await fixture(t);
  const invalid = await fetch(f.base + '/api/generate', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'invalid_json');
  const huge = await f.post('/api/generate', { ...generateBody, padding: 'x'.repeat(10 * 1024 * 1024) });
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).code, 'request_too_large');
  assert.equal(f.outgoing.length, 0);
});
