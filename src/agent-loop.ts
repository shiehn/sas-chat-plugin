/**
 * AgentLoop — native-tool-use loop for the chat plugin.
 *
 * Replaces the prior `chat-agent.ts` (custom JSON-protocol-in-text loop) with
 * Gemini's native function-calling surface, exposed via the host's
 * `generateWithLLMTools` method (SDK 2.4.0+). The user-facing experience is
 * the same as VS Code agent mode or Claude Code at the terminal: natural
 * language in, model decides which CLI tools to call, observes results,
 * iterates, eventually emits a text response.
 *
 * The loop is iteration-capped (default 10) for safety. Tool execution is
 * delegated to a `ToolExecutor` callback, which in production spawns the
 * `sas` CLI subprocess (see `sas-tool-handler.ts`).
 */

import type {
  PluginHost,
  LLMContent,
  LLMPart,
  LLMTool,
  LLMToolUseRequest,
} from '@signalsandsorcery/plugin-sdk';
import { BackendError, type AgentBackend } from './backend';
import { GeminiBackend } from './gemini-backend';
import { ASK_USER_TOOL_NAME } from './constants';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A suggested follow-up the executor surfaces alongside a successful tool
 * call. Structurally mirrors `OperationResult.nextSteps[]` from
 * `sas-app/src/shared/types/tool-result.ts` but is declared locally so
 * `agent-loop` stays decoupled from SAS-specific types (Errantry-PI and any
 * future plugin can populate the field too).
 */
export interface AgentNextStep {
  description: string;
  cli?: string;
  mcp?: { tool: string; args: Record<string, unknown> };
  priority?: 'primary' | 'secondary';
}

/** Subset of `SasToolResult` the agent loop needs. */
export interface ToolExecutionResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Follow-up affordances. When non-empty AND `success === true`, the loop
   * emits a `next_steps` event so the UI can render clickable buttons next
   * to the tool's row. The executor is responsible for extracting these
   * from whatever its underlying transport returns (e.g. `panel-tools.ts`
   * pulls them out of the CLI's parsed OperationResult).
   */
  nextSteps?: AgentNextStep[];
}

/** One newline-delimited chunk of subprocess output, surfaced live by the executor. */
export interface ToolProgressChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

/**
 * One item inside a `workflow_progress` event. Used to surface incremental
 * status for long-running tools that internally fan out into sub-tasks the
 * agent loop can't see (e.g. `compose_scene`'s per-track MIDI generation).
 *
 * The UI groups items by the parent tool call's `callId` and renders them
 * inline under that ⚡ row.
 */
export interface WorkflowProgressItem {
  /** Human-readable label, e.g. a track description or role. */
  name: string;
  /**
   * 'planned'   — queued, not started yet
   * 'running'   — currently in progress
   * 'completed' — finished successfully
   * 'failed'    — finished with an error (see `error`)
   */
  status: 'planned' | 'running' | 'completed' | 'failed';
  error?: string;
}

/**
 * Executes a tool call. Returning a result (success or failure) lets the
 * model recover from errors; throwing should be reserved for truly
 * exceptional cases (spawn failure, timeout) and is wrapped into a
 * synthetic failure response so the loop continues.
 *
 * `onProgress` is optional — when provided, the executor SHOULD forward
 * each newline-delimited stdout/stderr line as it arrives so the UI can
 * surface "what the long-running tool is doing right now" instead of
 * sitting silent until close. Best-effort: dropping the callback or
 * never invoking it must not affect correctness.
 */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  onProgress?: (chunk: ToolProgressChunk) => void
) => Promise<ToolExecutionResult>;

export type AgentLoopEvent =
  | {
      type: 'llm_call_start';
      iteration: number;
    }
  | {
      type: 'llm_call_end';
      iteration: number;
    }
  | {
      type: 'tool_call_start';
      iteration: number;
      /** Synthetic id correlating start/done events for the same call. */
      callId: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
    }
  | {
      type: 'tool_progress';
      iteration: number;
      callId: string;
      stream: 'stdout' | 'stderr';
      line: string;
    }
  | {
      type: 'tool_call_done';
      iteration: number;
      callId: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
      result: ToolExecutionResult;
    }
  | {
      /**
       * Follow-up suggestions surfaced after a successful tool call. Emitted
       * immediately after `tool_call_done` when the executor populates
       * `result.nextSteps` and the call succeeded. Purely a UI signal — the
       * model already sees the full OperationResult JSON in the
       * `functionResponse` payload it gets fed for the next turn.
       */
      type: 'next_steps';
      iteration: number;
      callId: string;
      toolName: string;
      steps: AgentNextStep[];
    }
  | {
      /**
       * Incremental progress for a long-running tool that fans out into
       * sub-tasks the agent loop can't see directly (e.g. `compose_scene`'s
       * per-track MIDI generation). The host bridges these from a
       * domain-specific progress signal — the agent loop itself never
       * emits this; only the host's external translator does.
       *
       * `items` is a full snapshot every emission (not a delta), so the
       * reducer just replaces the row's items in place. `callId` MUST
       * match a prior `tool_call_start.callId` so the UI can inline the
       * progress under the owning ⚡ row.
       */
      type: 'workflow_progress';
      /** Associates with a prior `tool_call_start.callId`. */
      callId: string;
      /** Optional header, e.g. "Generating MIDI (4 tracks)". */
      label?: string;
      /** Full snapshot of the sub-task list. */
      items: WorkflowProgressItem[];
    }
  | { type: 'iteration_limit'; iterations: number }
  | {
      /**
       * The user approved continuing past the iteration budget (structural
       * continue-confirmation, Phase 2c). `newLimit` is the raised cap.
       */
      type: 'iterations_extended';
      iterations: number;
      newLimit: number;
    }
  | { type: 'final_text'; iterations: number; text: string };

