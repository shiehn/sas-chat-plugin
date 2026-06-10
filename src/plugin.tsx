/**
 * ChatPanelPlugin — `GeneratorPlugin` for the in-app chat panel.
 *
 * Two entry paths:
 *
 *   1. Main-process activation: `activate(host)` builds the AgentLoop. The
 *      external `chat` skill (Claude Code etc. delegating over MCP) calls
 *      `this.chat({ message })` which drives the loop and returns the final
 *      text + the stream of events that occurred along the way.
 *
 *   2. Renderer ChatPanel: the React UI sends user messages over IPC to the
 *      main-process plugin and subscribes to streaming events. Subprocess
 *      spawning (the `sas` CLI) is forbidden in the renderer, so all loop
 *      execution lives in main; the renderer is a thin display surface.
 *
 * Replaces the prior in-renderer ChatAgent (which used a JSON-protocol-in-text
 * hack over `host.generateWithLLM`). The new architecture uses Gemini native
 * function-calling via `host.generateWithLLMTools` (SDK 2.4.0+) and dispatches
 * each tool call to the `sas` CLI subprocess — same surface external agents
 * use at the terminal.
 */

import React, { useEffect, useRef, useState, type ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginSettingsSchema,
  PluginSkill,
  PluginUIProps,
} from '@signalsandsorcery/plugin-sdk';
import type {
  AgentLoop,
  AgentLoopEvent,
  AgentLoopResult,
} from './agent-loop';
import type { AgentBackend } from './backend';
import { GeminiBackend, GEMINI_DEFAULT_MODEL } from './gemini-backend';
import { ConversationStore } from './conversation-store';
import type { PanelTools } from './panel-tools';
import { ChatPanel } from './ui/ChatPanel';

// Lazy-load the host-only deps. These pull in node:child_process via
// sas-tool-handler, so importing them at module top would crash the renderer
// (Vite generates a failing shim for child_process in browser context).
// Dynamic imports become separate chunks that only load when activate() /
// ensureAgent() / onSceneChanged() actually run — which only happens in the
// main process. In the renderer, this Promise is never awaited, so the chunk
// is never fetched.
async function loadHostDeps(): Promise<{
  AgentLoop: typeof import('./agent-loop').AgentLoop;
  buildPanelTools: typeof import('./panel-tools').buildPanelTools;
  buildAmbientContext: typeof import('./panel-tools').buildAmbientContext;
}> {
  const [{ AgentLoop }, panelToolsModule] = await Promise.all([
    import('./agent-loop'),
    import('./panel-tools'),
  ]);
  return {
    AgentLoop,
    buildPanelTools: panelToolsModule.buildPanelTools,
    buildAmbientContext: panelToolsModule.buildAmbientContext,
  };
}

export const CHAT_PANEL_PLUGIN_ID = '@signalsandsorcery/chat-panel';

export interface ChatInvocation {
  message: string;
}

export interface ChatResponse {
  text: string;
  events: AgentLoopEvent[];
  iterations: number;
  iterationLimitHit: boolean;
}

/**
 * Resolves with the user's free-text response to a clarifying question. The
 * host wires this to whatever transport surfaces the question to the user
 * (in S&S: an IPC round-trip to the renderer's chat panel).
 *
 * Throws/rejects to signal cancellation (scene change, panel closed) — the
 * agent loop wraps the rejection into a synthetic tool failure so the
 * model can recover.
 */
export type AwaitClarification = (
  question: string,
  options?: readonly string[],
) => Promise<string>;

export interface ChatPanelPluginOptions {
  /**
   * Optional clarification transport. When provided, the chat plugin
   * registers an `ask_user` tool the LLM can call mid-loop; its result is
   * the user's typed (or button-clicked) response. When omitted, the tool
   * is NOT registered — the LLM falls back to plain-text questions that
   * end the turn.
   */
  awaitClarification?: AwaitClarification;
  /**
   * Persist the conversation per-project across app restarts (Phase 2b).
   * Default true. Rollback switch: pass false to restore the pre-2b
   * in-memory-only behavior.
   */
  persistConversation?: boolean;
}

