/**
 * panel-tools — discover the host's scene-scoped tools and adapt them for
 * the agent loop.
 *
 * Two outputs:
 *   - `tools`: the LLM-facing `LLMTool[]` (Gemini `functionDeclarations`
 *     shape) handed to the agent backend.
 *   - `executor`: a `ToolExecutor` that dispatches each function call.
 *
 * Tool discovery goes through `host.listAppTools({ scope: 'scene' })` —
 * the same authoritative list the CLI exposes.
 *
 * Execution transport (Phase 2a):
 *   - `'in-process'` (default): `host.executeAppTool(name, params,
 *     { provenance: 'agent' })` → ToolRegistry directly. Saves the
 *     ~300–800 ms `sas` CLI subprocess spawn per call; the full
 *     OperationResult (remediation, clarification, nextSteps) rides on
 *     `res.data`, so the model sees the SAME envelope the CLI prints.
 *   - `'cli'`: the historical `sas` subprocess path. Rollback switch:
 *     set `SAS_CHAT_TOOL_TRANSPORT=cli` (or pass `transport: 'cli'`).
 */

import type {
  PluginHost,
  PluginAppTool,
  LLMTool,
  LLMFunctionDeclaration,
} from '@signalsandsorcery/plugin-sdk';
import { invokeSas } from './sas-tool-handler';
import type { AgentNextStep, ToolExecutor, ToolExecutionResult } from './agent-loop';
import {
  ASK_USER_TOOL_NAME,
  CHAT_TASK_LEDGER_TOOL_NAME,
  PRODUCER_PREFERENCES_TOOL_NAME,
} from './constants';

export { ASK_USER_TOOL_NAME, CHAT_TASK_LEDGER_TOOL_NAME, PRODUCER_PREFERENCES_TOOL_NAME };

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
  /**
   * Paths for spawning the `sas` CLI. From `host.getCliPaths()` typically.
   * Only required for the `'cli'` transport — the default in-process
   * transport never spawns a subprocess.
   */
  cliPaths?: { appExe: string; cliEntry: string } | null;
  /**
   * When provided, registers the synthetic `ask_user` tool the LLM can
   * call mid-loop to surface a focused clarifying question to the user.
   * The returned string is fed back as the tool's stdout, so the loop
   * continues without restarting a turn. Omit to disable the tool
   * entirely (the LLM falls back to plain-text responses).
   */
  awaitUserResponse?: AwaitUserResponse;
  /**
   * Tool-execution transport. Default resolution order: this option →
   * `SAS_CHAT_TOOL_TRANSPORT` env var → `'in-process'`.
   */
  transport?: 'in-process' | 'cli';
  /**
   * Watchdog for in-process calls. A handler that never settles would
   * otherwise wedge the agent loop forever (the CLI path had a subprocess
   * timeout; this is its in-process equivalent). The underlying handler
   * keeps running detached — if it eventually mutates, the mutation
   * broadcast + next turn's ambient refresh surface the change.
   * Default 300 000 ms (matches the CLI timeout). Test seam.
   */
  inProcessTimeoutMs?: number;
}

/** Default watchdog for in-process tool calls — mirrors the CLI's 300 s. */
const DEFAULT_IN_PROCESS_TIMEOUT_MS = 300_000;