export type AgentLoopEventHandler = (event: AgentLoopEvent) => void;

export interface AgentLoopOptions {
  host: PluginHost;
  /** Tool declarations exposed to the LLM. */
  tools: LLMTool[];
  /** Invoked when the LLM emits a `functionCall` part. */
  toolExecutor: ToolExecutor;
  /** System instruction text. */
  systemPrompt: string;
  /**
   * Provider seam. When omitted, a `GeminiBackend` is constructed over
   * `options.host` — the historical behavior. The loop keys its recovery
   * policy on `BackendError.kind`, never on provider error text.
   */
  backend?: AgentBackend;
  /** Model id. Default: the backend's `defaultModel` ('gemini-3.1-pro-preview'
   *  for the default GeminiBackend — Google's flagship agentic-tool-use model,
   *  Feb 2026; older 2.5-pro is materially weaker at recovering from
   *  structured tool errors). */
  model?: string;
  /** Iteration cap. Default: 25. Older default of 10 frequently exhausted on
   *  composite intents (compose_scene → tweak → preview); 25 leaves headroom
   *  for ambient-context recovery + clarification round-trips without going
   *  unbounded. Per-tool timeouts are the safety net. */
  maxIterations?: number;
  /** Optional event sink for streaming UI updates. */
  onEvent?: AgentLoopEventHandler;
  /** Optional callback that returns a "you are here" preamble injected into
   *  systemInstruction at the start of each `run()` call. Equivalent to
   *  Claude Code injecting `git status` + tree + CLAUDE.md every turn — gives
   *  the agent ambient project state so it doesn't have to call
   *  sas_inspect_project before every fuzzy reference. Failures are
   *  swallowed; the turn proceeds without ambient context. Called once per
   *  run() (not per iteration). */
  getAmbientContext?: () => Promise<string>;
}

