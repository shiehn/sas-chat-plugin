/**
 * panel-tools — discover the host's scene-scoped tools and adapt them for
 * the agent loop.
 *
 * Two outputs:
 *   - `tools`: the LLM-facing `LLMTool[]` (Gemini `functionDeclarations`
 *     shape) handed to `host.generateWithLLMTools`.
 *   - `executor`: a `ToolExecutor` that maps each function call to a
 *     subprocess invocation of the `sas` CLI.
 *
 * Tool discovery still goes through `host.listAppTools({ scope: 'scene' })`
 * — that gives us the same authoritative list the CLI exposes. Execution
 * goes through the CLI subprocess so the chat plugin gets the same agent-
 * legibility surface (stderr remediation, prerequisite chains, exit codes)
 * external agents like Claude Code see at the terminal.
 */

import type {
  PluginHost,
  PluginAppTool,
  LLMTool,
  LLMFunctionDeclaration,
} from '@signalsandsorcery/plugin-sdk';
import { invokeSas } from './sas-tool-handler';
import type { ToolExecutor } from './agent-loop';

export interface PanelTools {
  /** LLM-facing tool declarations (single `LLMTool` wrapping all functions). */
  tools: LLMTool[];
  /** Dispatches function calls to the `sas` CLI subprocess. */
  executor: ToolExecutor;
}

export interface BuildPanelToolsOptions {
  host: PluginHost;
  /** Paths for spawning the `sas` CLI. From `host.getCliPaths()` typically. */
  cliPaths: { appExe: string; cliEntry: string };
}

/**
 * Build the tools surface for the chat plugin's agent loop.
 *
 * The active scene id is captured at build time and injected into every
 * scene-scoped tool call whose schema declares a `sceneId` property. This
 * mirrors `PluginHostImpl`'s `autoBindSceneId` behavior — without this,
 * the CLI subprocess (which has no notion of "active scene") could target
 * the wrong scene.
 */
export async function buildPanelTools(
  options: BuildPanelToolsOptions
): Promise<PanelTools> {
  const { host, cliPaths } = options;
  const appTools = await host.listAppTools({ scope: 'scene' });
  const declarations = appTools.map(toFunctionDeclaration);
  const tools: LLMTool[] =
    declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];

  const toolByName = new Map<string, PluginAppTool>(
    appTools.map((t) => [t.name, t])
  );
  const activeSceneId = host.getActiveSceneId();

  const executor: ToolExecutor = async (name, args) => {
    const def = toolByName.get(name);
    if (!def) {
      // Unknown tool — feed back a structured failure so the model can
      // recover (e.g., re-pick from the actual list). Do not throw.
      const known = appTools.map((t) => t.name).join(', ');
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: `Unknown tool '${name}'. Available scene-scoped tools: ${known}`,
      };
    }

    const params = injectActiveSceneId(args, def, activeSceneId);
    return invokeSas({
      action: name,
      params,
      appExe: cliPaths.appExe,
      cliEntry: cliPaths.cliEntry,
    });
  };

  return { tools, executor };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFunctionDeclaration(tool: PluginAppTool): LLMFunctionDeclaration {
  // The host emits JSON Schema in `inputSchema`. Gemini accepts a deliberate
  // subset; the shape is compatible enough to pass through verbatim. If
  // properties is undefined, surface an empty object so Gemini doesn't
  // reject the declaration.
  const properties = isRecord(tool.inputSchema.properties)
    ? tool.inputSchema.properties
    : {};
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties,
      required: tool.inputSchema.required,
    },
  };
}

function injectActiveSceneId(
  args: Record<string, unknown>,
  def: PluginAppTool,
  activeSceneId: string | null
): Record<string, unknown> {
  if (!activeSceneId) return args;
  const props = def.inputSchema.properties;
  if (!isRecord(props)) return args;
  if (!('sceneId' in props)) return args;
  if ('sceneId' in args && args.sceneId !== undefined && args.sceneId !== '') {
    return args;
  }
  return { ...args, sceneId: activeSceneId };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