/** Resolve the effective transport from option + env. */
function resolveTransport(
  explicit: 'in-process' | 'cli' | undefined,
): 'in-process' | 'cli' {
  if (explicit) return explicit;
  const env =
    typeof process !== 'undefined' ? process.env?.SAS_CHAT_TOOL_TRANSPORT : undefined;
  if (env === 'cli') return 'cli';
  if (env === 'in-process') return 'in-process';
  return 'in-process';
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
/**
 * Project-scoped / deferred tools promoted onto the agent's DEFAULT
 * declaration set (Phase 5b). The scene scan hides everything project-scoped
 * and deferred; before promotion the agent burned a tool_search hop for each
 * of these on every producer-loop turn (job polling, verify, inspect,
 * checkpoint/undo, transitions, deck transport, save). Promotion is DATA —
 * trim per Errantry friction diff. Each entry costs prompt tokens on every
 * request (~13 tools ≈ +3.3–4.5k tokens), so promote sparingly.
 */
export const PROMOTED_PROJECT_TOOLS: readonly string[] = [
  'get_job_status',
  'wait_for_job',
  'sas_render_preview',
  'sas_inspect_project',
  'sas_inspect_scene',
  'sas_history_checkpoint',
  'sas_history_undo',
  'create_transition',
  'list_transitions',
  'deck_play',
  'deck_stop',
  'project_save',
];

export async function buildPanelTools(
  options: BuildPanelToolsOptions
): Promise<PanelTools> {
  const { host, cliPaths, awaitUserResponse } = options;
  const transport = resolveTransport(options.transport);
  const inProcessTimeoutMs =
    options.inProcessTimeoutMs ?? DEFAULT_IN_PROCESS_TIMEOUT_MS;
  // Defensive copy — we append promoted tools below and must never mutate
  // the array the host handed us.
  const appTools = [...(await host.listAppTools({ scope: 'scene' }))];
  const declarations: LLMFunctionDeclaration[] = appTools.map(
    toFunctionDeclaration,
  );
  // Deferred-tool cache (declared early so the promotion scan can seed it —
  // see the lazy-resolution comment further down for why it exists).
  const deferredCache = new Map<string, PluginAppTool>();
  // Surface promotion (Phase 5b): ONE includeDeferred scan, filtered to the
  // allowlist, deduped against the scene surface. The same scan seeds the
  // deferred cache, so tool_search→invoke dispatches need no extra lookup.
  // Failures degrade to the un-promoted surface — tool_search still reaches
  // everything via the lazy path.
  try {
    const fullSurface = await host.listAppTools({ includeDeferred: true });
    for (const t of fullSurface) deferredCache.set(t.name, t);
    const sceneNames = new Set(appTools.map((t) => t.name));
    const promoted = fullSurface.filter(
      (t) => PROMOTED_PROJECT_TOOLS.includes(t.name) && !sceneNames.has(t.name),
    );
    declarations.push(...promoted.map(toFunctionDeclaration));
    appTools.push(...promoted);
  } catch {
    // un-promoted surface is still functional
  }
  // Promote the persistent per-project journal (sas_project_notes_*) onto the
  // default surface so the agent uses its cross-session memory without a
  // tool_search first. They're project-scoped (excluded from the scene scan);
  // we surface concise declarations here and let the executor's deferred-
  // resolution path dispatch them — no extra build-time listAppTools call.
  declarations.push(...buildMemoryToolDeclarations());
  if (awaitUserResponse) {
    declarations.push(buildAskUserDeclaration());
  }
  // The session task/goal ledger is always available — plugin-local state, not
  // gated on the clarification transport.
  declarations.push(buildTaskLedgerDeclaration());
  // Taste/preference memory (Phase 5c) — always available, plugin-local.
  declarations.push(buildProducerPreferencesDeclaration());
  const tools: LLMTool[] =
    declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];

  const toolByName = new Map<string, PluginAppTool>(
    appTools.map((t) => [t.name, t])
  );

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
  //
  // The cache itself is declared above (the promotion scan pre-seeds it);
  // this lazy path only fires when that scan failed.
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

    if (name === CHAT_TASK_LEDGER_TOOL_NAME) {
      // Synthetic tool — session goal ledger in project-scoped plugin_data.
      // Bypasses the CLI subprocess entirely.
      return handleTaskLedger(host, args);
    }

    if (name === PRODUCER_PREFERENCES_TOOL_NAME) {
      // Synthetic tool — durable taste memory in project-scoped plugin_data.
      return handleProducerPreferences(host, args);
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

    // Active scene id is read at CALL time (not captured at build time):
    // tool calls earlier in this very turn can switch the active scene
    // (compose_scene), and Phase 2b keeps one loop alive across scene
    // changes — a build-time snapshot would silently target a dead scene.
    const params = injectActiveSceneId(args, def, host.getActiveSceneId());

    if (transport === 'cli') {
      if (!cliPaths) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr:
            `Tool '${name}' could not be dispatched: CLI transport selected ` +
            `but the host provided no CLI paths (sas binary not built?).`,
        };
      }
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
    }

    return executeInProcess(host, name, params, inProcessTimeoutMs);
  };

  return { tools, executor };
}

/**
 * In-process dispatch: `host.executeAppTool` → ToolRegistry directly, with
 * agent provenance so emitted domain events are attributed correctly.
 *
 * Result mapping keeps the SAME shape the CLI transport produced so
 * `truncateForLLM`, `extractNextSteps`, the UI rows, and the Errantry
 * metrics all stay stable:
 *   - success → serialized OperationResult in `stdout` (what the CLI prints)
 *   - failure → serialized OperationResult in `stderr` (where the CLI puts
 *     the structured remediation/clarification envelope)
 *
 * Exported for unit testing.
 */