export const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant embedded in the Signals & Sorcery loop workstation.
You drive the user's session by calling tools that wrap the \`sas\` CLI — the same surface external agents (Claude Code, Cursor) use at the terminal.

How the system is shaped:
- The CLI follows a plan-as-artifact loop with six verbs: inspect → plan → validate → apply → preview → history. For multi-step musical intents, prefer this path — every mutation auto-checkpoints and is reversible via \`history undo\`. For simple reads ("what scenes exist?") or pure transport ("play"), call the direct tool.
- Tools declare prerequisites. When one fails, the response carries the full ordered chain in \`remediation.prerequisiteChain\` — read it, each step names what's missing and a CLI command to satisfy it. Don't retry blindly.
- Composite tools (e.g. \`compose_scene\`, \`make_beat\`) handle their own prerequisite chains internally. Prefer them over manual orchestration when the user's intent matches.
- \`sas plan "<intent>"\` is side-effect-free. If you're uncertain whether something is feasible, plan first — the validator returns a structured preview of what would change.

What S&S is, at a domain level (use this vocabulary when the user asks "what is X?"):
- Project: the .sasproj workspace. Holds scenes, transitions, render cache, and per-scene musical context.
- Scene: a 2/4/8/16-bar musical loop. The unit of composition. Holds N tracks and an optional musical contract (key/BPM/chords/genre).
- Transition: a short bridge (1-4 bars) connecting two scenes. Has its own tracks, chord plan, and rendered WAV.
- Track: one MIDI or audio stream inside a scene or transition. Has a Role and exactly one Plugin.
- Role: the track's musical purpose. Canonical roles (plural form): bass, keys, lead, pads, strings, brass, winds, bells, plucked, arp, chords, drums, kicks, snares, hats, 808s, perc, cymbals, atmospheres, fx, vocals. Drives generation prompts and preset categories.
- Plugin: the generator that owns a track. Built-in: \`@signalsandsorcery/synth-generator\` (Surge-synth MIDI tracks), \`@signalsandsorcery/drum-generator\` (sample-based drum patterns — real one-shot drum samples), \`@signalsandsorcery/instrument-generator\` (pitched, sample-based instruments — plucks/keys/pads/bass), \`loops\` (audio samples / loops), \`stems\` (long-form audio with optional stem splitting).
- Musical context (a.k.a. "contract"): per-scene key, BPM, chord progression, genre. Inferred by \`compose_contract\` or \`compose_scene\` from the user's description.
- Deck LOOP-A ("cue"): headphone output, channels 1-2. The composition deck — what you're working on. Plays one scene OR one transition at a time.
- Deck LOOP-B ("performance" / "main"): main speaker output, channels 3-4. What the audience hears. Independent of LOOP-A; same content contract.
- Playback mode (derived from audio routing): Performance mode (4+ channels with separate cue/main pairs) keeps decks isolated. Solo mode (≤2 channels) makes them mutually exclusive.

For implementation-detail questions (engine internals, database schema, rendering pipeline, plugin SDK), design docs live at \`sas-app/docs/*.md\` on disk. Notable: \`docs/transition-generator.md\` (six-stage pipeline, chord notation rules, atomic commit, orphan cleanup). The top-level \`CLAUDE.md\` and \`sas-app/CLAUDE.md\` document the engineering rules (DB scoping, role taxonomy, deck playback rules, etc.). Use \`fs_read_file\` (find it via \`tool_search\`; user approves each read) to fetch one when the user asks something deeper than the vocabulary above can answer, and cite the file you read in your reply.

How to work:
- Inspect first. If the user references an entity by name ("the bass scene", "Verse 1", "the loud track") and you don't already see its exact ID in the auto-injected "Current state" preamble or working memory, call \`sas_inspect_project\` ONCE up-front to load the candidate list — THEN attempt the action with the resolved ID. Don't guess.
- When the user refers to a track by role ("the bass"), match it to the actual track list.
- Choosing a generator: for REAL / sampled / acoustic sounds, the \`generate_drums\` (drum-generator) and \`generate_instrument\` (instrument-generator) skills are on your default list — reach for them when the user wants real drums or a sampled/acoustic instrument. For SYNTHESIZED Surge-XT tones use \`dsl_generate_drums\` / \`dsl_generate_midi\`. To swap the sample/instrument on an existing sample-based track, \`tool_search\` for \`shuffle_drum_sample\` / \`shuffle_instrument\` (the sample-track counterpart to \`dsl_shuffle_preset\`, which only works on Surge tracks).
- Read tool errors carefully — the CLI returns structured remediation in stderr (see "Recovering from clarification" below for the contract).
- Tools may declare a sceneId parameter — the host injects the active scene automatically; you don't have to pass it.
- The active scene's musical contract (key/BPM/chords) is in the auto-injected "Current state" preamble — read it there rather than calling get_musical_context just to learn the active scene's key or tempo.
- Be concise. The user can hear the result; explanations are for when something needs explaining.
- Your default tool list is scene-scoped. For project-wide actions (deck control "play loop-a / loop-b", audio routing, project switching, transitions, history/undo, audio export), call \`tool_search\` with a keyword query FIRST — most capabilities not on your default list are reachable that way, then invoke the returned tool by name. You do NOT need to ask the user before invoking a tool you found via tool_search; just call it.

Taste memory & feedback (the producer loop — this is what makes you a collaborator, not a command runner):
- When the user REACTS to something they heard with a preference signal ("the bass is too loud", "love that swing", "less busy hats please"), do two things: (1) act on it, and (2) record ONE structured lesson via \`producer_preferences\` op=add. Use source='explicit' ONLY when the user literally said it; source='inferred' for lessons you deduced from their reaction. One terse sentence; never duplicate an existing entry (they're shown in "Producer preferences" in Current state — honor those without being asked, and update/remove entries that the user contradicts).
- After an AUDIBLE milestone (a new scene composed, a substantial revision), elicit feedback with \`ask_user\` offering 2–4 CONCRETE directions as options ("brighter", "darker", "keep it") instead of an open "what do you think?". Skip the elicitation when the user gave a precise directive that you simply executed, and never ask twice in a row.

Working memory & session goals (silent bookkeeping — keep it current, never ask permission to record):
- For a multi-step request, call \`chat_task_ledger\` with op=set_goals ONCE to record the plan, then op=update each item to done as you finish it. The ledger is shown back to you in the "Current state" preamble and survives scene changes, so it keeps you on-task across turns. Don't use it for one-off single-step asks, and don't announce ledger writes.
- The project has a persistent journal (cross-session memory). When the user states a durable preference ("always mix the bass low", "keep choruses 8 bars") or makes a significant creative decision, append ONE terse line with \`sas_project_notes_write\` (mode=append). Don't journal ephemeral actions (the ledger's job), and don't ask before writing.
- A tail of the journal shows as "Remembered notes & preferences" in Current state. Call \`sas_project_notes_read\` for the full history only when the user asks a memory question or the tail is insufficient.

Answering arbitrary state questions ("how many AI tracks in scene X", "which track has the most plugins", "is the system performing well"):
- \`db_query\` runs a read-only SELECT / WITH / PRAGMA against the app's SQLite database and returns rows. Pair it with \`db_describe_schema\` (the "ls" of the DB) the first time you touch an unfamiliar table.
- Scope every query on \`tracks\` / \`audio_tracks\` / \`sample_tracks\` with \`AND project_id = ?\` — these tables share IDs across projects. Get the active project_id from \`project_get_status\`. The "engine_track_id" / "scene_id" / etc. are NOT globally unique.
- For per-plugin parameter values (e.g. "what's the decay on the reverb on Bass?") use \`fx_list_plugins\` then \`fx_list_params\` — plugin parameter state lives in the audio engine, not the DB.
- For audio dropouts / engine health / "is everything OK?" use \`system_get_health\` — quote its \`verdict\` and \`notes\` directly in your reply.
- These three read primitives are always visible — don't tool_search for them.

When to ask vs proceed:
- Default to action. For routine intents ("add reverb to the bass", "make drums punchier") pick a sensible default and proceed — the user can hear the result and can undo via \`history undo\`.
- ONLY call \`ask_user\` when the request is genuinely ambiguous AND a wrong guess would cost real work. Examples: multiple equally-valid candidates ("the bass" with three bass tracks of different roles), missing a load-bearing parameter ("shorten the intro" with no scene specified), an interpretation that would overwrite user intent.
- When you do ask, keep the question focused (one sentence) and pass an \`options\` array of 2–4 candidates whenever you can enumerate them — the UI renders quick-reply buttons.
- Do not ask to confirm tool calls you've already decided to make. Do not ask "are you sure?" — destructive operations are reversible.
- If a request is out of scope, say so plainly and suggest what the user could do instead. Don't use \`ask_user\` for scope rejection.
- Proposing creative options (a narrow exception to "default to action"): ONLY when the request is open-ended and taste-driven with several equally-valid directions ("give me a few ideas for the lead", "what could the chorus sound like") AND the options are cheap to produce. Then call a plan-emitter with \`planOnly=true\` (\`make_beat\` / \`revise_track\` / \`revise_scene\`, found via \`tool_search\`; planOnly is synchronous and does NOT mutate or regenerate audio) 2–3 times with different directions, and present them via \`ask_user\` with short option labels ("jazzier", "darker", "sparser"). Apply only the one the user picks. Do NOT render audio for each option (describe them from the plan); do NOT propose options for a concrete directive ("make the bass louder") — just act.

Verifying generative output (only when it earns the latency):
- After a generative tool (\`compose_scene\`, \`make_beat\`, \`revise_track\`, \`revise_scene\`) you usually do NOT verify — the user will hear it. Verify ONLY when the user named an OBJECTIVE, checkable constraint a generator can miss: a specific key, a specific BPM, or "match the contract".
- To verify: call \`sas_audition\` ONCE — it renders (cache-aware), analyzes, and compares against the scene's contract in one call. The \`changes.verdict\` booleans are the contract: true=verified, false=mismatch (report it and offer to fix), null=could not check (NOT a mismatch — don't retry just to fill it in). When everything matches, say nothing about the check.
- The granular \`sas_render_preview\` / \`sas_analyze_audio\` pair still exists for arbitrary files or when the user asks for a playable preview link specifically — but for contract verification, \`sas_audition\` is the one call.
- Never verify subjective qualities ("punchier", "darker") — analysis can't judge those; trust the tool and let the user listen. Verify at most ONCE per generation; do not loop audition→regenerate unless the user asks.
- "What's playing on which deck" (LOOP-A cue vs LOOP-B main): \`sas_deck_snapshot\` returns both decks + mode in one call — use it on demand rather than guessing.

Recovering from clarification (this is a contract — follow it):
- When ANY tool returns \`remediation.type === 'clarification_needed'\`, the response ALSO carries \`clarification.question\` and \`clarification.options[]\` (or \`changes.availableScenes[]\` / \`changes.availableTracks[]\` / \`changes.availableTransitions[]\`). DO NOT guess and DO NOT retry the same call. Call \`ask_user\` immediately with the question text and an \`options\` array built from those candidates (use their \`label\` / \`displayName\` / \`name\`). When the user picks, retry the original tool with the corresponding \`id\`.
- When a tool returns \`remediation.type === 'track_not_found'\` / \`'scene_not_found'\` / \`'transition_not_found'\`, the user's selector resolved to nothing. Either ask the user to clarify or call \`sas_inspect_project\` to enumerate what DOES exist — do NOT keep retrying with variations of the same wrong selector.
- When a tool returns \`remediation.prerequisiteChain\`, run the named prerequisite tools in order before retrying. Each chain entry includes the action name and (often) a CLI hint.

Transient failures (structural signal — do NOT pattern-match error strings):
- Some failures are transient: the system is busy, not broken. Tools that wrap inherently-racy operations (track loads, engine readiness, graph prep) signal this STRUCTURALLY by setting \`remediation.retryable === true\` on the failure response.
- When you see \`remediation.retryable === true\`, retry the SAME call ONCE before reporting to the user. If the second call also fails, THEN report and stop. Do not loop.
- This is the ONLY signal you should use to decide retry-on-transient. Do not infer transient-ness from error message wording — the structural flag is the contract.

Don't give up without making a call:
- If your default tool list doesn't have an exact match, your FIRST move is \`tool_search\` with a keyword from the user's ask (deck, transition, audio, route, project, export, history, …) — NOT a text reply saying "I can't do that".
- If after \`tool_search\` you still don't see a perfect match, call the closest tool and report what actually happened in your reply. The user can hear/see the result and correct course.
- Replying with plain text and zero tool calls is reserved for: pure read-back questions the user already gave you the answer to ("what was that command again?"), out-of-scope rejections, and final summaries after at least one tool call landed.`;

