/**
 * Panel tool surface — bridges the host's full app-tool registry into the
 * chat agent's `ChatAgentTool[]` interface.
 *
 * Section 15 of ai-orchestration-design.md (updated): instead of hand-wiring
 * a narrow subset of host methods, the chat plugin asks the host for every
 * registered app tool scoped to `'scene'` and exposes them all to the LLM.
 * Future tools land in chat automatically. The host (`PluginHostImpl`)
 * handles scope filtering and active-scene auto-binding, so this module
 * stays dumb and generic.
 *
 * Mutates flag: we conservatively treat every app tool as mutating so the
 * ChatAgent's loop refreshes scene context after each call (Section 23.7
 * reinforcement injection). The extra LLM input rebuild per tool is cheap;
 * correctness is paramount and per-tool tagging can come later.
 */

import type { ChatAgentTool } from './chat-agent';

/**
 * Minimal surface the panel needs from the host.
 *
 * This is a structural subset of `PluginHost` from `@signalsandsorcery/plugin-sdk`
 * — kept narrow here so tests can mock with a tiny object and so this module
 * doesn't import the full SDK type surface.
 */
export interface PanelHost {
  listAppTools(opts?: { scope?: 'scene' | 'project' }): Promise<PanelAppTool[]>;
  executeAppTool(
    name: string,
    params: Record<string, unknown>
  ): Promise<PanelAppToolResult>;
}

export interface PanelAppTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  scope?: 'scene' | 'project';
}

export interface PanelAppToolResult {
  success: boolean;
  action: string;
  message?: string;
  error?: string;
  data?: unknown;
}

// -----------------------------------------------------------------------------
// Tool building
// -----------------------------------------------------------------------------

export async function buildPanelTools(host: PanelHost): Promise<ChatAgentTool[]> {
  const appTools = await host.listAppTools({ scope: 'scene' });
  return appTools.map((t): ChatAgentTool => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: 'object',
      properties: t.inputSchema.properties,
    },
    // Every app tool may mutate — refresh scene context after each call.
    mutates: true,
    handler: async (params) => {
      const result = await host.executeAppTool(t.name, params);
      if (!result.success) {
        throw new Error(result.error ?? result.message ?? `${t.name} failed`);
      }
      // Return the tool's payload — handlers in the registry wrap their
      // result in `data`. Falling back to a success marker keeps the LLM
      // output readable for tools that don't return a body.
      return result.data ?? { ok: true };
    },
  }));
}

// -----------------------------------------------------------------------------
// Scene snapshot builder (Section 23.7 reinforcement)
// -----------------------------------------------------------------------------

/**
 * Short human-readable scene summary for system-prompt injection.
 * Uses the same app-tool bridge so it sees the full scene, not just
 * plugin-owned tracks. Called once at turn start and after every mutating
 * tool call.
 */
export async function buildSceneContextSnapshot(host: PanelHost): Promise<string> {
  try {
    const [tracksResult, ctxResult] = await Promise.all([
      host.executeAppTool('scene_get_tracks', {}),
      host.executeAppTool('get_musical_context', {}),
    ]);

    const ctx = pickMusicalContext(ctxResult);
    const tracks = pickTrackSummaries(tracksResult);

    const keyBpm = `key=${ctx.key ?? 'unknown'}, bpm=${ctx.bpm ?? 'unknown'}`;
    if (tracks.length === 0) {
      return `Active scene is empty (no tracks). ${keyBpm}.`;
    }
    const trackLines = tracks
      .map((t) => `  - ${t.name}${t.role ? ` (${t.role})` : ''} [id=${t.id}]`)
      .join('\n');
    return `Active scene: ${keyBpm}. Tracks:\n${trackLines}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Scene state unavailable: ${msg}`;
  }
}

// -----------------------------------------------------------------------------
// Result parsers — tool payloads are opaque so we defensively pluck fields.
// -----------------------------------------------------------------------------

function pickMusicalContext(
  result: PanelAppToolResult
): { key?: string; bpm?: number } {
  if (!result.success) return {};
  const data = unwrap(result.data);
  if (!isRecord(data)) return {};
  const key = typeof data.key === 'string' ? data.key : undefined;
  const bpm = typeof data.bpm === 'number' ? data.bpm : undefined;
  return { key, bpm };
}

function pickTrackSummaries(
  result: PanelAppToolResult
): Array<{ id: string; name: string; role?: string }> {
  if (!result.success) return [];
  const data = unwrap(result.data);
  const rawList = isRecord(data) && Array.isArray(data.tracks) ? data.tracks : data;
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map((t): { id: string; name: string; role?: string } | null => {
      if (!isRecord(t)) return null;
      const id = typeof t.id === 'string' ? t.id : typeof t.trackId === 'string' ? t.trackId : null;
      if (!id) return null;
      const name =
        typeof t.displayName === 'string'
          ? t.displayName
          : typeof t.name === 'string'
          ? t.name
          : id;
      const role = typeof t.role === 'string' ? t.role : undefined;
      return { id, name, role };
    })
    .filter((t): t is { id: string; name: string; role?: string } => t !== null);
}

function unwrap(data: unknown): unknown {
  // ToolRegistry results are stuffed into `data` as the full OperationResult.
  // Peek one level deeper if we see the wrapper shape.
  if (isRecord(data) && 'data' in data && !('tracks' in data) && !('key' in data)) {
    return data.data;
  }
  return data;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
