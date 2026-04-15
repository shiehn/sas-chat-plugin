/**
 * ChatPanelPlugin — `GeneratorPlugin` conforming the chat panel to the SDK.
 *
 * Wiring:
 *   - activate(host): builds a ChatAgent wired to the host's LLM and tool
 *     surface, via the llm-adapter and panel-tools modules.
 *   - deactivate(): clears state.
 *   - getUIComponent(): returns a React component for the accordion panel
 *     (placeholder UI for v1 — logic is fully testable without the UI).
 *   - getSkills(): declares the external-agent `chat` skill.
 *   - onSceneChanged(): drops the conversation — chat is scene-scoped
 *     (same intent as the existing SynthGenerator lifecycle).
 *
 * Section 14 of ai-orchestration-design.md.
 */

import React, { type ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginSettingsSchema,
  PluginSkill,
  PluginUIProps,
} from '@signalsandsorcery/plugin-sdk';
import { ChatAgent, type AgentResponse } from './chat-agent';
import { makeLLMAdapter, type PluginHostLLMFn } from './llm-adapter';
import { buildPanelTools, buildSceneContextSnapshot, type PanelHost } from './panel-tools';

export const CHAT_PANEL_PLUGIN_ID = '@signalsandsorcery/chat-panel';

export interface ChatInvocation {
  message: string;
}

// -----------------------------------------------------------------------------
// Minimal placeholder UI component.
//
// The production component (message list, action log, streaming status, scene
// chat history) is UI polish scheduled for the next iteration. This
// placeholder satisfies the GeneratorPlugin contract so the plugin can
// register and external agents can call `plugin:chat-panel:chat` today.
// -----------------------------------------------------------------------------

const ChatPanelStubUI: ComponentType<PluginUIProps> = () => {
  return React.createElement(
    'div',
    { style: { padding: 16, fontSize: 13, opacity: 0.7 } },
    'Chat panel — UI pending. External agents can delegate to this panel via the `chat` skill today; the in-app textbox ships in a follow-up.'
  );
};

// -----------------------------------------------------------------------------
// Plugin class
// -----------------------------------------------------------------------------

export class ChatPanelPlugin implements GeneratorPlugin {
  readonly id = CHAT_PANEL_PLUGIN_ID;
  readonly displayName = 'Chat';
  readonly version = '1.0.0';
  readonly description = 'AI-powered audio manipulation via natural language (scene-scoped)';
  readonly generatorType = 'hybrid' as const;
  readonly minHostVersion = '1.1.0';

  private host: PluginHost | null = null;
  private agent: ChatAgent | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    const panelHost = host as unknown as PanelHost;
    const hostLLM: PluginHostLLMFn = (req) => host.generateWithLLM(req);
    const adapter = makeLLMAdapter(hostLLM);
    const tools = buildPanelTools(panelHost);

    this.agent = new ChatAgent({
      llm: adapter,
      tools,
      buildSceneContext: () => buildSceneContextSnapshot(panelHost),
    });
  }

  async deactivate(): Promise<void> {
    this.host = null;
    this.agent = null;
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return ChatPanelStubUI;
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
    // Chat is scene-scoped — switching scenes starts a fresh conversation.
    this.agent?.clearHistory();
  }

  // ---------------------------------------------------------------------------
  // Entrypoint — called by the external-agent skill dispatcher AND (once the
  // UI lands) by the in-app chat textbox. Both paths converge here.
  // ---------------------------------------------------------------------------

  async chat(params: ChatInvocation): Promise<AgentResponse> {
    if (!this.agent) {
      throw new Error('ChatPanelPlugin not activated — host is null');
    }
    return await this.agent.handleUserMessage(params.message);
  }
}

export default ChatPanelPlugin;
