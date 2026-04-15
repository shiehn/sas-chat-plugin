/**
 * Panel tool surface — maps `PluginHost` methods to `ChatAgentTool` defs.
 *
 * Section 15 of ai-orchestration-design.md: the in-app chat agent's tool
 * surface IS the PluginHost — no router, no translation layer. Each entry
 * here is a thin wrapper that calls one PluginHost method and reports the
 * result back to the LLM.
 *
 * Mutating tools are flagged `mutates: true` so the ChatAgent's loop
 * refreshes scene context after they run (Section 23.7 reinforcement
 * injection).
 */

import type { ChatAgentTool } from './chat-agent';

/**
 * Minimal subset of PluginHost we depend on. Keeping it narrow here means
 * the real PluginHost can evolve without forcing updates to this map, and
 * tests can mock the surface with a tiny object.
 */
export interface PanelHost {
  // Queries
  getPluginTracks(): Promise<Array<{ id: string; displayName?: string; role?: string }>>;
  getMusicalContext(): Promise<{ key?: string; bpm?: number; genre?: string; chords?: unknown }>;
  getActiveSceneId(): string | null;
  getTrackFxState(trackId: string): Promise<unknown>;

  // Mutations
  setTrackMute(trackId: string, muted: boolean): Promise<void>;
  setTrackSolo(trackId: string, solo: boolean): Promise<void>;
  setTrackVolume(trackId: string, volume: number): Promise<void>;
  setTrackPan(trackId: string, pan: number): Promise<void>;
  toggleTrackFx(trackId: string, category: string, enabled: boolean): Promise<void>;
  setTrackFxPreset(trackId: string, category: string, presetIndex: number): Promise<{ dryWet?: number }>;
  setTrackFxDryWet(trackId: string, category: string, value: number): Promise<void>;
  shufflePreset(trackId: string): Promise<unknown>;
  deleteTrack(trackId: string): Promise<void>;
}

// -----------------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------------