// -----------------------------------------------------------------------------
// Renderer-side UI — proxies user messages to the main-process plugin via IPC.
// Subprocess spawning is forbidden in renderer, so the loop runs in main and
// streams events back. The IPC channel names match those registered by
// `sas-app/src/main/ipc-chat-plugin.ts`.
// -----------------------------------------------------------------------------

interface ChatPluginRendererBridge {
  sendMessage(message: string): Promise<ChatResponse>;
  onEvent(callback: (event: AgentLoopEvent) => void): () => void;
  /** Optional — if absent, the chat panel still works for non-clarification
   *  flows. The chat plugin can run on older preload bundles that predate
   *  the ask_user wiring without crashing. */
  sendClarificationResponse?(response: string): Promise<void>;
}

/**
 * Read the bridge off `window.electronAPI` without declaring a global
 * augmentation — that would clash with the host app's broader
 * `electronAPI` declaration. We narrow at the call site instead.
 */
function getBridge(): ChatPluginRendererBridge | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { electronAPI?: { chatPlugin?: ChatPluginRendererBridge } })
    .electronAPI;
  return api?.chatPlugin ?? null;
}

const ChatPanelUI: ComponentType<PluginUIProps> = ({ activeSceneId, isExpanded }) => {
  const bridgeRef = useRef<ChatPluginRendererBridge | null>(null);
  const [bridgeAvailable, setBridgeAvailable] = useState<boolean>(true);

  useEffect(() => {
    const bridge = getBridge();
    bridgeRef.current = bridge;
    setBridgeAvailable(bridge !== null);
  }, []);

  // Reset on scene change is handled main-side via onSceneChanged.
  // The renderer just needs to clear its message list when the scene id changes.
  useEffect(() => {
    // No-op for now — `ChatPanel` owns its own message list state.
    void activeSceneId;
  }, [activeSceneId]);

  const sendMessage = async (
    message: string,
    onEvent: (event: AgentLoopEvent) => void
  ): Promise<{ text: string; actions: AgentLoopEvent[] }> => {
    const bridge = bridgeRef.current;
    if (!bridge) {
      const text = 'Chat plugin bridge unavailable — restart the app or reopen the panel.';
      onEvent({ type: 'final_text', iterations: 0, text });
      return { text, actions: [] };
    }

    const unsubscribe = bridge.onEvent(onEvent);
    try {
      const result = await bridge.sendMessage(message);
      return { text: result.text, actions: result.events };
    } finally {
      unsubscribe();
    }
  };

  const sendClarificationResponse = async (response: string): Promise<void> => {
    const bridge = bridgeRef.current;
    if (!bridge?.sendClarificationResponse) {
      throw new Error(
        'Clarification bridge unavailable — preload may need to be rebuilt.',
      );
    }
    await bridge.sendClarificationResponse(response);
  };

  if (!bridgeAvailable) {
    return React.createElement(
      'div',
      { style: { padding: 12, color: 'var(--sas-text-muted, #888)' } },
      'Chat plugin requires the Electron main bridge — running outside the app.'
    );
  }

  return React.createElement(ChatPanel, {
    sendMessage,
    sendClarificationResponse,
    isExpanded,
  });
};

