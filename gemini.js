const { GoogleGenAI } = require('@google/genai');

function createGeminiProvider(apiKey, { fetchImpl = globalThis.fetch, timeoutMs = 35000 } = {}) {
  const ai = new GoogleGenAI({
    apiKey,
    vertexai: false,
    httpOptions: { apiVersion: 'v1beta', timeout: timeoutMs, fetch: fetchImpl, retryOptions: { attempts: 1 } },
  });
  return {
    async generate(model, request, signal) {
      if (!/^gemini-[A-Za-z0-9._-]{1,100}$/.test(model)) throw new Error('Invalid model');
      const deadline = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(request),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        redirect: 'error',
      });
      if (!response.ok) {
        // Discard the upstream body; it may contain credentials or user content.
        await response.body?.cancel();
        throw Object.assign(new Error('Gemini request failed'), { status: response.status });
      }
      const result = await response.json();
      if (!result || !Array.isArray(result.candidates)) throw new Error('Invalid Gemini response');
      return result;
    },
    createLiveToken(config, signal) {
      return ai.authTokens.create({ config: { ...config, abortSignal: signal } });
    },
  };
}

module.exports = { createGeminiProvider };
