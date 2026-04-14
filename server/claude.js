const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set. Set it in .env or run with MOCK_MODE=1.');
    }
    _client = new Anthropic.default
      ? new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY })
      : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const MODELS = {
  orchestrator: 'claude-opus-4-6',
  worker: 'claude-sonnet-4-6',
};

// Extract the first JSON object from a text block (model sometimes wraps or chats).
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  // Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch {}
  // Strip code fences
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  // Find first { ... matching } via brace counting
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Concatenate all text blocks in a response.
function concatText(content) {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// Simple JSON call — no tools. Used for scoring, flags, contacts.
async function callJson({ model, system, user, maxTokens = 2048 }) {
  const resp = await client().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = concatText(resp.content);
  const parsed = extractJson(text);
  if (!parsed) {
    throw new Error(`Model did not return valid JSON. Raw: ${text.slice(0, 500)}`);
  }
  return { parsed, raw: text };
}

// Agentic loop with the server-side web_search tool.
// Loops until stop_reason is end_turn, or maxIterations exceeded.
async function callWithWebSearch({
  model,
  system,
  user,
  maxTokens = 4096,
  maxIterations = 8,
  maxSearches = 6,
}) {
  const tools = [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: maxSearches,
    },
  ];

  const messages = [{ role: 'user', content: user }];
  const sources = [];
  let finalText = '';
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    const resp = await client().messages.create({
      model,
      max_tokens: maxTokens,
      system,
      tools,
      messages,
    });

    // Collect any citations / web_search results as sources
    for (const block of resp.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r && r.type === 'web_search_result') {
            sources.push({ label: r.title || r.url, url: r.url });
          }
        }
      }
    }

    const stop = resp.stop_reason;
    if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens') {
      finalText = concatText(resp.content);
      // Server-side tool use is handled server-side; the assistant message
      // already contains the synthesized text. We're done.
      messages.push({ role: 'assistant', content: resp.content });
      break;
    }

    if (stop === 'pause_turn') {
      // Server-side tool loop paused — resume by sending the assistant response back.
      messages.push({ role: 'assistant', content: resp.content });
      continue;
    }

    // Fallback: tool_use stop_reason (shouldn't happen for server-side tools,
    // but handle defensively by breaking).
    messages.push({ role: 'assistant', content: resp.content });
    finalText = concatText(resp.content);
    break;
  }

  const parsed = extractJson(finalText);
  return { parsed, raw: finalText, sources, iterations: iteration };
}

module.exports = { MODELS, callJson, callWithWebSearch, extractJson };