export interface AgentLoopResult {
  /** Final assistant text. */
  text: string;
  /** Number of LLM turns the loop ran. */
  iterations: number;
  /** True when the loop exited because it hit `maxIterations`. */
  iterationLimitHit: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 25;
/** Iterations granted per user-approved extension at the budget cap. */
export const ITERATION_EXTENSION_STEP = 15;
/** Max number of user-approved extensions per turn. */
export const MAX_ITERATION_EXTENSIONS = 3;
/** Absolute per-turn iteration ceiling regardless of approvals. */
export const HARD_ITERATION_CEILING = 70;
const CONTINUE_OPTION = 'Keep going';
const STOP_OPTION = 'Stop and summarize';

/** Interpret the user's reply to the continue-at-cap question. Exported for
 *  tests. Quick-reply clicks return the option string verbatim; typed
 *  answers get a conservative affirmative check. */
export function isAffirmativeContinue(response: string): boolean {
  const t = (response ?? '').trim().toLowerCase();
  if (t.length === 0) return false;
  if (t.startsWith('keep')) return true;
  if (t.startsWith('continue')) return true;
  return ['y', 'yes', 'yes please', 'sure', 'ok', 'okay', 'go', 'go on', 'go ahead', 'proceed'].includes(t);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Drives a single conversation. One instance per chat session; call
 * `reset()` when switching scenes (chat is scene-scoped).
 *
 * Invariant — scene-change during a tool call must NOT corrupt `contents`
 * (C-8 in `docs/chat-cli-architecture.md`):
 *
 *   A tool the agent invokes (most commonly `compose_scene` or any
 *   `scene_activate`-adjacent flow) can switch the active scene while
 *   `run()` is still mid-iteration. The chat-plugin's `onSceneChanged`
 *   handler responds by calling `agent.reset()` to clear the (now-stale)
 *   conversation history. Without the deferral guards (`isRunning`,
 *   `pendingReset`), reset() would empty `contents` while iter N+1 still
 *   expects `[user, model(toolCall)]` in front of the upcoming
 *   `user(funcResponse)` turn. The result is a single-turn payload the
 *   Gemini API rejects with HTTP 400 ("function response turn comes
 *   immediately after a function call turn"), surfaced to the user as a
 *   confusing failure.
 *
 *   The contract this class enforces:
 *     1. While `isRunning` is true, any external `reset()` is recorded
 *        as a `pendingReset` and applied in the `finally` of `run()`.
 *     2. `contents` is only touched by `run()` while `isRunning` is
 *        true; nothing else may write to it.
 *     3. Tests covering this race live in `__tests__/agent-loop.test.ts`:
 *        "defers reset() requests that arrive while a run is in flight"
 *        (executor-triggered) and "defers reset() requests fired by the
 *        host-level onSceneChanged path" (integration-style).
 */
export class AgentLoop {
  private readonly host: PluginHost;
  private readonly backend: AgentBackend;
  /** Mutable: `updateToolSurface()` swaps these on scene change without
   *  dropping conversation history. Deferred while a run is in flight. */
  private tools: LLMTool[];
  private toolExecutor: ToolExecutor;
  private readonly systemPrompt: string;
  private readonly model: string;
  private readonly maxIterations: number;
  /** Prompt-token count reported by the most recent completion. Drives the
   *  start-of-turn compaction trigger (Phase 2b). `null` until the first
   *  completion of the session reports usage. */
  private lastPromptTokens: number | null = null;
  private readonly onEvent?: AgentLoopEventHandler;
  private readonly getAmbientContext?: () => Promise<string>;
  /** Ambient context fetched once at the start of each `run()` and reused
   *  across every iteration of that turn. Cleared between turns so a
   *  scene-change mid-turn is reflected on the NEXT user message. */
  private ambientThisTurn = '';

  private contents: LLMContent[] = [];
  private callIdCounter = 0;
  /** True while `run()` is mid-flight. Guards against external `reset()` calls
   *  (e.g. from the chat-plugin's `onSceneChanged` handler) clearing
   *  conversation history while a tool is executing — without this, iter 2
   *  fires with `contents = [user-funcResp]` only, which Gemini rejects with
   *  the misleading "function response turn comes immediately after a function
   *  call turn" error. The trigger is real-world: any tool call that creates
   *  and activates a new scene (e.g. `compose_scene`) re-enters the host's
   *  scene-change broadcast while the loop is still awaiting tool completion. */
  private isRunning = false;
  /** A reset() request that arrived while running; applied at run end. */
  private pendingReset = false;
  /** A tool-surface swap that arrived while running; applied at run end. */
  private pendingToolSurface: { tools: LLMTool[]; executor: ToolExecutor } | null = null;
  /** Context notes (scene-switch breadcrumbs etc.) prepended to the NEXT
   *  user message. Notes never splice into existing history — that would
   *  risk the Gemini turn-shape rules; prepending to a fresh user turn is
   *  always safe. */
  private pendingContextNotes: string[] = [];
  /** Force a compaction pass at the start of the next run regardless of
   *  thresholds (set when the persisted conversation exceeds its size cap). */
  private forceCompactRequested = false;

  constructor(options: AgentLoopOptions) {
    this.host = options.host;
    this.backend =
      options.backend ??
      new GeminiBackend(options.host, { model: options.model });
    this.tools = options.tools;
    this.toolExecutor = options.toolExecutor;
    this.systemPrompt = options.systemPrompt;
    this.model = options.model ?? this.backend.defaultModel;
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.onEvent = options.onEvent;
    this.getAmbientContext = options.getAmbientContext;
  }

  /** Drop conversation history (user "clear", project switch, Errantry
   *  reset). Defers if a run is in flight so we don't tear out
   *  [user, model(toolCall)] state while a toolExecutor is awaiting — see
   *  `isRunning` field comment. NOTE: scene changes no longer reset — they
   *  flow through `updateToolSurface` + `queueContextNote` (Phase 2b). */
  reset(): void {
    if (this.isRunning) {
      this.pendingReset = true;
      return;
    }
    this.contents = [];
  }

  /**
   * Seed conversation history from a persisted snapshot (app restart
   * restore). Ignored while a run is in flight — seeding mid-run could
   * corrupt the turn shape. Entries are minimally validated; garbage in
   * the store must never wedge the loop.
   */
  seedHistory(contents: LLMContent[]): void {
    if (this.isRunning) return;
    if (!Array.isArray(contents)) return;
    const valid = contents.filter(
      (c) =>
        c !== null &&
        typeof c === 'object' &&
        (c.role === 'user' || c.role === 'model') &&
        Array.isArray(c.parts),
    );
    this.contents = valid;
  }

  /** Deep-ish copy of the conversation for persistence. JSON round-trip
   *  keeps opaque fields (thoughtSignature) intact and guarantees the
   *  caller can't mutate live history. */
  getHistorySnapshot(): LLMContent[] {
    return JSON.parse(JSON.stringify(this.contents)) as LLMContent[];
  }

  /**
   * Swap the tool declarations + executor (scene change rebuilt the panel
   * surface) WITHOUT dropping conversation history. Deferred while a run
   * is in flight — declarations are rebuilt per request, so the new
   * surface takes effect on the next LLM call after application.
   */
  updateToolSurface(tools: LLMTool[], executor: ToolExecutor): void {
    if (this.isRunning) {
      this.pendingToolSurface = { tools, executor };
      return;
    }
    this.tools = tools;
    this.toolExecutor = executor;
  }

  /**
   * Queue a one-shot context note (e.g. "[state change] Active scene
   * switched …"). Prepended to the NEXT user message, then cleared.
   */
  queueContextNote(note: string): void {
    const trimmed = typeof note === 'string' ? note.trim() : '';
    if (trimmed.length > 0) this.pendingContextNotes.push(trimmed);
  }

  /** Force a compaction pass at the start of the next run (e.g. the
   *  persisted conversation exceeded its size cap). */
  requestCompaction(): void {
    this.forceCompactRequested = true;
  }

  /**
   * Run one user turn. Drives the model → tool call → tool response loop
   * until the model emits a text-only turn (success) or the iteration cap
   * is hit (timeout-style stop).
   */
  async run(
    userMessage: string,
    onEvent?: AgentLoopEventHandler
  ): Promise<AgentLoopResult> {
    const emit = (event: AgentLoopEvent): void => {
      const handler = onEvent ?? this.onEvent;
      if (!handler) return;
      try {
        handler(event);
      } catch {
        // Event handlers must never break the loop.
      }
    };

    if (this.isRunning) {
      // Concurrent run() call. The chat panel guards against this by disabling
      // the input box mid-send, but be defensive — surface the violation
      // instead of corrupting `this.contents` with interleaved turns.
      throw new Error(
        'AgentLoop.run() called while a previous run is still in flight'
      );
    }

    this.isRunning = true;
    try {
      return await this._runInner(userMessage, emit);
    } finally {
      this.isRunning = false;
      if (this.pendingReset) {
        this.pendingReset = false;
        this.contents = [];
      }
      if (this.pendingToolSurface) {
        this.tools = this.pendingToolSurface.tools;
        this.toolExecutor = this.pendingToolSurface.executor;
        this.pendingToolSurface = null;
      }
    }
  }

  private async _runInner(
    userMessage: string,
    emit: (event: AgentLoopEvent) => void
  ): Promise<AgentLoopResult> {
    // Refresh "you are here" context once at the start of the turn. State
    // changes the agent makes during the turn will surface in tool results;
    // we don't pay for re-inspection per iteration.
    this.ambientThisTurn = '';
    if (this.getAmbientContext) {
      try {
        this.ambientThisTurn = (await this.getAmbientContext()) ?? '';
      } catch {
        // Inspection failures must never block the turn.
        this.ambientThisTurn = '';
      }
    }

    // Start-of-turn compaction: between turns is the ONLY safe place to do
    // history surgery (no in-flight functionCall/functionResponse pairing).
    await this.maybeCompact();

    // One-shot context notes (scene-switch breadcrumbs) ride the front of
    // this user turn — prepending to a fresh user message never violates
    // the provider's turn-shape rules, unlike splicing into history.
    let effectiveMessage = userMessage;
    if (this.pendingContextNotes.length > 0) {
      effectiveMessage = `${this.pendingContextNotes.join('\n')}\n\n${userMessage}`;
      this.pendingContextNotes = [];
    }

    this.contents.push({
      role: 'user',
      parts: [{ text: effectiveMessage }],
    });

    let iteration = 0;
    /** Tracks empty-content retries (no tool calls + no text) on a per-iteration
     *  basis. Gemini occasionally returns `stopReason: STOP` with zero parts
     *  for clear actionable prompts ("Set tempo to 120", "Rename Old to New")
     *  — a transient model hiccup we recover from by re-issuing the same
     *  request once. If the retry also comes back empty, we fall through to
     *  the normal terminal-turn handling (which surfaces an empty-text
     *  diagnostic to the user). */
    let emptyRetriesUsed = 0;
    const MAX_EMPTY_RETRIES = 1;
    // Iteration budget with structural continue-confirmation (Phase 2c):
    // at the cap, the user is asked (via the ask_user transport) whether to
    // keep going; each approval grants ITERATION_EXTENSION_STEP more, up to
    // MAX_ITERATION_EXTENSIONS times / HARD_ITERATION_CEILING total.
    let effectiveMax = this.maxIterations;
    let extensionsGranted = 0;
    budget: for (;;) {
    while (iteration < effectiveMax) {
      iteration++;

      const sysText =
        this.ambientThisTurn.length > 0
          ? `${this.systemPrompt}\n\n${this.ambientThisTurn}`
          : this.systemPrompt;
      const request: LLMToolUseRequest = {
        model: this.model,
        // Pass a snapshot — the host (and any captured-by-reference mock or
        // analytics consumer) shouldn't see later mutations.
        contents: [...this.contents],
        systemInstruction: { parts: [{ text: sysText }] },
        tools: this.tools.length > 0 ? this.tools : undefined,
      };

      let response;
      emit({ type: 'llm_call_start', iteration });
      try {
        try {
          response = await this.backend.complete(request);
        } catch (err) {
          // The backend classifies provider failures into structural kinds
          // (BackendError.kind) — the loop's recovery policy keys on those,
          // never on provider error text.
          //
          // 'history_shape': the provider rejected the conversation's shape
          // (Gemini's 400 "function response turn comes immediately after a
          // function call turn" after a long sequence of failed tool calls,
          // or a stale thoughtSignature on a restored conversation).
          // Best-effort recovery: drop everything except the most recent
          // user message and retry once. If the retry also fails, surface
          // the error to the user.
          const isShapeError =
            err instanceof BackendError && err.kind === 'history_shape';
          if (isShapeError && iteration === 1 && this.contents.length > 1) {
            const lastUser = this.contents[this.contents.length - 1];
            this.contents = lastUser ? [lastUser] : [];
            response = await this.backend.complete({
              ...request,
              contents: [...this.contents],
            });
          } else {
            throw err;
          }
        }
      } finally {
        // Always pair llm_call_end with llm_call_start so the UI can clear
        // its "thinking" indicator even when the backend throws.
        emit({ type: 'llm_call_end', iteration });
      }
      // Track context pressure for the start-of-turn compaction trigger.
      if (typeof response.usageMetadata?.promptTokenCount === 'number') {
        this.lastPromptTokens = response.usageMetadata.promptTokenCount;
      }
      const candidate = response.candidates[0];
      if (!candidate) {
        // Empty candidate list shouldn't happen in normal flow; surface a
        // diagnostic instead of looping forever.
        const text = 'LLM returned no candidates.';
        emit({ type: 'final_text', iterations: iteration, text });
        return { text, iterations: iteration, iterationLimitHit: false };
      }

      // Record the model's response in conversation history. Important: this
      // includes `functionCall` parts, which Gemini requires to be present
      // when the next turn carries `functionResponse` parts.
      //
      // Defensive normalization: some upstream paths (proxy quirks, edge
      // cases) return content without an explicit role. Gemini's strict
      // alternation check rejects role-less turns with the misleading
      // "function response turn comes immediately after a function call
      // turn" error — force `role: 'model'` here so we always send a
      // well-formed turn.
      //
      // Gemini-3 also stamps a `thoughtSignature` on functionCall parts that
      // MUST be replayed verbatim on the next turn or the API rejects with a
      // 400. We copy `candidate.content.parts` by reference, so the field
      // survives intact — any future refactor that maps/filters/rebuilds parts
      // here MUST carry `functionCall.thoughtSignature` through. The round-trip
      // test in agent-loop.test.ts guards this.
      const modelContent: LLMContent = {
        role: candidate.content.role ?? 'model',
        parts: candidate.content.parts ?? [],
      };
      this.contents.push(modelContent);

      const parts = candidate.content.parts;
      const toolCallParts = parts.filter(hasFunctionCall);
      const textParts = parts.filter(hasText);

      // Empty-content retry: Gemini sometimes returns stopReason=STOP with
      // zero parts for clear tool-calling prompts. Pop the just-pushed empty
      // model turn and retry the same iteration once before giving up.
      if (
        toolCallParts.length === 0 &&
        textParts.length === 0 &&
        emptyRetriesUsed < MAX_EMPTY_RETRIES
      ) {
        emptyRetriesUsed++;
        this.contents.pop(); // drop the empty model turn we just appended
        iteration--; // re-enter the same iteration cleanly
        continue;
      }

      // No tool calls → terminal turn.
      if (toolCallParts.length === 0) {
        const text = textParts
          .map((p) => p.text)
          .join('\n')
          .trim();
        emit({ type: 'final_text', iterations: iteration, text });
        return { text, iterations: iteration, iterationLimitHit: false };
      }

      // Execute each tool call in order. Could be parallelized in the
      // future, but keeping serial mirrors how an agent at the terminal
      // typically thinks one step at a time.
      const toolResponseParts: LLMPart[] = [];
      for (const part of toolCallParts) {
        const { name, args } = part.functionCall;
        this.callIdCounter += 1;
        const callId = `c${this.callIdCounter}`;
        emit({
          type: 'tool_call_start',
          iteration,
          callId,
          toolName: name,
          toolArgs: args,
        });

        let result: ToolExecutionResult;
        const onProgress = (chunk: ToolProgressChunk): void => {
          emit({
            type: 'tool_progress',
            iteration,
            callId,
            stream: chunk.stream,
            line: chunk.line,
          });
        };
        try {
          result = await this.toolExecutor(name, args, onProgress);
        } catch (err) {
          const stderr = err instanceof Error ? err.message : String(err);
          result = { success: false, exitCode: -1, stdout: '', stderr };
        }

        emit({
          type: 'tool_call_done',
          iteration,
          callId,
          toolName: name,
          toolArgs: args,
          result,
        });

        // Surface follow-up suggestions only on success. A failed call's
        // remediation belongs in the tool_call_done error path; conflating
        // next_steps with recovery hints would muddle the UI affordance.
        if (result.success && result.nextSteps && result.nextSteps.length > 0) {
          emit({
            type: 'next_steps',
            iteration,
            callId,
            toolName: name,
            steps: result.nextSteps,
          });
        }

        toolResponseParts.push({
          functionResponse: {
            name,
            // Gemini accepts arbitrary JSON in the response. Mirror what the
            // CLI emits so the model sees the same fields a shell agent
            // would: success/exitCode/stdout/stderr.
            //
            // Truncate large outputs to keep the conversation context
            // bounded. compose_scene-class workflows return ~5kb operation
            // result JSON per call; over a few turns this saturates the
            // context window and Gemini starts rejecting requests with
            // misleading shape errors. The model only needs the head/tail
            // to recover; we keep both.
            response: {
              success: result.success,
              exitCode: result.exitCode,
              stdout: truncateForLLM(result.stdout),
              stderr: truncateForLLM(result.stderr),
            },
          },
        });
      }

      // Feed tool responses into the next turn as a user-role content block.
      this.contents.push({
        role: 'user',
        parts: toolResponseParts,
      });
    }

    // Budget exhausted mid-task. Ask the user (through the same ask_user
    // transport the model uses) whether to keep going. Decline, a missing
    // transport, or hitting the extension limits falls through to the
    // iteration_limit path below.
    if (
      extensionsGranted >= MAX_ITERATION_EXTENSIONS ||
      effectiveMax >= HARD_ITERATION_CEILING
    ) {
      break budget;
    }
    const approved = await this.confirmContinueAtCap(iteration);
    if (!approved) break budget;
    extensionsGranted++;
    effectiveMax = Math.min(
      effectiveMax + ITERATION_EXTENSION_STEP,
      HARD_ITERATION_CEILING,
    );
    emit({ type: 'iterations_extended', iterations: iteration, newLimit: effectiveMax });
    }

    // Iteration cap — bail with a clear message rather than looping forever.
    const cap =
      `I hit my iteration limit (${effectiveMax}). ` +
      `Tell me how you'd like to continue, or try a smaller subgoal.`;
    emit({ type: 'iteration_limit', iterations: iteration });
    emit({ type: 'final_text', iterations: iteration, text: cap });
    return { text: cap, iterations: iteration, iterationLimitHit: true };
  }

  /**
   * Ask the user whether to continue past the iteration budget, through the
   * SAME ask_user transport the model uses (so the question renders as a
   * quick-reply card in the chat UI). A missing transport (the executor
   * returns the structured "not available" failure) or any throw counts as
   * a decline — never block the turn on a question nobody can answer.
   */
  private async confirmContinueAtCap(iteration: number): Promise<boolean> {
    try {
      const result = await this.toolExecutor(ASK_USER_TOOL_NAME, {
        question:
          `I've used my step budget (${iteration} steps) and the task isn't finished. ` +
          'Keep going?',
        options: [CONTINUE_OPTION, STOP_OPTION],
      });
      if (!result.success) return false;
      return isAffirmativeContinue(result.stdout);
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Compaction (Phase 2b)
  //
  // Long-lived conversations (persistence + scene-switch continuity) need a
  // summarize-don't-wipe pressure valve. Triggered at the START of a run —
  // the only point with no in-flight functionCall/functionResponse pairing —
  // when the last completion reported high prompt-token pressure, the entry
  // count is large, or a caller forced it (persisted payload over its size
  // cap). The prefix is summarized by the backend's cheap compaction model;
  // the kept window starts at the LAST REAL USER MESSAGE so every
  // functionCall/functionResponse pair (and Gemini-3 thoughtSignature) in
  // the window survives byte-identical. Summarizer failure → proceed
  // uncompacted; compaction is an optimization, never a blocker.
  // -------------------------------------------------------------------------

  private async maybeCompact(): Promise<void> {
    const due =
      this.forceCompactRequested ||
      (this.lastPromptTokens !== null &&
        this.lastPromptTokens > COMPACT_PROMPT_TOKEN_THRESHOLD) ||
      this.contents.length > COMPACT_ENTRY_THRESHOLD;
    if (!due) return;

    const cut = findCompactionCut(this.contents);
    if (cut <= 0) {
      // Nothing summarizable (history empty / starts at the only real user
      // message). Clear the force flag so we don't retry every turn.
      this.forceCompactRequested = false;
      return;
    }

    const prefix = this.contents.slice(0, cut);
    const keptWindow = this.contents.slice(cut);
    try {
      const summary = await this.summarizeForCompaction(prefix);
      if (!summary) return;
      this.contents = [
        {
          role: 'user',
          parts: [
            {
              text:
                `[Conversation summary — ${prefix.length} earlier entries compacted. ` +
                `Treat this as ground truth for what happened before:]\n${summary}`,
            },
          ],
        },
        // Model ack keeps user/model alternation clean ahead of the kept
        // window (which starts with a real user message).
        { role: 'model', parts: [{ text: 'Understood — continuing from that summary.' }] },
        ...keptWindow,
      ];
      this.forceCompactRequested = false;
      // Token pressure is materially reduced; clear so we don't re-trigger
      // until the next completion reports fresh usage.
      this.lastPromptTokens = null;
    } catch {
      // Summarizer failure → proceed with the uncompacted conversation.
    }
  }

  /** One tool-free completion on the backend's cheap model. Returns null on
   *  empty output. Throws propagate to maybeCompact's catch. */
  private async summarizeForCompaction(prefix: LLMContent[]): Promise<string | null> {
    const transcript = renderTranscriptForCompaction(prefix);
    const response = await this.backend.complete({
      model: this.backend.compactionModel,
      contents: [
        {
          role: 'user',
          parts: [{ text: `${COMPACTION_PROMPT}\n\n--- TRANSCRIPT ---\n${transcript}` }],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      generationConfig: { maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS, temperature: 0.2 },
    });
    const parts = response.candidates[0]?.content.parts ?? [];
    const text = parts
      .filter(hasText)
      .map((p) => p.text)
      .join('\n')
      .trim();
    return text.length > 0 ? text : null;
  }
}

// ---------------------------------------------------------------------------
// Compaction constants + pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Prompt-token pressure (from the provider's own usage report) above which
 *  the next turn compacts. Well under Gemini's context limit — compaction
 *  should land long before requests start failing. */
const COMPACT_PROMPT_TOKEN_THRESHOLD = 60_000;
/** Entry-count fallback for hosts/providers that don't report usage. */
const COMPACT_ENTRY_THRESHOLD = 80;
/** Cap on the summary the compaction model may produce. */
const COMPACTION_MAX_OUTPUT_TOKENS = 1_200;
/** Cap on the serialized transcript fed to the summarizer (tail-sliced). */
const COMPACTION_TRANSCRIPT_CAP = 24_000;

const COMPACTION_PROMPT =
  'Summarize this assistant-session transcript for the assistant itself to resume from. ' +
  'PRESERVE: (1) user feedback and stated preferences — quote short phrases verbatim; ' +
  '(2) concrete parameter values and entity ids that were used (scene/track names and ids, BPM, keys, chord progressions); ' +
  '(3) decisions made and approaches that failed (so they are not retried); ' +
  '(4) open goals / unfinished work. ' +
  'OMIT pleasantries and tool-call mechanics. Write tight bullet points, no preamble.';

/**
 * Find the index of the LAST "real" user message — a user turn with text and
 * no functionResponse parts. Cutting there keeps the current task's full
 * turn (every functionCall/functionResponse pair intact, thoughtSignatures
 * byte-identical) and summarizes everything before it. Returns 0 when no
 * cut is useful (empty history, or the only real user message starts it).
 */
export function findCompactionCut(contents: LLMContent[]): number {
  for (let i = contents.length - 1; i > 0; i--) {
    const entry = contents[i];
    if (entry.role !== 'user') continue;
    const parts = entry.parts ?? [];
    const hasFunctionResponse = parts.some(
      (p) => (p as { functionResponse?: unknown }).functionResponse !== undefined,
    );
    const hasTextPart = parts.some(
      (p) => typeof (p as { text?: unknown }).text === 'string',
    );
    if (!hasFunctionResponse && hasTextPart) return i;
  }
  return 0;
}

/** Render history entries as a compact text transcript for the summarizer.
 *  Tool calls/results are abbreviated — the summary needs outcomes, not
 *  payloads. Tail-sliced to `COMPACTION_TRANSCRIPT_CAP` chars. */
export function renderTranscriptForCompaction(contents: LLMContent[]): string {
  const lines: string[] = [];
  for (const entry of contents) {
    for (const part of entry.parts ?? []) {
      const p = part as {
        text?: string;
        functionCall?: { name: string; args: Record<string, unknown> };
        functionResponse?: { name: string; response?: Record<string, unknown> };
      };
      if (typeof p.text === 'string' && p.text.length > 0) {
        lines.push(`${entry.role}: ${p.text}`);
      } else if (p.functionCall) {
        let args = '';
        try {
          args = JSON.stringify(p.functionCall.args).slice(0, 200);
        } catch {
          args = '<unserializable>';
        }
        lines.push(`${entry.role} → tool ${p.functionCall.name}(${args})`);
      } else if (p.functionResponse) {
        const resp = p.functionResponse.response ?? {};
        const ok = (resp as { success?: unknown }).success === true;
        let detail = '';
        try {
          detail = JSON.stringify(resp).slice(0, 200);
        } catch {
          detail = '';
        }
        lines.push(
          `tool ${p.functionResponse.name} ← ${ok ? 'OK' : 'FAILED'} ${detail}`,
        );
      }
    }
  }
  const joined = lines.join('\n');
  return joined.length <= COMPACTION_TRANSCRIPT_CAP
    ? joined
    : joined.slice(-COMPACTION_TRANSCRIPT_CAP);
}

// ---------------------------------------------------------------------------
// Type guards (preserve narrowing through `.filter`)
// ---------------------------------------------------------------------------

function hasFunctionCall(
  part: LLMPart
): part is LLMPart & { functionCall: NonNullable<LLMPart['functionCall']> } {
  return Boolean(part.functionCall);
}

function hasText(part: LLMPart): part is LLMPart & { text: string } {
  return typeof part.text === 'string' && part.text.length > 0;
}

/** Cap CLI output fed back to the LLM. Big enough for any reasonable
 *  remediation envelope; small enough that a few turns don't blow the
 *  context budget. For OperationResult-shaped JSON the truncator preserves
 *  the load-bearing metadata fields (success, error, remediation,
 *  clarification, nextSteps, suggestion) and only trims bulky `changes`
 *  payloads (db_query rows, candidate lists). For everything else it falls
 *  back to head + tail slicing.
 *
 *  ⚠️ KEEP IN SYNC with `sas-app/src/shared/utils/operation-result-truncate.ts`.
 *  This is the canonical algorithm; it lives here too because the chat-plugin
 *  is a sibling repo (git submodule) and can't import directly from
 *  sas-app. If you change either copy, propagate to the other.
 *  Resolves C-4 in `docs/chat-cli-architecture.md`. A parity test lives in
 *  the chat-plugin's __tests__ to catch drift.
 */
const LLM_OUTPUT_CAP = 4_000;
const LLM_OUTPUT_HEAD = 2_400;
const LLM_OUTPUT_TAIL = 1_200;

/** Max items to keep verbatim in a candidate list (availableScenes etc.).
 *  Beyond this we keep the first N + a count summary — enough for the agent
 *  to call ask_user with a meaningful menu without blowing the budget. */
const MAX_CANDIDATE_ITEMS = 12;
/** Max rows to keep verbatim from a db_query result. */
const MAX_DB_ROWS = 20;

interface OperationResultLike {
  success?: unknown;
  changes?: Record<string, unknown>;
  [key: string]: unknown;
}

function looksLikeOperationResult(parsed: unknown): parsed is OperationResultLike {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    'success' in (parsed as Record<string, unknown>)
  );
}

/** Trim a candidate item to its identifying fields. Drops timestamps, plugin
 *  parameter blobs, and other bulk that the agent doesn't need to disambiguate. */
function trimCandidate(item: unknown): unknown {
  if (typeof item !== 'object' || item === null) return item;
  const src = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'name', 'displayName', 'role', 'genre', 'key', 'lengthBars', 'sceneId', 'engineTrackId']) {
    if (key in src) out[key] = src[key];
  }
  return Object.keys(out).length > 0 ? out : item;
}

/** Fields inside `changes` whose contents must survive intact. Everything else
 *  is fair game for summarization when the envelope overflows. */
const CHANGES_PRESERVE = new Set([
  'availableScenes', 'availableTracks', 'availableTransitions', 'options',
  'rows', 'rowCount', 'columns', 'truncated',
  // Identity / counts that the agent commonly reads:
  'sceneId', 'trackId', 'transitionId', 'projectId', 'engineTrackId', 'jobId',
  'count', 'total', 'name', 'displayName', 'role', 'status',
]);

/** Max length for arbitrary string fields in `changes` before we summarize. */
const MAX_CHANGES_STRING_LEN = 500;

/** Trim bulky `changes` sub-arrays in place, returning a new shallow copy. */
function trimChanges(changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...changes };

  for (const key of ['availableScenes', 'availableTracks', 'availableTransitions', 'options']) {
    const v = out[key];
    if (Array.isArray(v) && v.length > 0) {
      const trimmed = v.slice(0, MAX_CANDIDATE_ITEMS).map(trimCandidate);
      out[key] = v.length > MAX_CANDIDATE_ITEMS
        ? [...trimmed, `[+${v.length - MAX_CANDIDATE_ITEMS} more — call db_query or sas_inspect_project for the full list]`]
        : trimmed;
    }
  }

  if (Array.isArray(out.rows) && (out.rows as unknown[]).length > MAX_DB_ROWS) {
    const rows = out.rows as unknown[];
    out.rows = [...rows.slice(0, MAX_DB_ROWS), `[+${rows.length - MAX_DB_ROWS} more rows — add LIMIT or refine the WHERE clause]`];
    out.truncated = true;
  }

  // Any other long string in `changes` (debug blobs, base64 audio metadata,
  // verbose snapshots) gets summarized so it can't crowd out the envelope.
  for (const key of Object.keys(out)) {
    if (CHANGES_PRESERVE.has(key)) continue;
    const v = out[key];
    if (typeof v === 'string' && v.length > MAX_CHANGES_STRING_LEN) {
      out[key] = `[${v.length} chars omitted from changes.${key} — call the relevant inspect_* tool if you need it]`;
    }
  }

  return out;
}

export function truncateForLLM(s: string): string {
  if (typeof s !== 'string') return s;
  if (s.length <= LLM_OUTPUT_CAP) return s;

  // Try envelope-aware path first. If the payload is an OperationResult
  // we preserve clarification + remediation in full and only trim bulky
  // candidate / row arrays. This stops the agent from seeing "I'm
  // ambiguous" without the actual options to feed ask_user.
  try {
    const parsed: unknown = JSON.parse(s);
    if (looksLikeOperationResult(parsed)) {
      const trimmed: OperationResultLike = { ...parsed };
      if (trimmed.changes && typeof trimmed.changes === 'object' && !Array.isArray(trimmed.changes)) {
        trimmed.changes = trimChanges(trimmed.changes as Record<string, unknown>);
      }
      const re = JSON.stringify(trimmed);
      if (re.length <= LLM_OUTPUT_CAP) return re;
      // Still too big after trimming candidates — fall through to head/tail
      // on the re-serialized form, which at least keeps clarification intact
      // if it fits in the head.
      return headTail(re);
    }
  } catch {
    // not JSON, fall through
  }

  return headTail(s);
}

function headTail(s: string): string {
  const head = s.slice(0, LLM_OUTPUT_HEAD);
  const tail = s.slice(-LLM_OUTPUT_TAIL);
  const omitted = s.length - head.length - tail.length;
  return `${head}\n\n[... ${omitted} chars truncated ...]\n\n${tail}`;
}
