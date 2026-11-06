const MAX_FALLBACK_OUTPUT_TOKENS = 1024;
const NO_HOSTED_TOOLS = 'Web search and other hosted tools are unavailable in this voice service. Use only the provided local functions. Do not claim to have searched the web or checked current information.';

// Vehicle, navigation and memory functions execute in Android. Google-hosted
// tools (Search, Maps grounding, URL context, etc.) are outside this voice plan.
function voiceTools(tools) {
  if (tools == null) return undefined;
  return tools.flatMap(tool => Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length
    ? [{ functionDeclarations: tool.functionDeclarations }]
    : []);
}

function voiceInstruction(systemInstruction, tools) {
  const removedHostedTool = tools?.some(tool => Object.keys(tool).some(key => key !== 'functionDeclarations'));
  if (!removedHostedTool) return systemInstruction;
  return {
    ...systemInstruction,
    parts: [...(systemInstruction?.parts || []), { text: NO_HOSTED_TOOLS }],
  };
}

function fallbackRequest(request) {
  const generationConfig = request.generationConfig || {};
  const requestedLimit = generationConfig.maxOutputTokens;
  const maxOutputTokens = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_FALLBACK_OUTPUT_TOKENS)
    : MAX_FALLBACK_OUTPUT_TOKENS;
  const tools = voiceTools(request.tools);
  const systemInstruction = voiceInstruction(request.systemInstruction, request.tools);
  return {
    ...request,
    ...(tools === undefined ? {} : { tools }),
    ...(systemInstruction === undefined ? {} : { systemInstruction }),
    generationConfig: { ...generationConfig, candidateCount: 1, maxOutputTokens },
  };
}

module.exports = { voiceTools, voiceInstruction, fallbackRequest };
