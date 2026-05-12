/**
 * @signalsandsorcery/chat-panel — Built-in Chat Panel Plugin
 *
 * AI-powered scene-scoped audio manipulation via natural language. The user
 * types a request, and the agent loop drives the `sas` CLI iteratively until
 * it achieves the goal — same surface external agents (Claude Code, Cursor)
 * use at the terminal.
 *
 * Architecture:
 *
 *   plugin.tsx          GeneratorPlugin class — lifecycle, UI, skills
 *   agent-loop.ts       Native-tool-use loop (Gemini function-calling)
 *   sas-tool-handler.ts Spawns the `sas` CLI subprocess for each tool call
 *   panel-tools.ts      Maps host.listAppTools() → LLMTool[] + executor
 */

export { ChatPanelPlugin, CHAT_PANEL_PLUGIN_ID } from './plugin';
export type {
  ChatInvocation,
  ChatResponse,
  ChatPanelPluginOptions,
  AwaitClarification,
} from './plugin';

// Type-only re-exports — renderer-safe (TypeScript erases at build time).
// The runtime values live at '@signalsandsorcery/chat-plugin/host' so they
// don't pull `node:child_process` into the renderer's module graph.
export type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentLoopEvent,
  AgentLoopEventHandler,
  ToolExecutor,
  ToolExecutionResult,
  WorkflowProgressItem,
} from './agent-loop';
export type { SasToolInvocation, SasToolResult } from './sas-tool-handler';
export type {
  PanelTools,
  AwaitUserResponse,
  BuildPanelToolsOptions,
} from './panel-tools';
// Sourced from a dedicated dependency-free module, NOT from `./panel-tools`.
// `./panel-tools` transitively imports `node:child_process` via
// `./sas-tool-handler`, and a value-level re-export from there would pull
// the host-only graph into the renderer's static bundle (and crash with
// `ReferenceError: require is not defined` on app launch).
export { ASK_USER_TOOL_NAME } from './constants';

export { default } from './plugin';

// Re-export the manifest so host apps can register the plugin without
// importing the JSON file directly. The JSON subpath export
// ("./plugin.json") is also available for legacy consumers.
export { default as chatManifest } from './plugin.json';