export async function executeInProcess(
  host: PluginHost,
  name: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolExecutionResult> {
  type ExecuteAppToolWithOpts = (
    name: string,
    params: Record<string, unknown>,
    opts?: { provenance?: 'agent' | 'user' },
  ) => ReturnType<PluginHost['executeAppTool']>;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Tool '${name}' timed out after ${Math.round(timeoutMs / 1000)}s ` +
            `(in-process watchdog). The operation may still complete in the ` +
            `background — re-inspect state before retrying.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    // The third (opts) argument is SDK 2.18.0; older hosts simply ignore
    // extra arguments, so this is safe across host versions.
    const res = await Promise.race([
      (host.executeAppTool as ExecuteAppToolWithOpts)(name, params, {
        provenance: 'agent',
      }),
      watchdog,
    ]);

    // `res.data` carries the FULL OperationResult (remediation,
    // clarification, nextSteps, changes). Fall back to the thin wrapper
    // fields if a host predates the data passthrough.
    const op: Record<string, unknown> = isRecord(res.data)
      ? res.data
      : {
          success: res.success,
          action: res.action,
          message: res.message,
          error: res.error,
        };
    const serialized = JSON.stringify(op);
    if (res.success) {
      return {
        success: true,
        exitCode: 0,
        stdout: serialized,
        stderr: '',
        nextSteps: extractNextSteps(op),
      };
    }
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: serialized,
    };
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    return { success: false, exitCode: 1, stdout: '', stderr };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

/**
 * Synthetic declaration for `chat_task_ledger` — the session goal ledger the
 * agent uses to stay on-task across turns. Backed by project-scoped storage
 * (survives scene changes); surfaced back to the model in the ambient preamble.
 */
function buildTaskLedgerDeclaration(): LLMFunctionDeclaration {
  return {
    name: CHAT_TASK_LEDGER_TOOL_NAME,
    description:
      "Record and update the SESSION GOAL LEDGER — a short list of what you're accomplishing this session. It survives scene changes and is shown back to you in the 'Current state' preamble, so it keeps you on-task across turns. Call set_goals ONCE when the user gives a multi-step intent, then update each item to 'done' as you finish it; clear it when the work is complete. This is silent bookkeeping: do NOT announce ledger writes or ask permission, and do NOT use it for one-off single-step requests.",
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['set_goals', 'update', 'clear'],
          description:
            "set_goals: replace the whole list. update: change one item's status by its 1-based index. clear: empty the ledger when the work is done.",
        },
        goals: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For set_goals: the ordered goal descriptions (each starts as todo).',
        },
        index: {
          type: 'integer',
          description:
            'For update: the 1-based index of the goal as shown in the Current state preamble.',
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done'],
          description: 'For update: the new status of the goal.',
        },
      },
      required: ['op'],
    },
  };
}

/**
 * Synthetic declaration for `producer_preferences` — the durable taste
 * memory (Phase 5c). One structured preference per lesson, reflexion-style:
 * recorded when the user REACTS to something they heard, read back every
 * turn via the "Producer preferences" ambient block.
 */
function buildProducerPreferencesDeclaration(): LLMFunctionDeclaration {
  return {
    name: PRODUCER_PREFERENCES_TOOL_NAME,
    description:
      "Record and maintain the user's DURABLE PRODUCTION PREFERENCES — short structured lessons about their taste ('bass low in the mix', 'prefers sparse hats', 'choruses are 8 bars'). Call op=add ONCE when the user reacts to something they heard with a clear preference signal ('too loud', 'love that swing') or states a durable preference. source='explicit' ONLY for things the user literally said; use source='inferred' for lessons you deduced. Active preferences are shown back to you in the 'Current state' preamble — honor them without being asked. Use op=update/remove when a preference changes; op=list for the full set. Silent bookkeeping: don't announce writes. NOT for session goals (chat_task_ledger) or one-off instructions.",
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['list', 'add', 'update', 'remove'],
          description:
            'add: record one preference. update: replace the text of one by 1-based index. remove: delete one by 1-based index. list: return all.',
        },
        category: {
          type: 'string',
          enum: ['mix', 'density', 'fx', 'tone', 'reference', 'workflow'],
          description:
            'For add: what the preference is about. mix=levels/balance, density=busy vs sparse, fx=effects taste, tone=timbre/sound character, reference=artists/genres they cite, workflow=how they like to work.',
        },
        text: {
          type: 'string',
          description: 'For add/update: ONE terse sentence stating the preference.',
        },
        source: {
          type: 'string',
          enum: ['explicit', 'inferred'],
          description:
            "For add: 'explicit' = the user said it in so many words; 'inferred' = deduced from their reactions. Never record guesses as explicit.",
        },
        index: {
          type: 'integer',
          description: 'For update/remove: the 1-based index shown by op=list / the preamble.',
        },
      },
      required: ['op'],
    },
  };
}

