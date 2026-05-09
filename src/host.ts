/**
 * Host-only entrypoint — runtime exports of the CLI driver.
 *
 * These modules import `node:child_process` (via `sas-tool-handler`) and MUST
 * NOT be loaded in the renderer process. Vite generates a failing shim for
 * `child_process` in browser context, which crashes the renderer module graph.
 *
 * Import these from main-process code only:
 *
 *   import { AgentLoop, invokeSas } from '@signalsandsorcery/chat-plugin/host';
 *
 * The renderer's `import { ChatPanelPlugin } from '@signalsandsorcery/chat-plugin'`
 * stays renderer-safe because the plugin class lazy-loads these deps inside
 * methods that only run in main (activate / ensureAgent / onSceneChanged).
 */

export { AgentLoop } from './agent-loop';
export type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentLoopEvent,
  AgentLoopEventHandler,
  ToolExecutor,
  ToolExecutionResult,
} from './agent-loop';

export { invokeSas, spawnSasArgs } from './sas-tool-handler';
export type {
  SasToolInvocation,
  SasArgsInvocation,
  SasToolResult,
} from './sas-tool-handler';

export { buildPanelTools } from './panel-tools';
export type { PanelTools } from './panel-tools';
