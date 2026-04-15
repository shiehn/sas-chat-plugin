/**
 * ChatAgent — agentic tool loop for the in-app chat panel.
 *
 * The core of Sections 14–15 and 23.7 of ai-orchestration-design.md.
 * Given a user message and a set of tools, drive an LLM-based tool loop
 * until the LLM emits text (done) or MAX_ITERATIONS is reached (capped).
 *
 * The LLM is injected via `llm` so the loop is deterministic under test.
 * The real adapter (Claude/OpenAI SDK) lives elsewhere and just wraps the
 * LLMCallFn signature.
 *
 * Reinforcement injection (Section 23.7): the scene context is rebuilt after
 * every mutating tool call so the LLM never reasons from stale state.
 * Tools declare `mutates: boolean` in their definition.
 */

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ChatAgentTool {
  name: string;
  description: string;
  parameters: { type: 'object'; properties?: Record<string, unknown> };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  /**
   * Reinforcement hint — if true, the scene context is rebuilt after this
   * tool runs so the next LLM call sees fresh state. Defaults to false
   * (read-only assumption; explicit mutations opt in).
   */
  mutates?: boolean;
}

export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'tool'; content: string; toolCallId: string };

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools: ChatAgentTool[];
}

export type LLMResponse =
  | { type: 'text'; content: string }
  | {
      type: 'tool_use';
      toolCalls: Array<{ id: string; name: string; parameters: Record<string, unknown> }>;
    };

export type LLMCallFn = (req: LLMRequest) => Promise<LLMResponse>;

export interface ActionLogEntry {
  tool: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  /** Monotonically increasing from 1 per handled message */
  iteration: number;
}

export interface AgentResponse {
  text: string;
  actions: ActionLogEntry[];
  /** Set when the loop hit MAX_ITERATIONS before the LLM emitted text. */
  iterationLimitHit?: boolean;
}

export interface ChatAgentOptions {
  llm: LLMCallFn;
  tools: ChatAgentTool[];
  buildSceneContext: () => Promise<string>;
  /** Default 10, matching Section 15 of the design doc. */
  maxIterations?: number;
  /** System-prompt preamble. A sensible default is provided. */
  systemPromptPrefix?: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 10;

const DEFAULT_SYSTEM_PROMPT = `You are an audio production assistant embedded in a loop workstation scene.
You have tools to manipulate tracks, effects, MIDI, audio, and presets in the active scene.

How to work:
- Call get_tracks first if you need to know what's in the scene.
- When the user refers to a track by role ("the bass"), match it to the track list.
- Prefer non-destructive FX over destructive audio processing.
- You can call multiple tools per turn when independent.
- Be concise — the user can hear the result; don't over-explain.
- If an error is out of scope, explain what the user should do instead.`;

// -----------------------------------------------------------------------------
// Agent
// -----------------------------------------------------------------------------

export class ChatAgent {
  private readonly llm: LLMCallFn;
  private readonly tools: ChatAgentTool[];
  private readonly buildSceneContext: () => Promise<string>;
  private readonly maxIterations: number;
  private readonly systemPromptPrefix: string;

  private history: LLMMessage[] = [];

  constructor(options: ChatAgentOptions) {
    this.llm = options.llm;
    this.tools = options.tools;
    this.buildSceneContext = options.buildSceneContext;
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.systemPromptPrefix = options.systemPromptPrefix ?? DEFAULT_SYSTEM_PROMPT;
  }

  /**
   * Drop all conversation history. Called when switching scenes (chat is
   * scene-scoped per the design) or on user request.
   */
  clearHistory(): void {
    this.history = [];
  }

  async handleUserMessage(message: string): Promise<AgentResponse> {
    this.history.push({ role: 'user', content: message });

    const actions: ActionLogEntry[] = [];
    let sceneContext = await this.buildSceneContext();
    let iteration = 0;

    while (iteration < this.maxIterations) {
      iteration++;

      const response = await this.llm({
        system: this.buildSystemPrompt(sceneContext),
        messages: [...this.history],
        tools: this.tools,
      });

      if (response.type === 'text') {
        this.history.push({ role: 'assistant', content: response.content });
        return { text: response.content, actions };
      }

      // Tool-use turn — execute each call, collect results, feed back
      let anyMutation = false;
      for (const call of response.toolCalls) {
        const tool = this.tools.find((t) => t.name === call.name);
        if (!tool) {
          const error = `Unknown tool: ${call.name}`;
          actions.push({
            tool: call.name,
            params: call.parameters,
            error,
            iteration,
          });
          this.history.push({
            role: 'tool',
            content: JSON.stringify({ error }),
            toolCallId: call.id,
          });
          continue;
        }

        try {
          const result = await tool.handler(call.parameters);
          actions.push({
            tool: call.name,
            params: call.parameters,
            result,
            iteration,
          });
          this.history.push({
            role: 'tool',
            content: JSON.stringify(result ?? null),
            toolCallId: call.id,
          });
          if (tool.mutates) anyMutation = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          actions.push({
            tool: call.name,
            params: call.parameters,
            error: msg,
            iteration,
          });
          this.history.push({
            role: 'tool',
            content: JSON.stringify({ error: msg }),
            toolCallId: call.id,
          });
        }
      }

      // Reinforcement injection — refresh scene state so the next LLM call
      // reasons from what the world looks like AFTER the tool calls landed.
      if (anyMutation) {
        sceneContext = await this.buildSceneContext();
      }
    }

    // Safety cap — iteration limit hit. Return the action log so the agent
    // (or user) can decide whether to continue.
    const cap = `I hit my iteration limit (${this.maxIterations}). Here's what I did so far — let me know if you want me to continue.`;
    this.history.push({ role: 'assistant', content: cap });
    return { text: cap, actions, iterationLimitHit: true };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private buildSystemPrompt(sceneContext: string): string {
    return `${this.systemPromptPrefix}\n\nCurrent scene state:\n${sceneContext}`;
  }
}
