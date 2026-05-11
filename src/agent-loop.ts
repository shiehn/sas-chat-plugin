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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A suggested follow-up the executor surfaces alongside a successful tool
 * call. Structurally mirrors `OperationResult.nextSteps[]` from
 * `sas-assistant/src/shared/types/tool-result.ts` but is declared locally so
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
  | { type: 'iteration_limit'; iterations: number }
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
  /** Gemini model id. Default: 'gemini-2.5-flash'. */
  model?: string;
  /** Iteration cap. Default: 10. */
  maxIterations?: number;
  /** Optional event sink for streaming UI updates. */
  onEvent?: AgentLoopEventHandler;
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

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MODEL = 'gemini-2.5-flash';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Drives a single conversation. One instance per chat session; call
 * `reset()` when switching scenes (chat is scene-scoped).
 */
export class AgentLoop {
  private readonly host: PluginHost;
  private readonly tools: LLMTool[];
  private readonly toolExecutor: ToolExecutor;
  private readonly systemPrompt: string;
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly onEvent?: AgentLoopEventHandler;

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

  constructor(options: AgentLoopOptions) {
    this.host = options.host;
    this.tools = options.tools;
    this.toolExecutor = options.toolExecutor;
    this.systemPrompt = options.systemPrompt;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.onEvent = options.onEvent;
  }

  /** Drop conversation history (called on scene change). Defers if a run is
   *  in flight so we don't tear out [user, model(toolCall)] state while a
   *  toolExecutor is awaiting — see `isRunning` field comment. */
  reset(): void {
    if (this.isRunning) {
      this.pendingReset = true;
      return;
    }
    this.contents = [];
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
    }
  }

  private async _runInner(
    userMessage: string,
    emit: (event: AgentLoopEvent) => void
  ): Promise<AgentLoopResult> {
    this.contents.push({
      role: 'user',
      parts: [{ text: userMessage }],
    });

    let iteration = 0;
    while (iteration < this.maxIterations) {
      iteration++;

      const request: LLMToolUseRequest = {
        model: this.model,
        // Pass a snapshot — the host (and any captured-by-reference mock or
        // analytics consumer) shouldn't see later mutations.
        contents: [...this.contents],
        systemInstruction: { parts: [{ text: this.systemPrompt }] },
        tools: this.tools.length > 0 ? this.tools : undefined,
      };

      let response;
      emit({ type: 'llm_call_start', iteration });
      try {
        try {
          response = await this.host.generateWithLLMTools(request);
        } catch (err) {
          // Gemini sometimes rejects an otherwise-valid conversation with the
          // 400 "function response turn comes immediately after a function
          // call turn" error after a long sequence of failed tool calls.
          // Best-effort recovery: drop everything except the most recent
          // user message and retry once. If the retry also fails, surface
          // the error to the user.
          const message = err instanceof Error ? err.message : String(err);
          const isShapeError =
            message.includes('400') &&
            message.toLowerCase().includes('function response');
          if (isShapeError && iteration === 1 && this.contents.length > 1) {
            const lastUser = this.contents[this.contents.length - 1];
            this.contents = lastUser ? [lastUser] : [];
            response = await this.host.generateWithLLMTools({
              ...request,
              contents: [...this.contents],
            });
          } else {
            throw err;
          }
        }
      } finally {
        // Always pair llm_call_end with llm_call_start so the UI can clear
        // its "thinking" indicator even when generateWithLLMTools throws.
        emit({ type: 'llm_call_end', iteration });
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
      const modelContent: LLMContent = {
        role: candidate.content.role ?? 'model',
        parts: candidate.content.parts ?? [],
      };
      this.contents.push(modelContent);

      const parts = candidate.content.parts;
      const toolCallParts = parts.filter(hasFunctionCall);
      const textParts = parts.filter(hasText);

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

    // Iteration cap — bail with a clear message rather than looping forever.
    const cap =
      `I hit my iteration limit (${this.maxIterations}). ` +
      `Tell me how you'd like to continue, or try a smaller subgoal.`;
    emit({ type: 'iteration_limit', iterations: iteration });
    emit({ type: 'final_text', iterations: iteration, text: cap });
    return { text: cap, iterations: iteration, iterationLimitHit: true };
  }
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
 *  context budget. Keeps the head + tail so structure (e.g. JSON braces)
 *  remains parseable.
 */
const LLM_OUTPUT_CAP = 4_000;
const LLM_OUTPUT_HEAD = 2_400;
const LLM_OUTPUT_TAIL = 1_200;

export function truncateForLLM(s: string): string {
  if (s.length <= LLM_OUTPUT_CAP) return s;
  const head = s.slice(0, LLM_OUTPUT_HEAD);
  const tail = s.slice(-LLM_OUTPUT_TAIL);
  const omitted = s.length - head.length - tail.length;
  return `${head}\n\n[... ${omitted} chars truncated ...]\n\n${tail}`;
}