/** Concise chat-surface declarations for the persistent per-project journal
 *  (cross-session memory). Hand-written rather than pulled from the registry so
 *  surfacing them costs no extra build-time listAppTools call; execution still
 *  flows through the real tool via the executor's deferred-resolution path. */
function buildMemoryToolDeclarations(): LLMFunctionDeclaration[] {
  return [
    {
      name: 'sas_project_notes_read',
      description:
        "Read the project's persistent journal — your cross-session memory of the user's durable preferences and past creative decisions. A tail of it is shown in the 'Current state' preamble; call this for the FULL history when the user asks a memory question or the tail is insufficient.",
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'sas_project_notes_write',
      description:
        "Append to the project's persistent journal — your cross-session memory. Use mode='append' to record ONE terse line when the user states a durable preference or makes a significant creative decision. Do NOT record ephemeral actions (use chat_task_ledger for session goals). Silent bookkeeping — don't ask permission.",
      parameters: {
        type: 'object',
        properties: {
          body: {
            type: 'string',
            description: 'Text to record. One terse line for append.',
          },
          mode: {
            type: 'string',
            enum: ['append', 'replace'],
            description:
              "Default 'append'. Use 'replace' only to rewrite/summarize the whole journal.",
          },
        },
        required: ['body'],
      },
    },
  ];
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

/** Cap the preamble so it doesn't crowd out tool descriptions or conversation
 *  history in the model's context budget. Bumped 2KB→2.6KB in Phase 2 to hold
 *  the session-goals + journal-tail blocks; 2.6KB→3KB in Phase 5c for the
 *  producer-preferences block. */
const AMBIENT_CONTEXT_CAP = 3_000;
/** Max preference lines shown in the preamble; the rest collapse to a count. */
const AMBIENT_MAX_PREFERENCES = 6;
const AMBIENT_MAX_SCENES = 8;
const AMBIENT_MAX_TRACKS = 16;
const AMBIENT_MAX_HISTORY = 3;
/** Max open goals shown in the preamble; the rest collapse to a "+N more". */
const AMBIENT_MAX_GOALS = 5;
/** Byte budget for the journal tail injected as "Remembered preferences". */
const AMBIENT_PREFS_TAIL = 700;

/** project-scoped plugin_data key for the session task/goal ledger. */
const TASK_LEDGER_KEY = 'chat.taskLedger';
/** Prepended (only to the returned string, never the cached body) when the
 *  project mutated since this host's last preamble render. */
const STATE_CHANGED_NOTE =
  'Note: project state changed since your last turn — trust the state below over your memory.';

/** Time-based fallback for hosts that don't yet expose `getMutationSeq()`
 *  (SDK pre-2.6). Hosts on the new contract use the monotonic counter
 *  directly and the TTL becomes irrelevant. Resolves C-5 +
 *  the §2.6 mutation-seq follow-up in `docs/chat-cli-architecture.md`. */
const AMBIENT_CACHE_TTL_MS = 5_000;

interface AmbientCacheEntry {
  /** Active scene id at compute time. Cache invalidates immediately when this changes. */
  activeSceneId: string | null;
  /** Wallclock ms of compute. Used by the TTL fallback path only. */
  ts: number;
  /**
   * Mutation-seq snapshot at compute time. When `host.getMutationSeq()`
   * is available and unchanged, the cache is valid regardless of age.
   * `null` when the host predates SDK 2.6 (we fall back to TTL).
   */
  mutationSeq: number | null;
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
  invalidateAmbientCache(host);
}

/**
 * Invalidate the ambient preamble cache for a host. Needed after a state write
 * that does NOT bump `getMutationSeq()` — notably a `setProjectData` task-ledger
 * write. (The CLI / executeAppTool path self-invalidates because it broadcasts
 * a mutation; the in-process key-value path does not.)
 */
export function invalidateAmbientCache(host: PluginHost): void {
  ambientCache.delete(host);
}

/** Read `host.getMutationSeq()` defensively (SDK 2.6+; null on older hosts). */
function readMutationSeq(host: PluginHost): number | null {
  const fn = (host as { getMutationSeq?: () => number }).getMutationSeq;
  return typeof fn === 'function' ? fn.call(host) : null;
}

// --- Session task/goal ledger (project-scoped, survives scene change) -------

type TaskStatus = 'todo' | 'in_progress' | 'done';
interface TaskLedgerItem {
  text: string;
  status: TaskStatus;
}

function isTaskLedgerItem(v: unknown): v is TaskLedgerItem {
  return (
    isRecord(v) &&
    typeof v.text === 'string' &&
    (v.status === 'todo' || v.status === 'in_progress' || v.status === 'done')
  );
}

/** Read the session ledger from project-scoped plugin_data. Defensive: returns
 *  [] when the host lacks the storage API, the key is unset, or the value is
 *  malformed. */
async function readTaskLedger(host: PluginHost): Promise<TaskLedgerItem[]> {
  const getter = (host as {
    getProjectData?: <T>(key: string) => Promise<T | null>;
  }).getProjectData;
  if (typeof getter !== 'function') return [];
  try {
    const raw = await getter.call(host, TASK_LEDGER_KEY);
    return Array.isArray(raw) ? raw.filter(isTaskLedgerItem) : [];
  } catch {
    return [];
  }
}

/** Read the persistent per-project journal (cross-session memory). Defensive:
 *  returns '' on any failure so a journal hiccup never drops the rest of the
 *  preamble. */
async function readProjectJournal(host: PluginHost): Promise<string> {
  try {
    const res = await host.executeAppTool('sas_project_notes_read', {});
    if (!res.success) return '';
    const data = isRecord(res.data) ? res.data : null;
    const changes = data && isRecord(data.changes) ? data.changes : null;
    return changes && typeof changes.body === 'string' ? changes.body.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Synthetic `chat_task_ledger` handler — bypasses the CLI and reads/writes the
 * session goal ledger in project-scoped plugin_data. Ops: `set_goals` (replace
 * the list), `update` (flip one item's status by 1-based index), `clear`.
 */
async function handleTaskLedger(
  host: PluginHost,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const setter = (host as {
    setProjectData?: (key: string, value: unknown) => Promise<void>;
  }).setProjectData;
  const getter = (host as {
    getProjectData?: <T>(key: string) => Promise<T | null>;
  }).getProjectData;
  if (typeof setter !== 'function' || typeof getter !== 'function') {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr:
        'chat_task_ledger is unavailable in this session (host lacks project-data storage).',
    };
  }

  const op = typeof args.op === 'string' ? args.op : '';
  let ledger = await readTaskLedger(host);

  if (op === 'set_goals') {
    const goals = Array.isArray(args.goals)
      ? args.goals.filter(
          (g): g is string => typeof g === 'string' && g.trim().length > 0,
        )
      : [];
    ledger = goals.map((text) => ({ text: text.trim(), status: 'todo' as const }));
  } else if (op === 'update') {
    const index = typeof args.index === 'number' ? args.index : Number(args.index);
    const status = args.status;
    if (!Number.isInteger(index) || index < 1 || index > ledger.length) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: `chat_task_ledger update: index ${String(args.index)} is out of range (1..${ledger.length}).`,
      };
    }
    if (status !== 'todo' && status !== 'in_progress' && status !== 'done') {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr:
          "chat_task_ledger update: 'status' must be todo, in_progress, or done.",
      };
    }
    ledger[index - 1] = { ...ledger[index - 1], status };
  } else if (op === 'clear') {
    ledger = [];
  } else {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: `chat_task_ledger: unknown op '${op}'. Use set_goals, update, or clear.`,
    };
  }

  try {
    await setter.call(host, TASK_LEDGER_KEY, ledger);
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    return { success: false, exitCode: 1, stdout: '', stderr };
  }
  // setProjectData does NOT broadcast a mutation, so without this the cached
  // preamble would not reflect the write until the next real mutation/TTL.
  invalidateAmbientCache(host);

  const summary =
    ledger.length === 0
      ? 'Session ledger cleared.'
      : 'Session ledger:\n' +
        ledger.map((g, i) => `  ${i + 1}. [${g.status}] ${g.text}`).join('\n');
  return { success: true, exitCode: 0, stdout: summary, stderr: '' };
}

