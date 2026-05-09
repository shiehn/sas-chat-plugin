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

  const executor: ToolExecutor = async (name, args, onProgress) => {
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
      onProgress,
    });
  };

  return { tools, executor };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFunctionDeclaration(tool: PluginAppTool): LLMFunctionDeclaration {
  // The host emits JSON Schema in `inputSchema`. Gemini's tool schema is a
  // STRICT OpenAPI subset — it rejects unknown fields (e.g. the registry's
  // `canonical` / `aliases` extensions added by the input-alias normalizer)
  // and only accepts `enum` on STRING-typed properties. Sanitize before
  // forwarding.
  const rawProperties = isRecord(tool.inputSchema.properties)
    ? tool.inputSchema.properties
    : {};
  const properties = sanitizeProperties(rawProperties);
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

/**
 * Allow-list of property fields Gemini accepts on a Schema. Anything else
 * (e.g. `canonical`, `aliases`, `$schema`, `additionalProperties`) is
 * silently dropped. The registry attaches these for CLI normalization;
 * the LLM doesn't need them.
 */
const GEMINI_SCHEMA_FIELDS = new Set([
  'type',
  'description',
  'enum',
  'format',
  'items',
  'properties',
  'required',
  'nullable',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);

function sanitizeProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(properties)) {
    out[name] = sanitizeSchema(schema);
  }
  return out;
}

function sanitizeSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;

  const out: Record<string, unknown> = {};
  let forceStringType = false;

  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_FIELDS.has(key)) continue;

    if (key === 'properties' && isRecord(value)) {
      out[key] = sanitizeProperties(value);
    } else if (key === 'items') {
      out[key] = sanitizeSchema(value);
    } else if (key === 'enum' && Array.isArray(value)) {
      // Gemini only accepts `enum` on STRING-typed schemas. If any entry
      // is non-string (common: bar counts as integers), stringify all of
      // them and force the type to "string". The CLI's input-alias
      // normalizer already coerces incoming values, so the LLM passing
      // "4" instead of 4 round-trips correctly.
      const allStrings = value.every((v) => typeof v === 'string');
      if (allStrings) {
        out.enum = value;
      } else {
        out.enum = value.map((v) => String(v));
        forceStringType = true;
      }
    } else {
      out[key] = value;
    }
  }

  if (forceStringType) out.type = 'string';
  return out;
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
