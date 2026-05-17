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
import type { AgentNextStep, ToolExecutor } from './agent-loop';
import { ASK_USER_TOOL_NAME } from './constants';

export { ASK_USER_TOOL_NAME };

export interface PanelTools {
  /** LLM-facing tool declarations (single `LLMTool` wrapping all functions). */
  tools: LLMTool[];
  /** Dispatches function calls to the `sas` CLI subprocess. */
  executor: ToolExecutor;
}

/**
 * Suspends until the user types (or button-clicks) a response to the model's
 * clarifying question. The host wires this to whatever transport surfaces
 * the question (in S&S: an IPC round-trip to the renderer's chat panel).
 *
 * Throwing/rejecting is a valid signal — the executor wraps it into a
 * synthetic tool failure so the loop stays alive.
 */
export type AwaitUserResponse = (
  question: string,
  options?: readonly string[],
) => Promise<string>;


export interface BuildPanelToolsOptions {
  host: PluginHost;
  /** Paths for spawning the `sas` CLI. From `host.getCliPaths()` typically. */
  cliPaths: { appExe: string; cliEntry: string };
  /**
   * When provided, registers the synthetic `ask_user` tool the LLM can
   * call mid-loop to surface a focused clarifying question to the user.
   * The returned string is fed back as the tool's stdout, so the loop
   * continues without restarting a turn. Omit to disable the tool
   * entirely (the LLM falls back to plain-text responses).
   */
  awaitUserResponse?: AwaitUserResponse;
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
  const { host, cliPaths, awaitUserResponse } = options;
  const appTools = await host.listAppTools({ scope: 'scene' });
  const declarations: LLMFunctionDeclaration[] = appTools.map(
    toFunctionDeclaration,
  );
  if (awaitUserResponse) {
    declarations.push(buildAskUserDeclaration());
  }
  const tools: LLMTool[] =
    declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];

  const toolByName = new Map<string, PluginAppTool>(
    appTools.map((t) => [t.name, t])
  );
  const activeSceneId = host.getActiveSceneId();

  // Lazy deferred-tool resolution. `host.listAppTools({ scope: 'scene' })`
  // above intentionally hides tools registered with `deferLoading: true`
  // (progressive-disclosure curation in the assistant's tool registry).
  // BUT `tool_search` advertises those deferred tools to the agent, and
  // Gemini will happily emit function-calls for them. If we rejected on
  // first miss, the `tool_search → invoke` contract would be broken and
  // every deferred composite (render_to_performance, create_transition,
  // deck_*, audio_routing_*, history/undo, etc.) would be unreachable
  // from chat. So on a miss we consult the FULL surface
  // (`includeDeferred: true`) once, cache, and dispatch as normal.
  //
  // The CLI subprocess path (`invokeSas` → /api/v1/execute) does NOT
  // check `deferLoading` — that flag gates discovery, not execution —
  // so once we have a def, the rest of the executor is unchanged.
  const deferredCache = new Map<string, PluginAppTool>();
  let deferredListPromise: Promise<PluginAppTool[]> | null = null;

  async function resolveDeferredTool(
    toolName: string,
  ): Promise<PluginAppTool | null> {
    const cached = deferredCache.get(toolName);
    if (cached) return cached;
    if (!deferredListPromise) {
      // Single-flight: concurrent misses for distinct deferred tools
      // share one listAppTools call. The SDK type for `listAppTools`
      // doesn't expose `includeDeferred` yet (a separate SDK 2.x bump
      // can widen it); the cast keeps this fix self-contained.
      // `PluginHostImpl` already honors the flag (see CLAUDE.md
      // "Agent-facing tool discovery is a SINGLE surface").
      deferredListPromise = (
        host.listAppTools as (opts?: {
          scope?: 'scene' | 'project';
          includeDeferred?: boolean;
        }) => Promise<PluginAppTool[]>
      )({ includeDeferred: true }).catch((err) => {
        // Reset so a transient failure doesn't poison subsequent calls.
        deferredListPromise = null;
        throw err;
      });
    }
    const full = await deferredListPromise;
    for (const t of full) deferredCache.set(t.name, t);
    return deferredCache.get(toolName) ?? null;
  }

  const executor: ToolExecutor = async (name, args, onProgress) => {
    if (name === ASK_USER_TOOL_NAME) {
      // Synthetic tool — bypass the CLI subprocess entirely. The host
      // callback is what surfaces the question to the user and waits for
      // their response. Falsy/missing callback means the LLM hallucinated
      // the tool (we didn't register it) — return a structured failure
      // so it can recover instead of hanging.
      if (!awaitUserResponse) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr:
            "Tool 'ask_user' is not available in this session — answer the user yourself or pick a sensible default.",
        };
      }
      const question =
        typeof args.question === 'string' ? args.question.trim() : '';
      if (question.length === 0) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr:
            "ask_user requires a non-empty 'question' argument (string).",
        };
      }
      const optionsArg = Array.isArray(args.options)
        ? args.options.filter((o): o is string => typeof o === 'string')
        : undefined;
      try {
        const response = await awaitUserResponse(question, optionsArg);
        return {
          success: true,
          exitCode: 0,
          stdout: response,
          stderr: '',
        };
      } catch (err) {
        const stderr = err instanceof Error ? err.message : String(err);
        return { success: false, exitCode: 1, stdout: '', stderr };
      }
    }

    let def: PluginAppTool | null = toolByName.get(name) ?? null;
    if (!def) {
      // Not in the default scene-scoped surface — check the deferred
      // surface (tools `tool_search` can advertise but that don't ship
      // in the agent's default tool list).
      try {
        def = await resolveDeferredTool(name);
      } catch (err) {
        const stderr = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: `Unable to look up deferred tool '${name}' (${stderr}).`,
        };
      }
      if (!def) {
        // Truly unknown — feed back a structured failure so the model
        // can recover (e.g., re-pick from the actual list). Do not
        // throw. Mention the deferred surface was also checked so the
        // LLM doesn't loop trying tool_search again.
        const known = appTools.map((t) => t.name).join(', ');
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr:
            `Unknown tool '${name}'. Not in the default scene-scoped surface ` +
            `and not in the deferred surface either. ` +
            `Available scene-scoped tools: ${known}. ` +
            `Use tool_search with different keywords if you need a different capability.`,
        };
      }
      // Cache the resolved def so subsequent invocations skip the
      // deferred-surface lookup entirely.
      toolByName.set(name, def);
    }

    const params = injectActiveSceneId(args, def, activeSceneId);
    const sasResult = await invokeSas({
      action: name,
      params,
      appExe: cliPaths.appExe,
      cliEntry: cliPaths.cliEntry,
      onProgress,
    });
    return {
      success: sasResult.success,
      exitCode: sasResult.exitCode,
      stdout: sasResult.stdout,
      stderr: sasResult.stderr,
      // Pull nextSteps off the CLI's parsed OperationResult so the agent loop
      // can emit a `next_steps` event. The CLI does the substitution work
      // (IDs filled in, mcp form populated) — we just narrow the shape.
      nextSteps: extractNextSteps(sasResult.parsedStdout),
    };
  };

  return { tools, executor };
}