// --- Producer preferences (durable taste memory, Phase 5c) ------------------

/** project-scoped plugin_data key for the preference memory. */
const PREFERENCES_KEY = 'chat.preferences.v1';
/** Hard cap on stored preferences; eviction drops INFERRED entries first
 *  (oldest-first within each source class) — explicit user statements are
 *  the last to go. */
const MAX_PREFERENCES = 30;

type PreferenceCategory = 'mix' | 'density' | 'fx' | 'tone' | 'reference' | 'workflow';
type PreferenceSource = 'explicit' | 'inferred';
interface ProducerPreference {
  category: PreferenceCategory;
  text: string;
  source: PreferenceSource;
}

const PREFERENCE_CATEGORIES: ReadonlySet<string> = new Set([
  'mix', 'density', 'fx', 'tone', 'reference', 'workflow',
]);

function isProducerPreference(v: unknown): v is ProducerPreference {
  return (
    isRecord(v) &&
    typeof v.text === 'string' &&
    PREFERENCE_CATEGORIES.has(String(v.category)) &&
    (v.source === 'explicit' || v.source === 'inferred')
  );
}

async function readPreferences(host: PluginHost): Promise<ProducerPreference[]> {
  const getter = (host as {
    getProjectData?: <T>(key: string) => Promise<T | null>;
  }).getProjectData;
  if (typeof getter !== 'function') return [];
  try {
    const raw = await getter.call(host, PREFERENCES_KEY);
    return Array.isArray(raw) ? raw.filter(isProducerPreference) : [];
  } catch {
    return [];
  }
}

