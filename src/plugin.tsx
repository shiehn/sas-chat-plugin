/**
 * ChatPanelPlugin — `GeneratorPlugin` conforming the chat panel to the SDK.
 *
 * Two entry paths converge on a ChatAgent:
 *
 *   1. External-agent skill: `plugin:chat-panel:chat`
 *      Main process calls `activate(host)` → `this.agent` is ready.
 *      Skill dispatcher calls `this.chat({ message })`.
 *
 *   2. In-app chat textbox (renderer)
 *      PluginAccordionSection instantiates a fresh ChatPanelPlugin in the
 *      renderer and NEVER calls `activate()` — it hands a host to the UI
 *      via `PluginUIProps.host`. So the UI component builds its own
 *      ChatAgent from `props.host` lazily on first send.
 *
 * Agent construction is async because `buildPanelTools` asks the host for
 * its full scene-scoped tool surface (`listAppTools`). The first message
 * pays the list cost once; subsequent sends reuse the cached agent.
 *
 * Section 14 of ai-orchestration-design.md.
 */

import React, { useEffect, useRef, type ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginSettingsSchema,
  PluginSkill,
  PluginUIProps,
} from '@signalsandsorcery/plugin-sdk';
import { ChatAgent, type AgentResponse, type ChatAgentEvent } from './chat-agent';
import { makeLLMAdapter, type PluginHostLLMFn } from './llm-adapter';
import { buildPanelTools, buildSceneContextSnapshot, type PanelHost } from './panel-tools';
import { ChatPanel } from './ui/ChatPanel';

export const CHAT_PANEL_PLUGIN_ID = '@signalsandsorcery/chat-panel';

export interface ChatInvocation {
  message: string;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function buildAgentFromHost(host: PluginHost): Promise<ChatAgent> {
  const panelHost = host as unknown as PanelHost;
  const hostLLM: PluginHostLLMFn = (req) => host.generateWithLLM(req);
  const adapter = makeLLMAdapter(hostLLM);
  const tools = await buildPanelTools(panelHost);
  return new ChatAgent({
    llm: adapter,
    tools,
    buildSceneContext: () => buildSceneContextSnapshot(panelHost),
  });
}

// -----------------------------------------------------------------------------
// UI component — self-contained; builds its own ChatAgent from the host prop
// lazily on first send, and rebuilds when host or active scene changes.
// -----------------------------------------------------------------------------

const ChatPanelUI: ComponentType<PluginUIProps> = ({ host, activeSceneId }) => {
  const agentRef = useRef<ChatAgent | null>(null);

  // Reset the agent (and its conversation history) when host or scene change.
  // Fresh tool list + fresh scene context on the next send.
  useEffect(() => {
    agentRef.current = null;
  }, [host, activeSceneId]);

  const sendMessage = async (
    message: string,
    onEvent: (event: ChatAgentEvent) => void
  ): Promise<AgentResponse> => {
    if (!agentRef.current) {
      agentRef.current = await buildAgentFromHost(host);
    }
    return await agentRef.current.handleUserMessage(message, onEvent);
  };

  return React.createElement(ChatPanel, { sendMessage });
};

// -----------------------------------------------------------------------------
// Plugin class
// -----------------------------------------------------------------------------

export class ChatPanelPlugin implements GeneratorPlugin {
  readonly id = CHAT_PANEL_PLUGIN_ID;
  readonly displayName = 'Chat';
  readonly version = '1.1.0';
  readonly description = 'AI-powered audio manipulation via natural language (scene-scoped)';
  readonly generatorType = 'hybrid' as const;
  readonly minHostVersion = '1.3.0';

  private host: PluginHost | null = null;
  private agent: ChatAgent | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    this.agent = await buildAgentFromHost(host);
  }

  async deactivate(): Promise<void> {
    this.host = null;
    this.agent = null;
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
          'Send a natural-language instruction to the scene assistant. It will inspect scene state, plan tool calls, and return a summary. Use for scene-scoped work: "add reverb to the bass", "make drums punchier", "simplify the lead melody".',
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
    // Chat is scene-scoped — switching scenes starts a fresh conversation
    // on the main-process agent. The renderer UI resets itself via the
    // activeSceneId effect in ChatPanelUI.
    this.agent?.clearHistory();
  }

  // ---------------------------------------------------------------------------
  // External-agent entrypoint — called by the skill dispatcher in the main
  // process after activate(host) has bound `this.agent`.
  // ---------------------------------------------------------------------------

  async chat(params: ChatInvocation): Promise<AgentResponse> {
    if (!this.agent) {
      throw new Error('ChatPanelPlugin not activated — host is null');
    }
    return await this.agent.handleUserMessage(params.message);
  }
}

export default ChatPanelPlugin;
