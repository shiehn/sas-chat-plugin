/**
 * GeminiBackend — default `AgentBackend` over the host's
 * `generateWithLLMTools` (gateway-proxied Gemini).
 *
 * Owns ALL Gemini-specific error-text classification. String matching on
 * provider error messages is legitimate HERE (it's the transport boundary —
 * upstream HTTP errors carry no structured taxonomy); it is forbidden
 * upstream in the loop, which keys recovery on `BackendError.kind` only.
 */

import type { PluginHost, LLMToolUseRequest, LLMToolUseResponse } from '@signalsandsorcery/plugin-sdk';
import { AgentBackend, AgentBackendCapabilities, BackendError, BackendErrorKind } from './backend';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.1-pro-preview';
/** Lightweight tier for compaction summarization — cheap, fast, no tools. */
export const GEMINI_COMPACTION_MODEL = 'gemini-2.5-flash';

/**
 * Classify a raw provider error into a `BackendError`. Exported for tests.
 *
 * Order matters: the history-shape 400 is checked before generic auth/4xx
 * buckets because its message also contains a status code.
 */
export function classifyGeminiError(err: unknown): BackendError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // Gemini rejects malformed turn alternation with a 400 mentioning
  // "function response"/"function call" ordering. Also bucket the
  // thought-signature replay rejection here — both are history-shape
  // problems fixed by trimming/normalizing the conversation.
  if (
    (message.includes('400') && lower.includes('function response')) ||
    lower.includes('thought_signature') ||
    lower.includes('thoughtsignature')
  ) {
    return new BackendError('history_shape', message, err);
  }

  if (
    message.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('resource exhausted') ||
    lower.includes('resource_exhausted')
  ) {
    return new BackendError('rate_limit', message, err);
  }

  if (
    message.includes('401') ||
    message.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('unauthenticated') ||
    lower.includes('permission denied') ||
    lower.includes('not authenticated') ||
    lower.includes('api key')
  ) {
    return new BackendError('auth', message, err);
  }

  if (
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('socket hang up') ||
    lower.includes('network')
  ) {
    return new BackendError('transient', message, err);
  }

  return new BackendError('other', message, err);
}

export interface GeminiBackendOptions {
  /** Override the agent-turn model (e.g. from plugin settings). */
  model?: string;
}

export class GeminiBackend implements AgentBackend {
  readonly name = 'gemini';
  readonly defaultModel: string;
  readonly compactionModel = GEMINI_COMPACTION_MODEL;
  readonly capabilities: AgentBackendCapabilities = {
    // Gemini-3 stamps thoughtSignature on functionCall parts; replay must
    // be byte-identical (see agent-loop history handling + compaction).
    preservesThoughtSignatures: true,
    // Gemini only accepts enum on string-typed properties (see
    // panel-tools sanitizeSchema).
    requiresStringEnums: true,
  };

  private readonly host: PluginHost;

  constructor(host: PluginHost, options: GeminiBackendOptions = {}) {
    this.host = host;
    this.defaultModel = options.model ?? GEMINI_DEFAULT_MODEL;
  }

  async complete(request: LLMToolUseRequest): Promise<LLMToolUseResponse> {
    try {
      return await this.host.generateWithLLMTools(request);
    } catch (err) {
      throw classifyGeminiError(err);
    }
  }
}

/** Narrow re-export so callers can switch on kinds without deep imports. */
export type { BackendErrorKind };
