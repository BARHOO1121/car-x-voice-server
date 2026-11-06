const express = require('express');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { createGeminiProvider } = require('./gemini');

const MODEL = /^(?:models\/)?gemini-[A-Za-z0-9._-]{1,100}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function activationCode(device, salt) {
  // Match Java String.hashCode, rotateLeft and 32-bit overflow in NumericLicense.
  let hash = 0;
  const input = device + salt;
  for (let i = 0; i < input.length; i++) hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0;
  const value = (hash ^ 0x4b1d5a77 ^ 0x6c8e9cf5) | 0;
  const rotated = (value << 7) | (value >>> 25);
  return String((Math.imul(rotated, 0x045d9f3b) >>> 1) % 100000000).padStart(8, '0');
}

function createApp({ env = process.env, provider, logger = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const apiKey = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim();
  // Keep the existing app's license salt in Render secrets, never in this public repo.
  const salt = env.CARX_LICENSE_SALT || '';
  const allowedPackages = new Set((env.CARX_ALLOWED_PACKAGES || 'com.bydassistantng,com.bydassistantng.dev')
    .split(',').map(value => value.trim()).filter(Boolean));
  const gemini = provider || (apiKey ? createGeminiProvider(apiKey) : null);
  const ready = Boolean(apiKey && salt);

  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set('Cache-Control', 'no-store');
    res.set('X-Request-ID', res.locals.requestId);
    next();
  });

  function fail(res, status, code) {
    return res.status(status).json({ error: 'تعذر إتمام الطلب', code, requestId: res.locals.requestId });
  }

  app.get('/', (req, res) => res.status(200).send('Car X Voice Server is Live!'));
  // Use /healthz for Render liveness; /health is the Android protocol readiness check.
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/health', (req, res) => res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'not_ready',
    capabilities: ready ? ['generate', 'live-token'] : [],
    protocol: 1,
    ...(ready ? {} : { code: 'server_not_configured' }),
  }));

  function authorize(req, res, next) {
    if (!ready) return fail(res, 503, 'server_not_configured');
    const device = req.get('X-CarX-Device') || '';
    const license = req.get('X-CarX-License') || '';
    if (!/^\d{8}$/.test(device) || !/^\d{8}$/.test(license) ||
        !allowedPackages.has(req.get('X-CarX-Package')) ||
        !timingSafeEqual(Buffer.from(license), Buffer.from(activationCode(device, salt)))) {
      return fail(res, 403, 'activation_required');
    }
    next();
  }

  const parseBody = express.json({ limit: '10mb' });
  function modelName(value) {
    return typeof value === 'string' && MODEL.test(value) ? value.replace(/^models\//, '') : null;
  }
  function content(value) {
    return object(value) && Array.isArray(value.parts) && value.parts.length > 0 && value.parts.every(object);
  }

  function action(handler) {
    return async (req, res) => {
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', cancel);
      try {
        await handler(req, res, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        const upstreamStatus = Number(error.status) || 0;
        let status = 502;
        let code = 'provider_unavailable';
        if (error.name === 'TimeoutError' || error.name === 'AbortError' || upstreamStatus === 504) {
          status = 504; code = 'provider_timeout';
        } else if (upstreamStatus === 429) {
          status = 429; code = 'service_busy';
          res.set('Retry-After', '30');
        } else if (upstreamStatus === 401 || upstreamStatus === 403) {
          status = 503; code = 'provider_auth_error';
        } else if (upstreamStatus === 404) {
          status = 503; code = 'model_unavailable';
        } else if (upstreamStatus === 400) {
          status = 400; code = 'invalid_provider_request';
        }
        // No prompts, audio, activation headers, keys, tokens or raw provider errors in logs.
        logger.error('Gemini request failed', { code, upstreamStatus, requestId: res.locals.requestId });
        if (!res.headersSent && !res.destroyed) fail(res, status, code);
      } finally {
        res.off('close', cancel);
      }
    };
  }

  app.post('/api/generate', authorize, parseBody, action(async (req, res, signal) => {
    const body = req.body;
    const model = modelName(env.GEMINI_MODEL || body?.model);
    const request = body?.request;
    if (!model || !object(request) || !Array.isArray(request.contents) ||
        request.contents.length === 0 || !request.contents.every(content)) {
      return fail(res, 400, 'invalid_request');
    }
    // Forward the original Gemini envelope, including audio, tools and function results.
    res.json(await gemini.generate(model, request, signal));
  }));

  app.post('/api/live-token', authorize, parseBody, action(async (req, res, signal) => {
    const body = req.body;
    const model = modelName(env.GEMINI_LIVE_MODEL || body?.model);
    if (!model || !content(body?.systemInstruction) ||
        (body.tools != null && (!Array.isArray(body.tools) || !body.tools.every(object))) ||
        (body.voiceName != null && (typeof body.voiceName !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(body.voiceName)))) {
      return fail(res, 400, 'invalid_request');
    }
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const config = {
      responseModalities: ['AUDIO'],
      systemInstruction: body.systemInstruction,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(body.tools == null ? {} : { tools: body.tools }),
      ...(body.voiceName == null ? {} : {
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: body.voiceName } } },
      }),
    };
    const token = await gemini.createLiveToken({
      uses: 1,
      expireTime: expiresAt,
      newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
      liveConnectConstraints: { model, config },
      // Lock all setup fields to this activated client's requested configuration.
    }, signal);
    if (typeof token?.name !== 'string' || !token.name.startsWith('auth_tokens/') ||
        token.name.length > 16384) throw new Error('Invalid token response');
    res.json({ token: token.name, model, expiresAt });
  }));

  // Retain the old paths and reply shape; authenticated requests use the same Gemini provider.
  app.post(['/api/chat', '/chat', '/voice', '/'], authorize, parseBody, action(async (req, res, signal) => {
    const message = req.body?.message || req.body?.prompt;
    const model = modelName(env.GEMINI_MODEL || 'gemini-2.5-flash');
    if (!model || typeof message !== 'string' || !message.trim()) return fail(res, 400, 'invalid_request');
    const response = await gemini.generate(model, { contents: [{ role: 'user', parts: [{ text: message }] }] }, signal);
    const reply = response.candidates?.[0]?.content?.parts?.filter(part => !part.thought && typeof part.text === 'string')
      .map(part => part.text).join('');
    if (!reply) return fail(res, 502, 'empty_response');
    res.json({ reply });
  }));

  app.use((req, res) => fail(res, 404, 'not_found'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status === 413 ? 413 : 400;
    fail(res, status, status === 413 ? 'request_too_large' : 'invalid_json');
  });
  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => console.log(`Car X Voice listening on port ${port}`));
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = { createApp, activationCode };
