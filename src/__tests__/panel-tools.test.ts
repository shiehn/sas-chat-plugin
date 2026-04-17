/**
 * panel-tools spec — delegates to the host's app-tool bridge.
 *
 * After the 1.3.0 SDK refactor, panel-tools stopped hand-wiring individual
 * PluginHost methods. Instead it asks the host for every scene-scoped app
 * tool via `host.listAppTools({ scope: 'scene' })` and wraps each as a
 * `ChatAgentTool` whose handler calls `host.executeAppTool`.
 *
 * Tests verify:
 *   - buildPanelTools returns one ChatAgentTool per app tool
 *   - every tool is flagged `mutates: true`
 *   - handlers delegate to `host.executeAppTool(name, params)` and unwrap
 *     `.data` on success / throw on failure
 *   - buildSceneContextSnapshot composes a readable string from the bridge
 */

import { describe, it, expect, jest } from '@jest/globals';
import { buildPanelTools, buildSceneContextSnapshot } from '../panel-tools';
import type { PanelHost, PanelAppTool, PanelAppToolResult } from '../panel-tools';

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeHost(overrides: Partial<PanelHost> = {}): PanelHost {
  const listAppTools = jest.fn<any>().mockResolvedValue([]);
  const executeAppTool = jest.fn<any>().mockResolvedValue({
    success: true,
    action: 'noop',
    data: null,
  });
  return { listAppTools, executeAppTool, ...overrides } as unknown as PanelHost;
}

const SAMPLE_TOOLS: PanelAppTool[] = [
  {
    name: 'scene_get_tracks',
    description: 'List tracks in the active scene.',
    inputSchema: { type: 'object', properties: {} },
    scope: 'scene',
  },
  {
    name: 'dsl_play',
    description: 'Start playback.',
    inputSchema: { type: 'object', properties: {} },
    scope: 'scene',
  },
  {
    name: 'dsl_track_mute',
    description: 'Mute a track.',
    inputSchema: {
      type: 'object',
      properties: {
        trackId: { type: 'string' },
        muted: { type: 'boolean' },
      },
    },
    scope: 'scene',
  },
];
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('buildPanelTools', () => {
  describe('registry shape', () => {
    it('returns one ChatAgentTool per app tool the host advertises', async () => {
      const host = makeHost({
        listAppTools: jest.fn<any>().mockResolvedValue(SAMPLE_TOOLS),
      });
      const tools = await buildPanelTools(host);
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name)).toEqual([
        'scene_get_tracks',
        'dsl_play',
        'dsl_track_mute',
      ]);
    });

    it('requests scene-scoped tools only', async () => {
      const host = makeHost({
        listAppTools: jest.fn<any>().mockResolvedValue(SAMPLE_TOOLS),
      });
      await buildPanelTools(host);
      expect(host.listAppTools).toHaveBeenCalledWith({ scope: 'scene' });
    });

    it('forwards description, input schema, and mutates=true on each tool', async () => {
      const host = makeHost({
        listAppTools: jest.fn<any>().mockResolvedValue(SAMPLE_TOOLS),
      });
      const tools = await buildPanelTools(host);
      for (let i = 0; i < tools.length; i++) {
        expect(tools[i].name).toBe(SAMPLE_TOOLS[i].name);
        expect(tools[i].description).toBe(SAMPLE_TOOLS[i].description);
        expect(tools[i].parameters.type).toBe('object');
        expect(tools[i].mutates).toBe(true);
      }
    });
  });

  describe('handler behavior', () => {
    it('calls host.executeAppTool with the tool name and params', async () => {
      const executeAppTool = jest
        .fn<any>()
        .mockResolvedValue({ success: true, action: 'dsl_track_mute', data: { ok: true } });
      const host = makeHost({
        listAppTools: jest.fn<any>().mockResolvedValue(SAMPLE_TOOLS),
        executeAppTool,
      });
      const tools = await buildPanelTools(host);
      const muteTool = tools.find((t) => t.name === 'dsl_track_mute')!;

      await muteTool.handler({ trackId: 't-1', muted: true });

      expect(executeAppTool).toHaveBeenCalledWith('dsl_track_mute', {
        trackId: 't-1',
        muted: true,
      });
    });

    it('returns the result data on success', async () => {
      const host = makeHost({
        listAppTools: jest.fn<any>().mockResolvedValue(SAMPLE_TOOLS),
        executeAppTool: jest.fn<any>().mockResolvedValue({
          success: true,
          action: 'scene_get_tracks',
          data: { tracks: [{ id: 't1', name: 'Bass' }] },
        }),
      });
      const tool = (await buildPanelTools(host)).find((t) => t.name === 'scene_get_tracks')!;
      const result = await tool.handler({});
      expect(result).toEqual({ tracks: [{ id: 't1', name: 'Bass' }] });
    });

    it('falls back to { ok: true } when the tool returns no data payload', async () => {
      const host = makeHost({
        listAppTools: jest.fn<any>().mockResolvedValue(SAMPLE_TOOLS),
        executeAppTool: jest.fn<any>().mockResolvedValue({
          success: true,
          action: 'dsl_play',
          // no data
        }),
      });
      const tool = (await buildPanelTools(host)).find((t) => t.name === 'dsl_play')!;
      const result = await tool.handler({});
      expect(result).toEqual({ ok: true });
    });

    it('throws when the tool fails so the agent loop captures the error', async () => {
      const host = makeHost({
        listAppTools: jest.fn<any>().mockResolvedValue(SAMPLE_TOOLS),
        executeAppTool: jest.fn<any>().mockResolvedValue({
          success: false,
          action: 'dsl_play',
          error: 'no scene active',
        }),
      });
      const tool = (await buildPanelTools(host)).find((t) => t.name === 'dsl_play')!;
      await expect(tool.handler({})).rejects.toThrow(/no scene active/);
    });
  });
});

