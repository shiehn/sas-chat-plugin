/**
 * Adapter: ChatAgent.LLMCallFn ↔ PluginHost.generateWithLLM.
 *
 * PluginHost's LLM interface is text-in/text-out (no native tool-calling).
 * The ChatAgent wants a structured tool-calling interface. This adapter
 * bridges them using a strict JSON protocol in the system prompt:
 *
 *   The LLM is instructed to emit either
 *     {"type": "text", "content": "..."}
 *   or
 *     {"type": "tool_use", "toolCalls": [{"id", "name", "parameters"}]}
 *
 * The adapter parses those shapes with graceful fallback to plain text
 * (so the agent loop always terminates even when the LLM goes off-protocol).
 */

import type { LLMCallFn, LLMRequest, LLMResponse, LLMMessage } from './chat-agent';

// -----------------------------------------------------------------------------
// Types — minimal subset of the PluginHost LLM signature
// -----------------------------------------------------------------------------

export interface PluginHostLLMRequest {
  system: string;
  user: string;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  skipContextPrefix?: boolean;
}

export interface PluginHostLLMResult {
  content: string;
  tokensUsed: number;
  model: string;
}

export type PluginHostLLMFn = (req: PluginHostLLMRequest) => Promise<PluginHostLLMResult>;

// -----------------------------------------------------------------------------
// Adapter factory
// -----------------------------------------------------------------------------

export function makeLLMAdapter(hostLLM: PluginHostLLMFn): LLMCallFn {
  return async (req: LLMRequest): Promise<LLMResponse> => {
    const system = buildSystemPrompt(req);
    const user = flattenHistory(req.messages);

    const result = await hostLLM({
      system,
      user,
      responseFormat: 'json',
      // We've already constructed the full system prompt — don't let the
      // host auto-prepend musical context (the agent's buildSceneContext
      // already injected what's needed).
      skipContextPrefix: true,
    });

    return parseResponse(result.content);
  };
}

// -----------------------------------------------------------------------------
// Prompt construction
// -----------------------------------------------------------------------------

function buildSystemPrompt(req: LLMRequest): string {
  const toolDocs = req.tools.length === 0
    ? 'No tools are available. Respond with text only.'
    : req.tools
        .map((t) => {
          const schema = JSON.stringify(t.parameters);
          return `  - ${t.name}: ${t.description}\n    parameters: ${schema}`;
        })
        .join('\n');

  // The JSON protocol block is exact — the parser expects these shapes.
  const protocol = [
    'Respond ONLY with a JSON object matching one of these two shapes:',
    '  {"type": "text", "content": "..."}        — when done, no tool needed',
    '  {"type": "tool_use", "toolCalls": [{"id": "c1", "name": "<tool>", "parameters": {...}}]}',
    'Tool call ids are arbitrary strings used to correlate with results.',
    'Do NOT wrap the JSON in prose or code fences. Emit the JSON directly.',
  ].join('\n');

  return [
    req.system,
    '',
    '---',
    'AVAILABLE TOOLS',
    toolDocs,
    '',
    '---',
    'RESPONSE PROTOCOL',
    protocol,
  ].join('\n');
}

function flattenHistory(messages: LLMMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'user') return `USER: ${m.content}`;
      if (m.role === 'assistant') return `ASSISTANT: ${m.content}`;
      if (m.role === 'tool') return `TOOL_RESULT id=${m.toolCallId}: ${m.content}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

// -----------------------------------------------------------------------------
// Response parsing
// -----------------------------------------------------------------------------

function parseResponse(raw: string): LLMResponse {
  const jsonText = extractJsonBlock(raw);
  if (jsonText === null) {
    // Graceful fallback — treat the whole response as plain text
    return { type: 'text', content: raw.trim() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { type: 'text', content: raw.trim() };
  }

  if (!isObj(parsed)) {
    return { type: 'text', content: raw.trim() };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.type === 'text' && typeof obj.content === 'string') {
    return { type: 'text', content: obj.content };
  }

  if (obj.type === 'tool_use' && Array.isArray(obj.toolCalls)) {
    const rawCalls = obj.toolCalls as unknown[];
    const toolCalls = rawCalls
      .filter(
        (c): c is { id?: string; name: string; parameters?: unknown } =>
          typeof c === 'object' && c !== null && typeof (c as { name?: unknown }).name === 'string'
      )
      .map((c, idx) => ({
        id: c.id ?? `call-${Date.now()}-${idx}`,
        name: c.name,
        parameters: (isObj(c.parameters) ? c.parameters : {}) as Record<string, unknown>,
      }));

    // Empty toolCalls array is nonsensical — degrade to text so the loop terminates
    if (toolCalls.length === 0) {
      return { type: 'text', content: '' };
    }

    return { type: 'tool_use', toolCalls };
  }

  // Unknown shape — fall back to text
  return { type: 'text', content: raw.trim() };
}

/**
 * Extract a JSON object from a raw LLM response that may include prose
 * wrappers or code fences. Returns the raw JSON text, or null if nothing
 * object-like is found.
 */
function extractJsonBlock(raw: string): string | null {
  const trimmed = raw.trim();

  // Direct JSON object
  if (trimmed.startsWith('{')) return trimmed;

  // Fenced code block: ```json ... ``` or ``` ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1].trim().startsWith('{')) {
    return fence[1].trim();
  }

  // Inline: find the first '{' and take everything until the matching '}'
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace === -1) return null;

  // Scan forward counting braces (naive but adequate for our JSON shapes)
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return trimmed.slice(firstBrace, i + 1);
      }
    }
  }
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
