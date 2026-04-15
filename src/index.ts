/**
 * @signalsandsorcery/chat-panel — Built-in Chat Panel Plugin
 *
 * AI-powered scene-scoped audio manipulation via natural language.
 * Follows the GeneratorPlugin convention like every other built-in
 * (synth-generator, sample-player, audio-texture).
 *
 * Architecture (Section 14–15 of docs-ai-planning/ai-orchestration-design.md):
 *
 *   plugin.tsx          GeneratorPlugin class — lifecycle, UI, skills
 *   chat-agent.ts       Agentic tool loop (LLM ↔ tools, reinforcement injection)
 *   llm-adapter.ts      PluginHost.generateWithLLM ↔ ChatAgent.LLMCallFn bridge
 *   panel-tools.ts      PluginHost methods as ChatAgentTool definitions
 */

export { ChatPanelPlugin, CHAT_PANEL_PLUGIN_ID } from './plugin';
export type { ChatInvocation } from './plugin';

export { ChatAgent } from './chat-agent';
export type {
  ChatAgentTool,
  ChatAgentOptions,
  AgentResponse,
  ActionLogEntry,
  LLMCallFn,
  LLMRequest,
  LLMResponse,
  LLMMessage,
} from './chat-agent';

export { makeLLMAdapter } from './llm-adapter';
export type { PluginHostLLMFn, PluginHostLLMRequest, PluginHostLLMResult } from './llm-adapter';

export { buildPanelTools, buildSceneContextSnapshot } from './panel-tools';
export type { PanelHost } from './panel-tools';

export { default } from './plugin';

// Re-export the manifest so host apps can register the plugin without
// importing the JSON file directly. The JSON subpath export
// ("./plugin.json") is also available for legacy consumers.
export { default as chatManifest } from './plugin.json';