/** Evict to the cap, inferred-first then oldest-first. Exported for tests. */
export function evictPreferences(prefs: ProducerPreference[]): ProducerPreference[] {
  if (prefs.length <= MAX_PREFERENCES) return prefs;
  const out = [...prefs];
  while (out.length > MAX_PREFERENCES) {
    const inferredIdx = out.findIndex((p) => p.source === 'inferred');
    out.splice(inferredIdx >= 0 ? inferredIdx : 0, 1);
  }
  return out;
}

/**
 * Synthetic `producer_preferences` handler — durable taste memory in
 * project-scoped plugin_data. Mirrors handleTaskLedger's structure.
 */
async function handleProducerPreferences(
  host: PluginHost,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const setter = (host as {
    setProjectData?: (key: string, value: unknown) => Promise<void>;
  }).setProjectData;
  const getter = (host as {
    getProjectData?: <T>(key: string) => Promise<T | null>;
  }).getProjectData;
  if (typeof setter !== 'function' || typeof getter !== 'function') {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr:
        'producer_preferences is unavailable in this session (host lacks project-data storage).',
    };
  }

  const op = typeof args.op === 'string' ? args.op : '';
  let prefs = await readPreferences(host);

  const render = (): string =>
    prefs.length === 0
      ? 'No producer preferences recorded.'
      : 'Producer preferences:\n' +
        prefs
          .map((p, i) => `  ${i + 1}. [${p.category}] ${p.text} (${p.source})`)
          .join('\n');

  if (op === 'list') {
    return { success: true, exitCode: 0, stdout: render(), stderr: '' };
  }

  if (op === 'add') {
    const category = String(args.category ?? '');
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    const source = args.source === 'explicit' ? 'explicit' : 'inferred';
    if (!PREFERENCE_CATEGORIES.has(category)) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: `producer_preferences add: 'category' must be one of mix, density, fx, tone, reference, workflow.`,
      };
    }
    if (text.length === 0) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: "producer_preferences add: requires a non-empty 'text'.",
      };
    }
    prefs.push({ category: category as PreferenceCategory, text, source });
    prefs = evictPreferences(prefs);
  } else if (op === 'update' || op === 'remove') {
    const index = typeof args.index === 'number' ? args.index : Number(args.index);
    if (!Number.isInteger(index) || index < 1 || index > prefs.length) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: `producer_preferences ${op}: index ${String(args.index)} is out of range (1..${prefs.length}).`,
      };
    }
    if (op === 'remove') {
      prefs.splice(index - 1, 1);
    } else {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (text.length === 0) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: "producer_preferences update: requires a non-empty 'text'.",
        };
      }
      prefs[index - 1] = { ...prefs[index - 1], text };
    }
  } else {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: `producer_preferences: unknown op '${op}'. Use list, add, update, or remove.`,
    };
  }

  try {
    await setter.call(host, PREFERENCES_KEY, prefs);
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    return { success: false, exitCode: 1, stdout: '', stderr };
  }
  // setProjectData does not broadcast a mutation — invalidate so the next
  // preamble render reflects the write.
  invalidateAmbientCache(host);
  return { success: true, exitCode: 0, stdout: render(), stderr: '' };
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
  /** Pass-through from gatherCurrentState so the preamble can flag silenced
   *  tracks without a second tool call (prerequisite-graph.ts). */
  muted?: boolean;
  solo?: boolean;
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
  // Cache fast-path. The same active scene with no observed mutations
  // (preferred) or a recent compute (TTL fallback) returns the cached
  // preamble. Active-scene change blows the cache immediately.
  const activeSceneIdFromHost = host.getActiveSceneId() ?? null;
  // `getMutationSeq` is SDK 2.6+. `readMutationSeq` returns null on older
  // hosts, which falls through to the TTL path silently.
  const currentSeq = readMutationSeq(host);
  const cached = ambientCache.get(host);
  if (cached && cached.activeSceneId === activeSceneIdFromHost) {
    // Preferred: mutation-seq-keyed invalidation. No mutation since last
    // compute → cache is valid no matter how old.
    if (
      currentSeq !== null &&
      cached.mutationSeq !== null &&
      cached.mutationSeq === currentSeq
    ) {
      return cached.ambient;
    }
    // Fallback: TTL. Activates when the host doesn't yet implement
    // `getMutationSeq()` (older SDK) OR when the prior entry was cached
    // before we had a seq snapshot to compare against.
    if (
      (currentSeq === null || cached.mutationSeq === null) &&
      Date.now() - cached.ts < AMBIENT_CACHE_TTL_MS
    ) {
      return cached.ambient;
    }
  }

  // Detect "same active scene, but a mutation landed since we last rendered"
  // — used to prepend a one-line breadcrumb so the model trusts the fresh
  // state below over its own memory. Excludes the scene-change case (a
  // different scene entirely) and the TTL-only path (no seq to compare).
  const stateChangedSinceLastTurn =
    cached !== undefined &&
    cached.activeSceneId === activeSceneIdFromHost &&
    currentSeq !== null &&
    cached.mutationSeq !== null &&
    cached.mutationSeq !== currentSeq;

  try {
    const result = await host.executeAppTool('sas_inspect_project', {
      include: ['scenes', 'tracks', 'musical_context', 'history'],
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
    const musicalContext = isRecord(changes.musical_context)
      ? changes.musical_context
      : null;

    // Cross-session + session state (defensive; none of these block the preamble).
    const ledger = await readTaskLedger(host);
    const journalBody = await readProjectJournal(host);
    const preferences = await readPreferences(host);

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

    // Active scene's musical contract (key / BPM / chords). Rides the same
    // inspect round-trip via include:['musical_context'] — saves the agent a
    // separate get_musical_context call when it reasons about "does this match
    // the key/tempo?". Chord strings can be long, so cap them so they can't
    // blow the ambient budget.
    if (typeof activeSceneId === 'string' && musicalContext) {
      const key = typeof musicalContext.key === 'string' ? musicalContext.key : 'unknown';
      const bpm = typeof musicalContext.bpm === 'number' ? musicalContext.bpm : '?';
      const rawChords =
        typeof musicalContext.chord_progression === 'string'
          ? musicalContext.chord_progression
          : '';
      const chords = rawChords
        ? rawChords.length > 80
          ? `${rawChords.slice(0, 80)}…`
          : rawChords
        : 'none';
      lines.push(`Active scene contract: key=${key} bpm=${bpm} chords=${chords}`);
    }

    // Session goals — what we're working on this session. Backed by
    // project-scoped storage so it survives scene changes; kept here so the
    // agent stays on-task across turns. Show open items with their 1-based
    // ledger index (chat_task_ledger `update` references that index).
    if (ledger.length > 0) {
      const open = ledger
        .map((g, i) => ({ g, n: i + 1 }))
        .filter((e) => e.g.status !== 'done');
      if (open.length > 0) {
        lines.push('Session goals (update status via chat_task_ledger):');
        for (const { g, n } of open.slice(0, AMBIENT_MAX_GOALS)) {
          const mark = g.status === 'in_progress' ? 'in progress' : 'todo';
          lines.push(`  ${n}. [${mark}] ${g.text}`);
        }
        if (open.length > AMBIENT_MAX_GOALS) {
          lines.push(`  (+${open.length - AMBIENT_MAX_GOALS} more open)`);
        }
        const done = ledger.length - open.length;
        if (done > 0) lines.push(`  (+${done} done)`);
      }
    }

    // Tracks in the active scene — load-bearing, so listed BEFORE the full
    // scene table. Mute/solo flags ride the same payload (gatherCurrentState
    // passes them through); shown only when set so the common case stays quiet.
    if (activeSceneId) {
      const sceneTracks = tracks.filter((t) => t.sceneId === activeSceneId);
      if (sceneTracks.length > 0) {
        const visible = sceneTracks.slice(0, AMBIENT_MAX_TRACKS);
        lines.push(`Tracks in active scene (${sceneTracks.length}):`);
        for (const t of visible) {
          const name = t.displayName ?? t.name ?? '(unnamed)';
          const roleSuffix = t.role ? ` — role: ${t.role}` : '';
          const flags = `${t.muted ? ' [MUTED]' : ''}${t.solo ? ' [SOLO]' : ''}`;
          lines.push(`  - "${name}"${roleSuffix}${flags}`);
        }
        if (sceneTracks.length > AMBIENT_MAX_TRACKS) {
          lines.push(`  - (+${sceneTracks.length - AMBIENT_MAX_TRACKS} more)`);
        }
      }
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

    if (history.length > 0) {
      const recent = history
        .slice(0, AMBIENT_MAX_HISTORY)
        .map((h) => h.action ?? h.description ?? '?')
        .join(' → ');
      lines.push(`Recent actions: ${recent}`);
    }

    // Producer preferences — the durable taste memory (Phase 5c). Shown every
    // turn so recorded lessons are HONORED without re-asking; the 1-based
    // index is what producer_preferences update/remove reference.
    if (preferences.length > 0) {
      lines.push('Producer preferences (honor these; manage via producer_preferences):');
      preferences.slice(0, AMBIENT_MAX_PREFERENCES).forEach((p, i) => {
        lines.push(`  ${i + 1}. [${p.category}] ${p.text}`);
      });
      if (preferences.length > AMBIENT_MAX_PREFERENCES) {
        lines.push(
          `  (+${preferences.length - AMBIENT_MAX_PREFERENCES} more — producer_preferences op=list)`,
        );
      }
    }

    // Remembered notes & preferences — tail of the persistent per-project
    // journal (cross-session memory). Bounded tail-slice; the agent reads the
    // full body via sas_project_notes_read when it needs more.
    if (journalBody) {
      lines.push(
        'Remembered notes & preferences (journal tail — read full via sas_project_notes_read):',
      );
      let budget = AMBIENT_PREFS_TAIL;
      for (const ln of journalBody.split('\n').slice(-8)) {
        if (budget <= 0) break;
        const clipped = ln.length > budget ? ln.slice(0, budget) : ln;
        lines.push(`  ${clipped}`);
        budget -= clipped.length + 1;
      }
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

    // Snapshot the seq AFTER the executeAppTool calls above — each bumps it via
    // broadcastMutation, so the pre-build value (read at the top) never matches
    // next turn and the cache would recompute forever. The post-build value
    // equals next turn's start-of-turn seq when nothing mutated externally → hit.
    const seqAfterBuild = readMutationSeq(host);
    ambientCache.set(host, {
      activeSceneId: activeSceneIdFromHost,
      ts: Date.now(),
      mutationSeq: seqAfterBuild,
      ambient,
    });
    // The breadcrumb is turn-relative — keep it OUT of the cached body (a later
    // cache hit means nothing changed) and prepend it only to this return.
    return stateChangedSinceLastTurn ? `${STATE_CHANGED_NOTE}\n${ambient}` : ambient;
  } catch {
    // Don't poison the cache on transient failure — let the next call try
    // again. Empty string signals "skip preamble injection".
    return '';
  }
}