/**
 * Narrow `OperationResult.nextSteps[]` from the CLI's parsed stdout. Returns
 * `undefined` when the parsed value isn't a success envelope with a
 * well-formed array — the agent loop treats `undefined` and `[]` the same
 * (no `next_steps` event emitted), so we don't need to distinguish them.
 *
 * Exported for unit testing.
 */
export function extractNextSteps(parsed: unknown): AgentNextStep[] | undefined {
  if (!isRecord(parsed)) return undefined;
  if (parsed.success !== true) return undefined;
  const raw = parsed.nextSteps;
  if (!Array.isArray(raw)) return undefined;
  const out: AgentNextStep[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item.description !== 'string') continue;
    const step: AgentNextStep = { description: item.description };
    if (typeof item.cli === 'string') step.cli = item.cli;
    if (isMcpShape(item.mcp)) step.mcp = item.mcp;
    if (item.priority === 'primary' || item.priority === 'secondary') {
      step.priority = item.priority;
    }
    out.push(step);
  }
  return out.length > 0 ? out : undefined;
}

function isMcpShape(
  v: unknown,
): v is { tool: string; args: Record<string, unknown> } {
  if (!isRecord(v)) return false;
  if (typeof v.tool !== 'string') return false;
  if (!isRecord(v.args)) return false;
  return true;
}

/**
 * Synthetic declaration for the `ask_user` tool. Schema mirrors what the
 * UI consumes: a `question` string and an optional `options` array of
 * 2–4 candidate quick-reply strings. No `sceneId` — clarification is
 * scene-agnostic.
 */
