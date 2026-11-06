# Car X Voice Server

Backend for Dev Ibraheem's Car X Voice Android application. Supports its managed Gemini protocol while keeping the permanent Google key on the server.

## What was broken

- `@google/genai@^0.1.1` does not exist in npm, so dependency installation fails with `ETARGET`.
- The Android 1.5.0 source calls `/health`, `/api/generate` and `/api/live-token`. The previous server only had text-chat aliases, which cannot satisfy the voice protocol.
- Express's default 100 KB JSON limit rejects recorded audio. Reducing every response to `{reply}` also loses function calls and audio.

The SDK is now pinned to a published version with a committed lockfile. The protocol routes preserve audio, local function calls/results and Gemini responses, and issue constrained, single-use Live credentials. All generation routes validate the application's existing device activation headers. Legacy chat clients must now supply those same headers.

## Run on Render

Use the existing Web Service connected to this repository:

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Runtime | Node.js 24, selected by `.node-version` |
| Build command | `npm ci && npm test` |
| Start command | `npm start` |
| Render health check | `/healthz` |

Render supplies `PORT`; the server binds to `0.0.0.0`. Existing `npm install` builds still work, but `npm ci` uses the verified lockfile.

Set these environment variables in Render, not GitHub source:

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Google AI Studio key with access/quota for the requested Gemini models. `GOOGLE_API_KEY` is also accepted. |
| `CARX_LICENSE_SALT` | Exact suffix used by the existing Android `NumericLicense.activationCode` implementation. Supply it privately from the authorized app source; do not generate a new value or publish it. |
| `CARX_ALLOWED_PACKAGES` | Optional comma-separated package names. Defaults to `com.bydassistantng,com.bydassistantng.dev`. |
| `GEMINI_MODEL` | Optional REST/chat model override. Otherwise `/api/generate` uses the Android request's model and legacy chat retains `gemini-2.5-flash`. |
| `GEMINI_LIVE_MODEL` | Optional Live model override. The effective model is returned to Android for its WebSocket setup. |

`/healthz` confirms the process is reachable. `/health` reports `503 server_not_configured` until both required credentials are present. When configured it returns `{"status":"ok","capabilities":["generate","live-token"],"protocol":1}`. This checks configuration and protocol availability, not Google's current quota, key validity or model availability; those are verified by an authenticated generation/session request.

## Android protocol

All POST routes require the existing `X-CarX-Device`, `X-CarX-License` and `X-CarX-Package` headers supplied by `CarXServiceIdentity`. Invalid activation is rejected before contacting Google. The numeric v1 check is compatibility with the installed APK, not a replacement for a future server-managed activation registry.

- `POST /api/generate`: `{ "model": "gemini-...", "request": { "contents": [...], "systemInstruction": {...}, "tools": [...] } }`. Forwards recorded audio and function results under the cost policy below; returns the full Gemini JSON response.
- `POST /api/live-token`: `{ "model": "gemini-...", "voiceName": "Charon", "systemInstruction": { "parts": [...] }, "tools": [...] }`. Returns `{ "token": "auth_tokens/...", "model": "gemini-...", "expiresAt": "..." }`. Voice and local function declarations are retained in the constrained session. Tokens start one session within one minute and expire after 30 minutes. They are never cached.
- `POST /api/chat`, `/chat`, `/voice`, `/`: legacy `{ "message": "..." }` or `{ "prompt": "..." }`, returning `{ "reply": "..." }`.

JSON bodies are limited to 10 MiB. Google requests have a 35-second deadline. Structured errors distinguish invalid activation, missing configuration, quota, model availability and timeouts. Logs omit prompts, audio, credentials and raw Google error messages.

## Voice cost policy

- Both voice routes allow Android function declarations and remove Google-hosted tools such as Search, Maps grounding, URL context and code execution. Local vehicle commands and navigation functions remain available. A brief instruction is appended when a hosted tool is removed so the assistant does not claim it searched the web.
- The entire effective Live setup is locked in the ephemeral token. A client cannot turn hosted tools back on by sending them in its WebSocket setup. Native audio, voice choice and transcriptions are preserved.
- REST fallback and legacy chat request one candidate and at most 1,024 output tokens, including any thinking tokens counted by the model. A smaller caller limit is respected. Large fallback answers can end at this limit; Live speech is not capped by this setting.
- Health checks never call Google. The backend does not run background generation or retry generation automatically. Android 1.6 already ends a conversation after 12 seconds with no speech; its host preconnection sends only an unauthenticated HEAD request, not a model prompt.

This reduces optional costs, but is not a dollar budget or a guarantee that billing consists only of audio tokens. Voice sessions also process system instructions, function declarations/results and conversation context. The classic fallback still uses Gemini to understand a recorded utterance and, when needed, acknowledge a function result. Google billing limits must be managed separately in AI Studio. No Render plan or billing setting is changed by this policy.

## Verify

```sh
npm ci
npm test
```

Tests exercise real HTTP routes and the installed Google SDK using a simulated Google transport. They cover the Android contract, audio/tool preservation, activation checks, single-use token settings, timeout and error handling. They do not make paid Gemini calls or establish that a Render deployment is live. After deployment, verify `/health` and an activated app's REST and Live sessions with the actual configured Google account.

References: [Google ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens), [Live billing](https://ai.google.dev/gemini-api/docs/live-api/best-practices#pricing-billing), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).
