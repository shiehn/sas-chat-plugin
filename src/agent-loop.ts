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

/** Subset of `SasToolResult` the agent loop needs. */
export interface ToolExecutionResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Executes a tool call. Returning a result (success or failure) lets the
 * model recover from errors; throwing should be reserved for truly
 * exceptional cases (spawn failure, timeout) and is wrapped into a
 * synthetic failure response so the loop continues.
 */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>
) => Promise<ToolExecutionResult>;

export type AgentLoopEvent =
  | {
      type: 'tool_call_start';
      iteration: number;
      /** Synthetic id correlating start/done events for the same call. */
      callId: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
    }
  | {
      type: 'tool_call_done';
      iteration: number;
      callId: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
      result: ToolExecutionResult;
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

  constructor(options: AgentLoopOptions) {
    this.host = options.host;
    this.tools = options.tools;
    this.toolExecutor = options.toolExecutor;
    this.systemPrompt = options.systemPrompt;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.onEvent = options.onEvent;
  }

  /** Drop conversation history (called on scene change). */
  reset(): void {
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

      const response = await this.host.generateWithLLMTools(request);
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
      this.contents.push(candidate.content);

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
        try {
          result = await this.toolExecutor(name, args);
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

        toolResponseParts.push({
          functionResponse: {
            name,
            // Gemini accepts arbitrary JSON in the response. Mirror what the
            // CLI emits so the model sees the same fields a shell agent
            // would: success/exitCode/stdout/stderr.
            response: {
              success: result.success,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
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
