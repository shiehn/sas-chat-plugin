/**
 * panel-tools spec — maps PluginHost methods to ChatAgentTool defs.
 *
 * Each tool definition is a thin wrapper around a single PluginHost method
 * plus descriptive metadata. Tests verify:
 *   - every tool has a name, description, parameters schema, handler
 *   - handlers call the right PluginHost method with the right arguments
 *   - mutating tools are flagged `mutates: true` (so the agent loop
 *     refreshes scene context per Section 23.7)
 *   - read-only tools are NOT flagged mutates (cheap — no refresh)
 */

import { describe, it, expect, jest } from '@jest/globals';
import { buildPanelTools, buildSceneContextSnapshot } from '../panel-tools';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal fake PluginHost — only the methods panel-tools actually uses.
function makeHost(overrides: Record<string, any> = {}) {
  return {
    getPluginTracks: jest.fn<any>().mockResolvedValue([]),
    getMusicalContext: jest.fn<any>().mockResolvedValue({ key: 'C', bpm: 120 }),
    getActiveSceneId: jest.fn<any>().mockReturnValue('scene-1'),
    getTrackFxState: jest.fn<any>().mockResolvedValue({}),
    setTrackMute: jest.fn<any>().mockResolvedValue(undefined),
    setTrackSolo: jest.fn<any>().mockResolvedValue(undefined),
    setTrackVolume: jest.fn<any>().mockResolvedValue(undefined),
    setTrackPan: jest.fn<any>().mockResolvedValue(undefined),
    toggleTrackFx: jest.fn<any>().mockResolvedValue(undefined),
    setTrackFxPreset: jest.fn<any>().mockResolvedValue({ dryWet: 0.4 }),
    setTrackFxDryWet: jest.fn<any>().mockResolvedValue(undefined),
    shufflePreset: jest.fn<any>().mockResolvedValue({ presetName: 'P1' }),
    deleteTrack: jest.fn<any>().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('buildPanelTools', () => {
  // ---------------------------------------------------------------------------
  // Registry shape
  // ---------------------------------------------------------------------------

  describe('registry shape', () => {
    it('returns a non-empty array of tool defs', () => {
      const tools = buildPanelTools(makeHost());
      expect(tools.length).toBeGreaterThan(5);
    });

    it('every tool has name, description, parameters, handler', () => {
      const tools = buildPanelTools(makeHost());
      for (const t of tools) {
        expect(t.name).toBeTruthy();
        expect(t.description).toBeTruthy();
        expect(t.parameters).toBeDefined();
        expect(typeof t.handler).toBe('function');
      }
    });

    it('tool names are unique', () => {
      const tools = buildPanelTools(makeHost());
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  // ---------------------------------------------------------------------------
  // Query tools (read-only — no mutates flag)
  // ---------------------------------------------------------------------------

  describe('query tools', () => {
    it('get_tracks calls host.getPluginTracks', async () => {
      const host = makeHost();
      const tools = buildPanelTools(host);
      const tool = tools.find((t) => t.name === 'get_tracks')!;
      await tool.handler({});
      expect(host.getPluginTracks).toHaveBeenCalled();
      expect(tool.mutates).not.toBe(true);
    });

    it('get_musical_context calls host.getMusicalContext', async () => {
      const host = makeHost();
      const tools = buildPanelTools(host);
      const tool = tools.find((t) => t.name === 'get_musical_context')!;
      await tool.handler({});
      expect(host.getMusicalContext).toHaveBeenCalled();
      expect(tool.mutates).not.toBe(true);
    });

    it('get_track_fx_state calls host.getTrackFxState with trackId', async () => {
      const host = makeHost();
      const tools = buildPanelTools(host);
      const tool = tools.find((t) => t.name === 'get_track_fx_state')!;
      await tool.handler({ trackId: 't-1' });
      expect(host.getTrackFxState).toHaveBeenCalledWith('t-1');
      expect(tool.mutates).not.toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Track-control tools (mutates)
  // ---------------------------------------------------------------------------

  describe('track control — mutating', () => {
    const cases: Array<[string, string, Record<string, unknown>, unknown[]]> = [
      ['set_track_mute', 'setTrackMute', { trackId: 't-1', muted: true }, ['t-1', true]],
      ['set_track_solo', 'setTrackSolo', { trackId: 't-1', soloed: true }, ['t-1', true]],
      ['set_track_volume', 'setTrackVolume', { trackId: 't-1', volume: 0.5 }, ['t-1', 0.5]],
      ['set_track_pan', 'setTrackPan', { trackId: 't-1', pan: -0.5 }, ['t-1', -0.5]],
    ];
    it.each(cases)(
      '%s dispatches to host.%s and is flagged mutates',
      async (toolName, hostMethod, params, expectedArgs) => {
        const host = makeHost();
        const tools = buildPanelTools(host);
        const tool = tools.find((t) => t.name === toolName)!;

        await tool.handler(params);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((host as unknown as Record<string, jest.Mock<any>>)[hostMethod])
          .toHaveBeenCalledWith(...expectedArgs);
        expect(tool.mutates).toBe(true);
      }
    );
  });

  // ---------------------------------------------------------------------------
  // FX tools (mutates)
  // ---------------------------------------------------------------------------

  describe('FX tools — mutating', () => {
    it('toggle_track_fx dispatches and is mutating', async () => {
      const host = makeHost();
      const tool = buildPanelTools(host).find((t) => t.name === 'toggle_track_fx')!;
      await tool.handler({ trackId: 't-1', category: 'reverb', enabled: true });
      expect(host.toggleTrackFx).toHaveBeenCalledWith('t-1', 'reverb', true);
      expect(tool.mutates).toBe(true);
    });

    it('set_track_fx_preset dispatches and is mutating', async () => {
      const host = makeHost();
      const tool = buildPanelTools(host).find((t) => t.name === 'set_track_fx_preset')!;
      await tool.handler({ trackId: 't-1', category: 'reverb', preset: 3 });
      expect(host.setTrackFxPreset).toHaveBeenCalledWith('t-1', 'reverb', 3);
      expect(tool.mutates).toBe(true);
    });

    it('set_track_fx_dry_wet dispatches and is mutating', async () => {
      const host = makeHost();
      const tool = buildPanelTools(host).find((t) => t.name === 'set_track_fx_dry_wet')!;
      await tool.handler({ trackId: 't-1', category: 'reverb', dryWet: 0.4 });
      expect(host.setTrackFxDryWet).toHaveBeenCalledWith('t-1', 'reverb', 0.4);
      expect(tool.mutates).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle tools
  // ---------------------------------------------------------------------------

  describe('lifecycle — mutating', () => {
    it('delete_track dispatches and is mutating', async () => {
      const host = makeHost();
      const tool = buildPanelTools(host).find((t) => t.name === 'delete_track')!;
      await tool.handler({ trackId: 't-1' });
      expect(host.deleteTrack).toHaveBeenCalledWith('t-1');
      expect(tool.mutates).toBe(true);
    });

    it('shuffle_preset dispatches and is mutating (it changes track audio)', async () => {
      const host = makeHost();
      const tool = buildPanelTools(host).find((t) => t.name === 'shuffle_preset')!;
      await tool.handler({ trackId: 't-1' });
      expect(host.shufflePreset).toHaveBeenCalledWith('t-1');
      expect(tool.mutates).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Return values bubble up
  // ---------------------------------------------------------------------------

  describe('return values', () => {
    it('get_tracks returns whatever host returned', async () => {
      const host = makeHost({
        getPluginTracks: jest.fn<any>().mockResolvedValue([{ id: 't-1', displayName: 'Bass' }]),
      });
      const tool = buildPanelTools(host).find((t) => t.name === 'get_tracks')!;
      const result = await tool.handler({});
      expect(result).toEqual([{ id: 't-1', displayName: 'Bass' }]);
    });
  });
});

describe('buildSceneContextSnapshot', () => {
  it('returns a short human-readable string summarizing scene state', async () => {
    const host = makeHost({
      getPluginTracks: jest.fn<any>().mockResolvedValue([
        { id: 't-1', displayName: 'Bass', role: 'bass' },
        { id: 't-2', displayName: 'Drums', role: 'drums' },
      ]),
      getMusicalContext: jest.fn<any>().mockResolvedValue({ key: 'A minor', bpm: 90 }),
    });

    const snapshot = await buildSceneContextSnapshot(host);
    expect(snapshot).toContain('A minor');
    expect(snapshot).toContain('90');
    expect(snapshot).toContain('Bass');
    expect(snapshot).toContain('Drums');
  });

  it('degrades gracefully if host methods throw', async () => {
    const host = makeHost({
      getPluginTracks: jest.fn<any>().mockRejectedValue(new Error('boom')),
    });
    const snapshot = await buildSceneContextSnapshot(host);
    // Should still return a string (not throw) so the agent can proceed
    expect(typeof snapshot).toBe('string');
  });

  it('reports "no tracks" when the scene is empty', async () => {
    const host = makeHost({
      getPluginTracks: jest.fn<any>().mockResolvedValue([]),
    });
    const snapshot = await buildSceneContextSnapshot(host);
    expect(snapshot).toMatch(/no tracks|empty/i);
  });
});
