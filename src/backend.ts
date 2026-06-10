/**
 * AgentBackend — the provider seam between the agent loop and whichever
 * LLM actually completes requests.
 *
 * The loop (`agent-loop.ts`) is provider-agnostic: it builds Gemini-shaped
 * `LLMToolUseRequest`s (the SDK's lingua franca) and keys its recovery
 * policy on structured `BackendError.kind` values. Everything
 * provider-SPECIFIC — error-text classification, schema quirks, model ids —
 * lives behind this interface (`gemini-backend.ts` today; a Claude/OpenAI
 * backend can slot in without touching the loop).
 */

import type {
  LLMToolUseRequest,
  LLMToolUseResponse,
} from '@signalsandsorcery/plugin-sdk';

/**
 * Structured failure classes the loop's recovery policy keys on:
 *
 * - `history_shape` — the provider rejected the conversation's SHAPE
 *   (e.g. Gemini's 400 "function response turn comes immediately after a
 *   function call turn"). Recoverable by trimming/normalizing history.
 * - `rate_limit`  — quota/429. Recoverable by waiting; not by editing history.
 * - `auth`        — credentials problem. Not recoverable in-loop; surface it.
 * - `transient`   — network blips, 5xx, timeouts. Retry-once material.
 * - `other`       — everything else. Surface it.
 */
export type BackendErrorKind =
  | 'history_shape'
  | 'rate_limit'
  | 'auth'
  | 'transient'
  | 'other';

export class BackendError extends Error {
  readonly kind: BackendErrorKind;
  /** The provider's original error, for logs/diagnostics. */
  readonly cause?: unknown;

  constructor(kind: BackendErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'BackendError';
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * Provider quirks the REQUEST-BUILDING side needs to know about. The loop
 * and panel-tools consult these instead of hardcoding Gemini behavior.
 */
export interface AgentBackendCapabilities {
  /**
   * Provider stamps opaque signatures on functionCall parts (Gemini-3
   * `thoughtSignature`) that MUST be replayed verbatim on later turns.
   * When true, history surgery (compaction, trimming) must keep
   * functionCall parts byte-identical or drop the whole pair.
   */
  preservesThoughtSignatures: boolean;
  /**
   * Provider only accepts `enum` on string-typed schema properties
   * (Gemini). When true, tool-declaration sanitization stringifies
   * non-string enums and forces the property type to string.
   */
  requiresStringEnums: boolean;
  /** Optional cap on the number of tool declarations per request. */
  maxToolDeclarations?: number;
}

export interface AgentBackend {
  /** Short provider id for logs/metrics, e.g. 'gemini'. */
  readonly name: string;
  /** Model used for agent turns when the caller doesn't specify one. */
  readonly defaultModel: string;
  /**
   * Cheap/fast model for auxiliary work (conversation compaction
   * summarization). May equal `defaultModel` for providers without a
   * lightweight tier.
   */
  readonly compactionModel: string;
  readonly capabilities: AgentBackendCapabilities;
  /**
   * Complete one request. MUST throw `BackendError` (never raw provider
   * errors) so the loop's recovery policy stays structural.
   */
  complete(request: LLMToolUseRequest): Promise<LLMToolUseResponse>;
}