function buildAskUserDeclaration(): LLMFunctionDeclaration {
  return {
    name: ASK_USER_TOOL_NAME,
    description:
      'Ask the user a focused clarifying question and wait for their typed response. Use ONLY when the request is genuinely ambiguous AND a wrong guess would cost real work (multiple equally-valid candidates, missing load-bearing parameter). Do NOT use to confirm decisions you have already made or to ask "are you sure?" — operations are reversible. Returns the user\'s response as plain text in stdout.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The clarifying question. One sentence. Specific. Mention the candidate values where relevant.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional 2–4 candidate quick-reply strings. When provided, the UI renders them as clickable buttons and the user can type a free-text answer instead. Omit when the answer space is open-ended.',
        },
      },
      required: ['question'],
    },
  };
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

// ---------------------------------------------------------------------------
// Ambient context — "you are here" preamble auto-refreshed each turn.
// ---------------------------------------------------------------------------

/** Cap the preamble at ~2KB so it doesn't crowd out tool descriptions or
 *  conversation history in the model's context budget. */
const AMBIENT_CONTEXT_CAP = 2_000;
const AMBIENT_MAX_SCENES = 12;
const AMBIENT_MAX_TRACKS = 16;
const AMBIENT_MAX_HISTORY = 3;

/** Bound the ambient cache by recency, not by mutation seq (the host SDK
 *  doesn't expose one yet). Short enough that a tool mutation followed by a
 *  user message still pulls fresh state; long enough that a burst of agent
 *  turns within seconds doesn't repeatedly re-inspect the project. Resolves
 *  C-5 in `docs/chat-cli-architecture.md`. */
const AMBIENT_CACHE_TTL_MS = 5_000;

interface AmbientCacheEntry {
  /** Active scene id at compute time. Cache invalidates immediately when this changes. */
  activeSceneId: string | null;
  /** Wallclock ms of compute. Cache expires after AMBIENT_CACHE_TTL_MS. */
  ts: number;
  /** The rendered preamble string. */
  ambient: string;
}

/**
 * Per-host ambient cache. WeakMap so a discarded host doesn't pin the
 * cache entry. Keyed by the PluginHost identity — each plugin instance
 * gets its own slot.
 */
const ambientCache = new WeakMap<PluginHost, AmbientCacheEntry>();

/**
 * Force-invalidate the cache for a host. Tests use this; production code
 * doesn't need to call it (the active-scene-id check + TTL handle drift).
 */
export function _resetAmbientCacheForTests(host: PluginHost): void {
  ambientCache.delete(host);
}

interface AmbientScene {
  id?: string;
  name?: string;
  displayName?: string;
}
interface AmbientTrack {
  id?: string;
  sceneId?: string;
  name?: string;
  displayName?: string;
  role?: string;
}
interface AmbientHistory {
  action?: string;
  description?: string;
  timestamp?: string;
}

/** Format a short, agent-legible "you are here" preamble describing the
 *  current project, active scene, scene list, track roles in the active scene,
 *  and recent history. Designed to be appended to the system prompt at the
 *  start of each turn so the agent doesn't need to call sas_inspect_project
 *  before every fuzzy reference.
 *
 *  Entirely defensive: if executeAppTool fails (no project bound, host
 *  shutdown mid-turn, etc.), returns an empty string. The caller should treat
 *  empty as "skip injection, continue the turn".
 *
 *  Equivalent to Claude Code injecting `git status` + tree + CLAUDE.md every
 *  turn — cheap recurring context beats expensive recovery via tool calls. */
