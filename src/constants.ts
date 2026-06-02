/**
 * Plain-constant module — has zero runtime dependencies so it is safe to
 * import from the renderer-facing entry point. Lives apart from
 * `panel-tools.ts` (which transitively imports `node:child_process` via
 * `sas-tool-handler.ts`) so that re-exporting these constants from
 * `src/index.ts` does not drag the host-only graph into a renderer bundle.
 */

/** Synthetic tool name for the model-driven clarification path. */
export const ASK_USER_TOOL_NAME = 'ask_user';

/** Synthetic tool name for the session task/goal ledger. Backed by the host's
 *  project-scoped key-value store (`plugin_data`), so it survives scene changes
 *  and app restarts — unlike the agent loop's in-memory conversation history. */
export const CHAT_TASK_LEDGER_TOOL_NAME = 'chat_task_ledger';