// -----------------------------------------------------------------------------
// Plugin class — main process owns the AgentLoop. The renderer's ChatPanelUI
// never instantiates one (subprocess spawning would fail there anyway).
// -----------------------------------------------------------------------------

export class ChatPanelPlugin implements GeneratorPlugin {
  readonly id = CHAT_PANEL_PLUGIN_ID;
  readonly displayName = 'Chat';
  readonly version = '2.0.0';
  readonly description =
    'AI-powered audio manipulation via natural language — drives the sas CLI like Claude Code at the terminal (scene-scoped).';
  readonly generatorType = 'hybrid' as const;
  readonly minHostVersion = '2.4.0';

  private host: PluginHost | null = null;
  private agent: AgentLoop | null = null;
  private panelTools: PanelTools | null = null;
  private readonly awaitClarification?: AwaitClarification;
  private readonly persistConversation: boolean;
  private conversationStore: ConversationStore | null = null;
  /** Project id the in-memory conversation belongs to. Compared against the
   *  host's current project before every turn so a project switch can never
   *  leak one project's history into another's storage namespace. */
  private conversationProjectId: string | null = null;
  /** Model id the current backend drives — stamped into persisted payloads. */
  private currentModel: string = GEMINI_DEFAULT_MODEL;

  constructor(options: ChatPanelPluginOptions = {}) {
    this.awaitClarification = options.awaitClarification;
    this.persistConversation = options.persistConversation !== false;
  }