export async function buildAmbientContext(host: PluginHost): Promise<string> {
  // Cache fast-path. The same active scene with a recent compute returns
  // the cached preamble — most chat turns happen within seconds of each
  // other and the broad project structure doesn't change between them.
  // Active-scene changes blow the cache immediately; the TTL covers
  // other-state changes (tracks/history) at coarse granularity.
  const activeSceneIdFromHost = host.getActiveSceneId() ?? null;
  const cached = ambientCache.get(host);
  if (
    cached &&
    cached.activeSceneId === activeSceneIdFromHost &&
    Date.now() - cached.ts < AMBIENT_CACHE_TTL_MS
  ) {
    return cached.ambient;
  }

  try {
    const result = await host.executeAppTool('sas_inspect_project', {
      include: ['scenes', 'tracks', 'history'],
    });
    if (!result.success) return '';
    // executeAppTool wraps the OperationResult in `data` (see
    // PluginHostImpl.executeAppTool — `{ success, action, message, error,
    // data: result }`). The OperationResult itself carries `changes`.
    const opResult = isRecord(result.data) ? result.data : null;
    if (!opResult || !isRecord(opResult.changes)) return '';
    const changes = opResult.changes;
    const project = isRecord(changes.project) ? changes.project : null;
    const scenes: AmbientScene[] = Array.isArray(changes.scenes)
      ? (changes.scenes as AmbientScene[])
      : [];
    const tracks: AmbientTrack[] = Array.isArray(changes.tracks)
      ? (changes.tracks as AmbientTrack[])
      : [];
    const history: AmbientHistory[] = Array.isArray(changes.history)
      ? (changes.history as AmbientHistory[])
      : [];

    const lines: string[] = ['=== Current state (auto-refreshed each turn) ==='];

    // Project block: full id, surfaced as a bind-param hint so the agent
    // knows EXACTLY where to use it (db_query AND project_id = ?).
    if (project && typeof project.name === 'string') {
      lines.push(`Project name: "${project.name}"`);
    }
    if (project && typeof project.id === 'string') {
      lines.push(
        `Project id  : ${project.id}   (use as \`project_id = ?\` bind param in db_query)`,
      );
    }

    // Active scene block: same prominence + usage hint. The user switches
    // scenes a lot; per-turn refresh keeps this fresh.
    const activeSceneId =
      project && typeof project.activeSceneId === 'string'
        ? project.activeSceneId
        : host.getActiveSceneId();
    const activeScene = scenes.find((s) => s.id === activeSceneId);
    if (activeScene) {
      const name = activeScene.displayName ?? activeScene.name ?? '(unnamed)';
      lines.push(`Active scene name: "${name}"`);
    }
    if (typeof activeSceneId === 'string') {
      lines.push(
        `Active scene id  : ${activeSceneId}   (use as \`scene_id = ?\` in db_query; auto-injected into scene-scoped tools)`,
      );
    }

    // Scene listing as an explicit name→id mapping table. The previous
    // inline `[id-prefix]` format lured Gemini into passing the id AS a
    // sceneName argument; the arrow format keeps name and id structurally
    // distinct so the model can't confuse them.
    if (scenes.length > 0) {
      const visible = scenes.slice(0, AMBIENT_MAX_SCENES);
      lines.push(
        `Scenes (${scenes.length}) — pass scene_name when calling play_scene; scene_id only for db_query:`,
      );
      for (const s of visible) {
        const name = s.displayName ?? s.name ?? '(unnamed)';
        const idStr = typeof s.id === 'string' ? s.id : '<unknown>';
        lines.push(`  - "${name}"  →  id = ${idStr}`);
      }
      if (scenes.length > AMBIENT_MAX_SCENES) {
        lines.push(`  - (+${scenes.length - AMBIENT_MAX_SCENES} more — call sas_inspect_project for the full list)`);
      }
    }

    if (activeSceneId) {
      const sceneTracks = tracks.filter((t) => t.sceneId === activeSceneId);
      if (sceneTracks.length > 0) {
        const visible = sceneTracks.slice(0, AMBIENT_MAX_TRACKS);
        lines.push(`Tracks in active scene (${sceneTracks.length}):`);
        for (const t of visible) {
          const name = t.displayName ?? t.name ?? '(unnamed)';
          const roleSuffix = t.role ? ` — role: ${t.role}` : '';
          lines.push(`  - "${name}"${roleSuffix}`);
        }
        if (sceneTracks.length > AMBIENT_MAX_TRACKS) {
          lines.push(`  - (+${sceneTracks.length - AMBIENT_MAX_TRACKS} more)`);
        }
      }
    }

    if (history.length > 0) {
      const recent = history
        .slice(0, AMBIENT_MAX_HISTORY)
        .map((h) => h.action ?? h.description ?? '?')
        .join(' → ');
      lines.push(`Recent actions: ${recent}`);
    }

    lines.push('=== End current state ===');

    const joined = lines.join('\n');
    const ambient =
      joined.length <= AMBIENT_CONTEXT_CAP
        ? joined
        : (() => {
            const suffix = '\n[truncated]\n=== End ===';
            return joined.slice(0, AMBIENT_CONTEXT_CAP - suffix.length) + suffix;
          })();

    ambientCache.set(host, {
      activeSceneId: activeSceneIdFromHost,
      ts: Date.now(),
      ambient,
    });
    return ambient;
  } catch {
    // Don't poison the cache on transient failure — let the next call try
    // again. Empty string signals "skip preamble injection".
    return '';
  }
}
