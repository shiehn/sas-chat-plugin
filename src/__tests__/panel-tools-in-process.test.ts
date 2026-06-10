/**
 * In-process tool transport (Phase 2a) — the default executor path.
 *
 * Pins the contract that replaced the CLI subprocess:
 *   - dispatch via `host.executeAppTool(name, params, { provenance: 'agent' })`;
 *   - active scene id injected at CALL time (not captured at build time);
 *   - full OperationResult serialized into stdout (success) / stderr
 *     (failure) so truncateForLLM / extractNextSteps / the UI see the same
 *     envelope the CLI printed;
 *   - watchdog converts a hung handler into a structured failure;
 *   - `SAS_CHAT_TOOL_TRANSPORT=cli` env switches back to the subprocess path.
 */

import { buildPanelTools, executeInProcess } from '../panel-tools';
import * as toolHandler from '../sas-tool-handler';
import type { PluginAppTool, PluginHost } from '@signalsandsorcery/plugin-sdk';

jest.mock('../sas-tool-handler', () => ({
  invokeSas: jest.fn(),
}));

const mockInvokeSas = toolHandler.invokeSas as jest.MockedFunction<typeof toolHandler.invokeSas>;

const SCENE_TOOLS: PluginAppTool[] = [
  {
    name: 'scene_get_tracks',
    description: 'List tracks in active scene',
    inputSchema: {
      type: 'object',
      properties: { sceneId: { type: 'string', description: 'Scene UUID' } },
      required: ['sceneId'],
    },
    scope: 'scene',
  },
];

interface MockHost {
  listAppTools: jest.Mock;
  getActiveSceneId: jest.Mock;
  executeAppTool: jest.Mock;
}

function makeHost(activeSceneId: string | null = 'scene-1'): MockHost {
  return {
    listAppTools: jest.fn().mockResolvedValue(SCENE_TOOLS),
    getActiveSceneId: jest.fn().mockReturnValue(activeSceneId),
    executeAppTool: jest.fn().mockResolvedValue({
      success: true,
      action: 'scene_get_tracks',
      message: 'ok',
      data: {
        success: true,
        action: 'scene_get_tracks',
        message: 'ok',
        changes: { tracks: [] },
      },
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SAS_CHAT_TOOL_TRANSPORT;
});

describe('in-process transport (default)', () => {
  it('dispatches via host.executeAppTool with agent provenance', async () => {
    const host = makeHost();
    const { executor } = await buildPanelTools({ host: host as unknown as PluginHost });
    const result = await executor('scene_get_tracks', {});

    expect(result.success).toBe(true);
    expect(mockInvokeSas).not.toHaveBeenCalled();
    expect(host.executeAppTool).toHaveBeenCalledWith(
      'scene_get_tracks',
      { sceneId: 'scene-1' },
      { provenance: 'agent' },
    );
  });

  it('reads the active scene at CALL time, not build time', async () => {
    const host = makeHost('scene-old');
    const { executor } = await buildPanelTools({ host: host as unknown as PluginHost });
    // Scene changes AFTER the surface was built (e.g. compose_scene earlier
    // in the same turn).
    host.getActiveSceneId.mockReturnValue('scene-new');
    await executor('scene_get_tracks', {});
    expect(host.executeAppTool).toHaveBeenCalledWith(
      'scene_get_tracks',
      { sceneId: 'scene-new' },
      { provenance: 'agent' },
    );
  });

  it('serializes the FULL OperationResult into stdout on success (with nextSteps)', async () => {
    const host = makeHost();
    host.executeAppTool.mockResolvedValue({
      success: true,
      action: 'scene_get_tracks',
      message: 'ok',
      data: {
        success: true,
        action: 'scene_get_tracks',
        message: 'ok',
        changes: { tracks: [{ id: 't1' }] },
        nextSteps: [
          { description: 'Generate MIDI', mcp: { tool: 'dsl_generate_midi', args: {} } },
        ],
      },
    });
    const { executor } = await buildPanelTools({ host: host as unknown as PluginHost });
    const result = await executor('scene_get_tracks', {});

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect(parsed.changes).toEqual({ tracks: [{ id: 't1' }] });
    expect(result.nextSteps).toEqual([
      { description: 'Generate MIDI', mcp: { tool: 'dsl_generate_midi', args: {} } },
    ]);
    expect(result.stderr).toBe('');
  });

  it('serializes the failure envelope (remediation/clarification) into stderr', async () => {
    const host = makeHost();
    host.executeAppTool.mockResolvedValue({
      success: false,
      action: 'scene_get_tracks',
      message: 'ambiguous',
      error: 'ambiguous selector',
      data: {
        success: false,
        action: 'scene_get_tracks',
        error: 'ambiguous selector',
        remediation: { category: 'clarification_needed', reason: 'two matches' },
        clarification: { question: 'Which one?', options: ['A', 'B'] },
      },
    });
    const { executor } = await buildPanelTools({ host: host as unknown as PluginHost });
    const result = await executor('scene_get_tracks', {});

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    const parsed = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(parsed.remediation).toEqual({
      category: 'clarification_needed',
      reason: 'two matches',
    });
    expect(parsed.clarification).toEqual({ question: 'Which one?', options: ['A', 'B'] });
  });

  it('watchdog converts a hung handler into a structured failure', async () => {
    const host = makeHost();
    host.executeAppTool.mockReturnValue(new Promise(() => {})); // never settles
    const result = await executeInProcess(
      host as unknown as PluginHost,
      'scene_get_tracks',
      {},
      25,
    );
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('timed out');
    expect(result.stderr).toContain('scene_get_tracks');
  });

  it('falls back to the thin wrapper when res.data is missing (older host)', async () => {
    const host = makeHost();
    host.executeAppTool.mockResolvedValue({
      success: true,
      action: 'scene_get_tracks',
      message: 'ok',
    });
    const { executor } = await buildPanelTools({ host: host as unknown as PluginHost });
    const result = await executor('scene_get_tracks', {});
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.action).toBe('scene_get_tracks');
  });
});

describe('transport selection', () => {
  it('SAS_CHAT_TOOL_TRANSPORT=cli routes through invokeSas', async () => {
    process.env.SAS_CHAT_TOOL_TRANSPORT = 'cli';
    mockInvokeSas.mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '{}',
      stderr: '',
    });
    const host = makeHost();
    const { executor } = await buildPanelTools({
      host: host as unknown as PluginHost,
      cliPaths: { appExe: '/fake/Electron', cliEntry: '/fake/sas.js' },
    });
    await executor('scene_get_tracks', {});
    expect(mockInvokeSas).toHaveBeenCalled();
    expect(host.executeAppTool).not.toHaveBeenCalled();
  });

  it('cli transport without cliPaths returns a structured failure (no throw)', async () => {
    const host = makeHost();
    const { executor } = await buildPanelTools({
      host: host as unknown as PluginHost,
      transport: 'cli',
    });
    const result = await executor('scene_get_tracks', {});
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('CLI transport');
    expect(mockInvokeSas).not.toHaveBeenCalled();
  });

  it('explicit transport option beats the env var', async () => {
    process.env.SAS_CHAT_TOOL_TRANSPORT = 'cli';
    const host = makeHost();
    const { executor } = await buildPanelTools({
      host: host as unknown as PluginHost,
      transport: 'in-process',
    });
    await executor('scene_get_tracks', {});
    expect(host.executeAppTool).toHaveBeenCalled();
    expect(mockInvokeSas).not.toHaveBeenCalled();
  });
});