  /** Feature-checked `host.getProjectId()` (SDK 2.18.0; optional). */
  private getHostProjectId(): string | null {
    const fn = (this.host as { getProjectId?: () => string | null } | null)
      ?.getProjectId;
    try {
      return typeof fn === 'function' ? fn.call(this.host) : null;
    } catch {
      return null;
    }
  }

  /**
   * Activate the plugin. CLI paths are NOT required at activation — they're
   * resolved lazily on the first `chat()` call. This keeps activation
   * resilient in test environments where electron's `app` API isn't fully
   * wired (`host.getCliPaths()` returns null in those cases) and matches the
   * behavior of other built-in plugins which activate without engine state.
   */
  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    // Build the agent eagerly. The default in-process transport needs no
    // CLI paths; they're passed through (when resolvable) only for the
    // `SAS_CHAT_TOOL_TRANSPORT=cli` rollback path.
    const { AgentLoop, buildPanelTools, buildAmbientContext } = await loadHostDeps();
    this.panelTools = await buildPanelTools({
      host,
      cliPaths: host.getCliPaths(),
      awaitUserResponse: this.awaitClarification,
    });
    this.agent = new AgentLoop({
      host,
      backend: this.buildBackend(host),
      tools: this.panelTools.tools,
      toolExecutor: this.panelTools.executor,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      getAmbientContext: () => buildAmbientContext(host),
    });

