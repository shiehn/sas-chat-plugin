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
}> {
  const [{ AgentLoop }, { buildPanelTools }] = await Promise.all([
    import('./agent-loop'),
    import('./panel-tools'),
  ]);
  return { AgentLoop, buildPanelTools };
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

const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant embedded in the Signals & Sorcery loop workstation.
You drive the user's session by calling tools that wrap the \`sas\` CLI — the same surface external agents (Claude Code, Cursor) use at the terminal.

How the system is shaped:
- The CLI follows a plan-as-artifact loop with six verbs: inspect → plan → validate → apply → preview → history. For multi-step musical intents, prefer this path — every mutation auto-checkpoints and is reversible via \`history undo\`. For simple reads ("what scenes exist?") or pure transport ("play"), call the direct tool.
- Tools declare prerequisites. When one fails, the response carries the full ordered chain in \`remediation.prerequisiteChain\` — read it, each step names what's missing and a CLI command to satisfy it. Don't retry blindly.
- Composite tools (e.g. \`compose_scene\`, \`make_beat\`) handle their own prerequisite chains internally. Prefer them over manual orchestration when the user's intent matches.
- \`sas plan "<intent>"\` is side-effect-free. If you're uncertain whether something is feasible, plan first — the validator returns a structured preview of what would change.

How to work:
- Inspect first. If you don't know what's in the active scene, call a discovery tool (e.g. scene_get_tracks).
- When the user refers to a track by role ("the bass"), match it to the actual track list.
- Read tool errors carefully — the CLI returns structured remediation in stderr.
- Tools may declare a sceneId parameter — the host injects the active scene automatically; you don't have to pass it.
- Be concise. The user can hear the result; explanations are for when something needs explaining.
- If a request is out of scope or unclear, say so plainly and suggest what the user could do instead.`;

// -----------------------------------------------------------------------------
// Renderer-side UI — proxies user messages to the main-process plugin via IPC.
// Subprocess spawning is forbidden in renderer, so the loop runs in main and
// streams events back. The IPC channel names match those registered by
// `sas-assistant/src/main/ipc-chat-plugin.ts`.
// -----------------------------------------------------------------------------

interface ChatPluginRendererBridge {
  sendMessage(message: string): Promise<ChatResponse>;
  onEvent(callback: (event: AgentLoopEvent) => void): () => void;
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

const ChatPanelUI: ComponentType<PluginUIProps> = ({ activeSceneId }) => {
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

  if (!bridgeAvailable) {
    return React.createElement(
      'div',
      { style: { padding: 12, color: 'var(--sas-text-muted, #888)' } },
      'Chat plugin requires the Electron main bridge — running outside the app.'
    );
  }

  return React.createElement(ChatPanel, { sendMessage });
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

  /**
   * Activate the plugin. CLI paths are NOT required at activation — they're
   * resolved lazily on the first `chat()` call. This keeps activation
   * resilient in test environments where electron's `app` API isn't fully
   * wired (`host.getCliPaths()` returns null in those cases) and matches the
   * behavior of other built-in plugins which activate without engine state.
   */
  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    // Eagerly try to build the agent. If CLI paths aren't available yet
    // (e.g., test env, or app not fully booted), defer until first chat().
    const cliPaths = host.getCliPaths();
    if (cliPaths) {
      const { AgentLoop, buildPanelTools } = await loadHostDeps();
      this.panelTools = await buildPanelTools({ host, cliPaths });
      this.agent = new AgentLoop({
        host,
        tools: this.panelTools.tools,
        toolExecutor: this.panelTools.executor,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
      });
    }
  }

  async deactivate(): Promise<void> {
    this.host = null;
    this.agent = null;
    this.panelTools = null;
  }

  /** Lazily build the agent on first use. Throws if CLI paths still unavailable. */
  private async ensureAgent(): Promise<AgentLoop> {
    if (this.agent) return this.agent;
    if (!this.host) {
      throw new Error('ChatPanelPlugin not activated — call activate(host) first');
    }
    const cliPaths = this.host.getCliPaths();
    if (!cliPaths) {
      throw new Error(
        'ChatPanelPlugin requires CLI paths from the host. ' +
          'Make sure the plugin runs in the main process and `npm run build:cli` has produced dist/cli/sas.js.'
      );
    }
    const { AgentLoop, buildPanelTools } = await loadHostDeps();
    this.panelTools = await buildPanelTools({ host: this.host, cliPaths });
    this.agent = new AgentLoop({
      host: this.host,
      tools: this.panelTools.tools,
      toolExecutor: this.panelTools.executor,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    return this.agent;
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return ChatPanelUI;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
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

  async onSceneChanged(_sceneId: string | null): Promise<void> {
    // Chat is scene-scoped — switching scenes starts a fresh conversation.
    this.agent?.reset();

    // Rebuild the tool surface so any newly-active-scene-only tools and the
    // sceneId injection target the new scene. Tool discovery is cheap.
    if (this.host) {
      const cliPaths = this.host.getCliPaths();
      if (!cliPaths) return;
      const { AgentLoop, buildPanelTools } = await loadHostDeps();
      this.panelTools = await buildPanelTools({ host: this.host, cliPaths });
      if (this.agent) {
        // Construct a fresh loop with the new tools/executor; previous loop
        // is GC'd once references drop. The system prompt is unchanged.
        this.agent = new AgentLoop({
          host: this.host,
          tools: this.panelTools.tools,
          toolExecutor: this.panelTools.executor,
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
        });
      }
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
    const events: AgentLoopEvent[] = [];
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
  }
}

export default ChatPanelPlugin;