describe('buildSceneContextSnapshot', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function hostForSnapshot(
    tracksResult: PanelAppToolResult,
    ctxResult: PanelAppToolResult
  ): PanelHost {
    const executeAppTool = jest.fn<any>().mockImplementation((name: string) => {
      if (name === 'scene_get_tracks') return Promise.resolve(tracksResult);
      if (name === 'get_musical_context') return Promise.resolve(ctxResult);
      return Promise.resolve({ success: false, action: name, error: 'unexpected' });
    });
    return {
      listAppTools: jest.fn<any>().mockResolvedValue([]),
      executeAppTool,
    } as unknown as PanelHost;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('summarizes scene state as a human-readable string', async () => {
    const host = hostForSnapshot(
      {
        success: true,
        action: 'scene_get_tracks',
        data: {
          tracks: [
            { id: 't-1', name: 'Bass', role: 'bass' },
            { id: 't-2', name: 'Drums', role: 'drums' },
          ],
        },
      },
      { success: true, action: 'get_musical_context', data: { key: 'A minor', bpm: 90 } }
    );

    const snapshot = await buildSceneContextSnapshot(host);
    expect(snapshot).toContain('A minor');
    expect(snapshot).toContain('90');
    expect(snapshot).toContain('Bass');
    expect(snapshot).toContain('Drums');
  });

  it('reports "empty" when scene has no tracks', async () => {
    const host = hostForSnapshot(
      { success: true, action: 'scene_get_tracks', data: { tracks: [] } },
      { success: true, action: 'get_musical_context', data: { key: 'C', bpm: 120 } }
    );
    const snapshot = await buildSceneContextSnapshot(host);
    expect(snapshot).toMatch(/empty|no tracks/i);
  });

  it('degrades gracefully when a tool fails', async () => {
    const host = hostForSnapshot(
      { success: false, action: 'scene_get_tracks', error: 'no project' },
      { success: false, action: 'get_musical_context', error: 'no project' }
    );
    const snapshot = await buildSceneContextSnapshot(host);
    expect(typeof snapshot).toBe('string');
  });
});