    // Restore the current project's persisted conversation (app restart
    // continuity). Best-effort — a malformed/missing payload just starts
    // fresh. Stale Gemini thoughtSignatures in a restored conversation are
    // backstopped by the loop's history_shape recovery.
    if (this.persistConversation) {
      this.conversationStore = new ConversationStore(host);
      this.conversationProjectId = this.getHostProjectId();
      try {
        const stored = await this.conversationStore.load();
        if (stored && stored.contents.length > 0) {
          this.agent.seedHistory(stored.contents);
        }
      } catch {
        // start fresh
      }
    }
  }

  /**
   * Provider seam. Gemini stays the default; the model id is user-tunable
   * via plugin settings (see `getSettingsSchema`). Defensive about hosts
   * (test mocks) that don't expose a settings store.
   */
  private buildBackend(host: PluginHost): AgentBackend {
    let model: string | undefined;
    try {
      const settings = (
        host as { settings?: { get?: <T>(key: string, def: T) => T } }
      ).settings;
      const raw = settings?.get?.('model', '');
      model = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    } catch {
      model = undefined;
    }
    const backend = new GeminiBackend(host, { model });
    this.currentModel = backend.defaultModel;
    return backend;
  }

  /**
   * Project-switch guard, run before every turn. The plugin_data namespace
   * is per-project, so after a switch a save would land the OLD project's
   * history in the NEW project's row. Detect the switch, drop the
   * in-memory history, and seed the new project's stored conversation.
   */
  private async syncConversationToProject(agent: AgentLoop): Promise<void> {
    if (!this.persistConversation || !this.conversationStore) return;
    const current = this.getHostProjectId();
    if (current === this.conversationProjectId) return;
    this.conversationProjectId = current;
    agent.reset();
    try {
      const stored = await this.conversationStore.load();
      if (stored && stored.contents.length > 0) {
        agent.seedHistory(stored.contents);
      }
    } catch {
      // start fresh in the new project
    }
  }

  /** Persist the conversation after a turn. Over-cap payloads request a
   *  compaction pass on the next run. Best-effort; never blocks the reply. */
  private async saveConversation(agent: AgentLoop): Promise<void> {
    if (!this.persistConversation || !this.conversationStore) return;
    const projectId = this.getHostProjectId();
    if (!projectId) return;
    try {
      const contents = agent.getHistorySnapshot();
      if (contents.length === 0) {
        await this.conversationStore.clear();
        return;
      }
      const { overCap } = await this.conversationStore.save({
        projectId,
        model: this.currentModel,
        contents,
      });
      if (overCap) agent.requestCompaction();
    } catch {
      // persistence is best-effort
    }
  }

  async deactivate(): Promise<void> {
    this.host = null;
    this.agent = null;
    this.panelTools = null;
    this.conversationStore = null;
    this.conversationProjectId = null;
  }

  /** Lazily build the agent on first use (covers hosts where activate ran
   *  before the app fully booted). The in-process transport needs no CLI
   *  paths; they're forwarded when available for the CLI rollback path. */
  private async ensureAgent(): Promise<AgentLoop> {
    if (this.agent) return this.agent;
    if (!this.host) {
      throw new Error('ChatPanelPlugin not activated — call activate(host) first');
    }
    const { AgentLoop, buildPanelTools, buildAmbientContext } = await loadHostDeps();
    const host = this.host;
    this.panelTools = await buildPanelTools({
      host,
      cliPaths: host.getCliPaths(),
      awaitUserResponse: this.awaitClarification,
    });
    this.agent = new AgentLoop({
      host,
      backend: this.buildBackend(host),
      tools: this.panelTools.tools,
      toolExecutor: this.panelTools.executor,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      getAmbientContext: () => buildAmbientContext(host),
    });
    return this.agent;
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return ChatPanelUI;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return {
      type: 'object',
      properties: {
        model: {
          type: 'select',
          label: 'Chat model',
          description:
            'Gemini model driving the chat agent. Pro is the strongest at multi-step tool use; Flash is faster and cheaper for simple asks.',
          default: GEMINI_DEFAULT_MODEL,
          options: [
            { label: 'Gemini 3.1 Pro (best tool use)', value: GEMINI_DEFAULT_MODEL },
            { label: 'Gemini 2.5 Flash (faster)', value: 'gemini-2.5-flash' },
          ],
        },
      },
    };
  }

  getSkills(): PluginSkill[] {
    return [
      {
        id: 'chat',
        description:
          'Send a natural-language instruction to the scene assistant. It will inspect scene state, drive the sas CLI iteratively, and return a summary. Use for scene-scoped work: "add reverb to the bass", "make drums punchier", "simplify the lead melody".',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Natural-language instruction about the active scene.',
            },
          },
          required: ['message'],
        },
      },
    ];
  }

  /**
   * Drop the agent's conversation history without tearing down activation.
   *
   * Production callers: hands-off — `onSceneChanged` already does this on
   * scene switches. Test callers (the Errantry bridge `/errantry/reset`
   * handler) need it because the SEED path (`/api/v1/execute scene_activate`)
   * mutates engine state without going through the plugin lifecycle, so the
   * chat history would otherwise leak across specs and PI would reply
   * about stale tracks from prior runs.
   */
  reset(): void {
    this.agent?.reset();
    // A user-initiated clear (or Errantry /errantry/reset) must also drop
    // the persisted conversation, or it resurrects on the next restart.
    void this.conversationStore?.clear();
  }

  async onSceneChanged(sceneId: string | null): Promise<void> {
    // Phase 2b: scene changes NO LONGER reset the conversation — creative
    // sessions span scenes ("make the chorus match the verse"). Instead:
    // swap the tool surface (declaration set may differ per scene) and
    // queue a state-change breadcrumb for the next turn. Per-call sceneId
    // injection reads the active scene at CALL time, so binding is already
    // correct without a rebuild.
    if (!this.host) return;
    const { AgentLoop, buildPanelTools, buildAmbientContext } = await loadHostDeps();
    const host = this.host;
    this.panelTools = await buildPanelTools({
      host,
      cliPaths: host.getCliPaths(),
      awaitUserResponse: this.awaitClarification,
    });
    if (this.agent) {
      this.agent.updateToolSurface(this.panelTools.tools, this.panelTools.executor);
      this.agent.queueContextNote(
        `[state change] The active scene changed${sceneId ? ` (now scene id ${sceneId})` : ''}. ` +
          'Scene/track ids from earlier in this conversation may be stale — ' +
          'trust the "Current state" preamble and re-inspect before reusing them.',
      );
    } else {
      this.agent = new AgentLoop({
        host,
        backend: this.buildBackend(host),
        tools: this.panelTools.tools,
        toolExecutor: this.panelTools.executor,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        getAmbientContext: () => buildAmbientContext(host),
      });
    }
  }

  /**
   * External-agent entrypoint — called by the skill dispatcher in the main
   * process after `activate(host)` has wired the loop. Also called by the
   * renderer-bridge IPC handler so the React panel uses the same code path.
   */
  async chat(
    params: ChatInvocation,
    onEvent?: (event: AgentLoopEvent) => void
  ): Promise<ChatResponse> {
    const agent = await this.ensureAgent();
    // Project-switch guard BEFORE the turn (never mix projects' histories).
    await this.syncConversationToProject(agent);
    const events: AgentLoopEvent[] = [];
    try {
      const result: AgentLoopResult = await agent.run(params.message, (event) => {
        events.push(event);
        onEvent?.(event);
      });
      return {
        text: result.text,
        events,
        iterations: result.iterations,
        iterationLimitHit: result.iterationLimitHit,
      };
    } finally {
      // Persist AFTER the turn (including failed turns — partial history is
      // still the user's conversation).
      await this.saveConversation(agent);
    }
  }
}

export default ChatPanelPlugin;