export function buildPanelTools(host: PanelHost): ChatAgentTool[] {
  return [
    // ---- Queries ----
    {
      name: 'get_tracks',
      description: 'List all tracks in the active scene with their ids, names, and roles.',
      parameters: { type: 'object', properties: {} },
      handler: () => host.getPluginTracks(),
    },
    {
      name: 'get_musical_context',
      description: "Get the scene's key, BPM, genre, and chord progression.",
      parameters: { type: 'object', properties: {} },
      handler: () => host.getMusicalContext(),
    },
    {
      name: 'get_track_fx_state',
      description: 'Get the FX state (enabled flags, presets, dry/wet) for a track.',
      parameters: {
        type: 'object',
        properties: {
          trackId: { type: 'string', description: 'Track id (from get_tracks).' },
        },
      },
      handler: (p) => host.getTrackFxState(p.trackId as string),
    },

    // ---- Track control (mutating) ----
    {
      name: 'set_track_mute',
      description: 'Mute or unmute a track.',
      parameters: {
        type: 'object',
        properties: {
          trackId: { type: 'string' },
          muted: { type: 'boolean' },
        },
      },
      mutates: true,
      handler: async (p) => {
        await host.setTrackMute(p.trackId as string, p.muted as boolean);
        return { ok: true };
      },
    },
    {
      name: 'set_track_solo',
      description: 'Solo or unsolo a track.',
      parameters: {
        type: 'object',
        properties: {
          trackId: { type: 'string' },
          soloed: { type: 'boolean' },
        },
      },
      mutates: true,
      handler: async (p) => {
        await host.setTrackSolo(p.trackId as string, p.soloed as boolean);
        return { ok: true };
      },
    },
    {
      name: 'set_track_volume',
      description: 'Set track volume (0.0 = silent, 1.0 = full).',
      parameters: {
        type: 'object',
        properties: {
          trackId: { type: 'string' },
          volume: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
      mutates: true,
      handler: async (p) => {
        await host.setTrackVolume(p.trackId as string, p.volume as number);
        return { ok: true };
      },
    },
    {
      name: 'set_track_pan',
      description: 'Set track pan (-1.0 = hard left, 0 = center, 1.0 = hard right).',
      parameters: {
        type: 'object',
        properties: {
          trackId: { type: 'string' },
          pan: { type: 'number', minimum: -1, maximum: 1 },
        },
      },
      mutates: true,
      handler: async (p) => {
        await host.setTrackPan(p.trackId as string, p.pan as number);
        return { ok: true };
      },
    },

    // ---- FX (mutating) ----
    {
      name: 'toggle_track_fx',
      description:
        'Enable or disable an FX category on a track. Categories: eq, compressor, chorus, phaser, delay, reverb.',
      parameters: {
        type: 'object',
        properties: {
          trackId: { type: 'string' },
          category: { type: 'string', enum: ['eq', 'compressor', 'chorus', 'phaser', 'delay', 'reverb'] },
          enabled: { type: 'boolean' },
        },
      },
      mutates: true,
      handler: async (p) => {
        await host.toggleTrackFx(p.trackId as string, p.category as string, p.enabled as boolean);
        return { ok: true };
      },
    },
    {
      name: 'set_track_fx_preset',
      description: 'Set the preset (1-5) for an FX category on a track.',
      parameters: {
        type: 'object',
        properties: {
          trackId: { type: 'string' },
          category: { type: 'string' },
          preset: { type: 'number', minimum: 1, maximum: 5 },
        },
      },
      mutates: true,
      handler: (p) =>
        host.setTrackFxPreset(p.trackId as string, p.category as string, p.preset as number),
    },
    {
      name: 'set_track_fx_dry_wet',
      description: 'Set dry/wet mix (0.0-1.0) for an FX category on a track.',
      parameters: {
        type: 'object',
        properties: {
          trackId: { type: 'string' },
          category: { type: 'string' },
          dryWet: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
      mutates: true,
      handler: async (p) => {
        await host.setTrackFxDryWet(p.trackId as string, p.category as string, p.dryWet as number);
        return { ok: true };
      },
    },

    // ---- Lifecycle (mutating) ----
    {
      name: 'shuffle_preset',
      description: "Randomize the synth preset on a track within the track's role.",
      parameters: { type: 'object', properties: { trackId: { type: 'string' } } },
      mutates: true,
      handler: (p) => host.shufflePreset(p.trackId as string),
    },
    {
      name: 'delete_track',
      description: 'Delete a track. This is permanent (within the scene).',
      parameters: { type: 'object', properties: { trackId: { type: 'string' } } },
      mutates: true,
      handler: async (p) => {
        await host.deleteTrack(p.trackId as string);
        return { ok: true };
      },
    },
  ];
}

// -----------------------------------------------------------------------------
// Scene snapshot builder (Section 23.7 reinforcement)
// -----------------------------------------------------------------------------

/**
 * Produces a short human-readable summary of the scene for injection into
 * the ChatAgent's system prompt. Called once at turn start and again after
 * every mutating tool call.
 */
export async function buildSceneContextSnapshot(host: PanelHost): Promise<string> {
  try {
    const [tracks, ctx] = await Promise.all([host.getPluginTracks(), host.getMusicalContext()]);

    const keyBpm = `key=${ctx.key ?? 'unknown'}, bpm=${ctx.bpm ?? 'unknown'}`;
    if (tracks.length === 0) {
      return `Active scene is empty (no tracks). ${keyBpm}.`;
    }
    const trackLines = tracks
      .map((t) => `  - ${t.displayName ?? t.id}${t.role ? ` (${t.role})` : ''} [id=${t.id}]`)
      .join('\n');
    return `Active scene: ${keyBpm}. Tracks:\n${trackLines}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Scene state unavailable: ${msg}`;
  }
}
