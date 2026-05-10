/**
 * Tests for buildPanelTools — discovery + sceneId injection + executor wiring.
 *
 * `invokeSas` is mocked so we can assert the executor would call the right
 * action with the right (sceneId-injected) params, without actually
 * spawning a subprocess.
 */

import { ASK_USER_TOOL_NAME, buildPanelTools } from '../panel-tools';
import * as toolHandler from '../sas-tool-handler';
import type { PluginAppTool } from '@signalsandsorcery/plugin-sdk';

jest.mock('../sas-tool-handler', () => ({
  invokeSas: jest.fn(),
}));

const mockInvokeSas = toolHandler.invokeSas as jest.MockedFunction<typeof toolHandler.invokeSas>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCENE_TOOLS: PluginAppTool[] = [
  {
    name: 'scene_get_tracks',
    description: 'List tracks in active scene',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string', description: 'Scene UUID' },
      },
      required: ['sceneId'],
    },
    scope: 'scene',
  },
  {
    name: 'transport_play',
    description: 'Start playback',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    scope: 'scene',
  },
];

interface MockHost {
  listAppTools: jest.Mock;
  getActiveSceneId: jest.Mock;
}

function makeHost(activeSceneId: string | null = 'scene-uuid-123'): MockHost {
  return {
    listAppTools: jest.fn().mockResolvedValue(SCENE_TOOLS),
    getActiveSceneId: jest.fn().mockReturnValue(activeSceneId),
  };
}

const CLI_PATHS = { appExe: '/fake/Electron', cliEntry: '/fake/dist/cli/sas.js' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildPanelTools', () => {
  beforeEach(() => {
    mockInvokeSas.mockReset();
    mockInvokeSas.mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '{}',
      stderr: '',
    });
  });

  it('discovers scene-scoped tools and converts them to LLMTool function declarations', async () => {
    const host = makeHost();

    const result = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    expect(host.listAppTools).toHaveBeenCalledWith({ scope: 'scene' });
    expect(result.tools).toHaveLength(1); // one LLMTool wrapping all decls
    expect(result.tools[0].functionDeclarations).toHaveLength(2);
    expect(result.tools[0].functionDeclarations[0]).toEqual(
      expect.objectContaining({
        name: 'scene_get_tracks',
        description: 'List tracks in active scene',
        parameters: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({ sceneId: expect.any(Object) }),
          required: ['sceneId'],
        }),
      })
    );
  });

  it('returns an empty tools array when no tools are discovered', async () => {
    const host = makeHost();
    host.listAppTools.mockResolvedValueOnce([]);

    const result = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    expect(result.tools).toEqual([]);
  });

  it('executor invokes sas CLI with the bare-KV params', async () => {
    const host = makeHost();
    const { executor } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    await executor('transport_play', { foo: 'bar' });

    expect(mockInvokeSas).toHaveBeenCalledWith({
      action: 'transport_play',
      params: { foo: 'bar' },
      appExe: CLI_PATHS.appExe,
      cliEntry: CLI_PATHS.cliEntry,
    });
  });

  it('executor injects active sceneId when the tool schema has a sceneId property', async () => {
    const host = makeHost('active-scene-123');
    const { executor } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    await executor('scene_get_tracks', {});

    expect(mockInvokeSas).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'scene_get_tracks',
        params: { sceneId: 'active-scene-123' },
      })
    );
  });

  it('executor does NOT override an explicitly-provided sceneId', async () => {
    const host = makeHost('active-scene-123');
    const { executor } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    await executor('scene_get_tracks', { sceneId: 'caller-explicit-456' });

    expect(mockInvokeSas).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { sceneId: 'caller-explicit-456' },
      })
    );
  });

  it('executor does not inject sceneId when the tool has no sceneId property', async () => {
    const host = makeHost('active-scene-123');
    const { executor } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    await executor('transport_play', {});

    expect(mockInvokeSas).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'transport_play',
        params: {},
      })
    );
  });

  it('executor returns a structured failure for unknown tool names (does not throw)', async () => {
    const host = makeHost();
    const { executor } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    const result = await executor('not_a_real_tool', {});

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown tool 'not_a_real_tool'");
    expect(result.stderr).toContain('scene_get_tracks');
    expect(mockInvokeSas).not.toHaveBeenCalled();
  });

  it('skips sceneId injection when no scene is active', async () => {
    const host = makeHost(null);
    const { executor } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    await executor('scene_get_tracks', {});

    expect(mockInvokeSas).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {}, // no sceneId injected
      })
    );
  });

  describe('schema sanitization (Gemini compatibility)', () => {
    it('strips registry-only extension fields (canonical, aliases) from properties', async () => {
      const host = {
        listAppTools: jest.fn().mockResolvedValue([
          {
            name: 'make_beat',
            description: 'Make a beat',
            inputSchema: {
              type: 'object',
              properties: {
                bpm: {
                  type: 'integer',
                  description: 'Beats per minute',
                  // Registry's input-alias normalizer attaches these:
                  canonical: 'bpm',
                  aliases: ['tempo', 'beats_per_minute'],
                },
              },
              required: ['bpm'],
            },
            scope: 'scene',
          },
        ]),
        getActiveSceneId: jest.fn().mockReturnValue(null),
      };

      const result = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });

      const decl = result.tools[0].functionDeclarations[0];
      const bpm = (decl.parameters.properties as Record<string, Record<string, unknown>>)
        .bpm;
      expect(bpm).toEqual({ type: 'integer', description: 'Beats per minute' });
      expect(bpm).not.toHaveProperty('canonical');
      expect(bpm).not.toHaveProperty('aliases');
    });

    it('stringifies non-string enum values and forces type to string', async () => {
      const host = {
        listAppTools: jest.fn().mockResolvedValue([
          {
            name: 'set_bars',
            description: 'Set bar count',
            inputSchema: {
              type: 'object',
              properties: {
                bars: {
                  type: 'integer',
                  enum: [2, 4, 8, 16],
                  description: 'Bar count',
                },
              },
              required: ['bars'],
            },
            scope: 'scene',
          },
        ]),
        getActiveSceneId: jest.fn().mockReturnValue(null),
      };

      const result = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });

      const decl = result.tools[0].functionDeclarations[0];
      const bars = (decl.parameters.properties as Record<string, Record<string, unknown>>)
        .bars;
      expect(bars.type).toBe('string');
      expect(bars.enum).toEqual(['2', '4', '8', '16']);
      expect(bars.description).toBe('Bar count');
    });

    it('preserves string enums + their declared type', async () => {
      const host = {
        listAppTools: jest.fn().mockResolvedValue([
          {
            name: 'set_role',
            description: 'Pick a role',
            inputSchema: {
              type: 'object',
              properties: {
                role: {
                  type: 'string',
                  enum: ['bass', 'drums', 'lead'],
                },
              },
            },
            scope: 'scene',
          },
        ]),
        getActiveSceneId: jest.fn().mockReturnValue(null),
      };

      const result = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });

      const decl = result.tools[0].functionDeclarations[0];
      const role = (decl.parameters.properties as Record<string, Record<string, unknown>>)
        .role;
      expect(role.type).toBe('string');
      expect(role.enum).toEqual(['bass', 'drums', 'lead']);
    });

    it('does NOT register ask_user when no awaitUserResponse callback is provided', async () => {
      const host = makeHost();
      const result = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });
      const names = result.tools[0].functionDeclarations.map((d) => d.name);
      expect(names).not.toContain(ASK_USER_TOOL_NAME);
    });

    it('recurses into nested object properties and array items', async () => {
      const host = {
        listAppTools: jest.fn().mockResolvedValue([
          {
            name: 'compose_scene',
            description: 'Compose a scene',
            inputSchema: {
              type: 'object',
              properties: {
                tracks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      role: { type: 'string', canonical: 'role', aliases: ['kind'] },
                      bars: { type: 'integer', enum: [2, 4, 8] },
                    },
                  },
                },
              },
            },
            scope: 'scene',
          },
        ]),
        getActiveSceneId: jest.fn().mockReturnValue(null),
      };

      const result = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });

      const decl = result.tools[0].functionDeclarations[0];
      const tracks = (decl.parameters.properties as Record<string, Record<string, unknown>>)
        .tracks as { items: { properties: Record<string, Record<string, unknown>> } };

      // canonical/aliases stripped from the nested role
      expect(tracks.items.properties.role).toEqual({ type: 'string' });
      // integer enum coerced inside the array's items
      expect(tracks.items.properties.bars.type).toBe('string');
      expect(tracks.items.properties.bars.enum).toEqual(['2', '4', '8']);
    });
  });

  describe('ask_user synthetic tool', () => {
    it('registers ask_user when awaitUserResponse is provided', async () => {
      const host = makeHost();
      const result = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
        awaitUserResponse: jest.fn(),
      });

      const decls = result.tools[0].functionDeclarations;
      const askUser = decls.find((d) => d.name === ASK_USER_TOOL_NAME);
      expect(askUser).toBeDefined();
      expect(askUser?.parameters.required).toEqual(['question']);
      // question is required, options is optional
      const props = askUser?.parameters.properties as Record<string, { type?: string }>;
      expect(props.question.type).toBe('string');
      expect(props.options.type).toBe('array');
    });

    it('routes ask_user calls to awaitUserResponse and returns the reply as stdout', async () => {
      const host = makeHost();
      const awaitUserResponse = jest
        .fn<Promise<string>, [string, string[] | undefined]>()
        .mockResolvedValue('the bass on track 2');

      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
        awaitUserResponse,
      });

      const result = await executor(ASK_USER_TOOL_NAME, {
        question: 'Which bass?',
        options: ['track 2', 'track 5'],
      });

      expect(awaitUserResponse).toHaveBeenCalledWith('Which bass?', [
        'track 2',
        'track 5',
      ]);
      expect(result).toEqual({
        success: true,
        exitCode: 0,
        stdout: 'the bass on track 2',
        stderr: '',
      });
      // The ask_user path must NOT spawn the CLI subprocess.
      expect(mockInvokeSas).not.toHaveBeenCalled();
    });

    it('passes through ask_user without options when none provided', async () => {
      const host = makeHost();
      const awaitUserResponse = jest
        .fn<Promise<string>, [string, string[] | undefined]>()
        .mockResolvedValue('free-text answer');

      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
        awaitUserResponse,
      });

      await executor(ASK_USER_TOOL_NAME, { question: 'What scene?' });

      expect(awaitUserResponse).toHaveBeenCalledWith('What scene?', undefined);
    });

    it('rejects empty / non-string question with a structured failure (not a throw)', async () => {
      const host = makeHost();
      const awaitUserResponse = jest.fn<Promise<string>, [string, string[] | undefined]>();

      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
        awaitUserResponse,
      });

      const empty = await executor(ASK_USER_TOOL_NAME, { question: '' });
      const whitespace = await executor(ASK_USER_TOOL_NAME, { question: '   ' });
      const missing = await executor(ASK_USER_TOOL_NAME, {});

      expect(empty.success).toBe(false);
      expect(empty.stderr).toMatch(/non-empty 'question'/);
      expect(whitespace.success).toBe(false);
      expect(missing.success).toBe(false);
      // Should never have been forwarded to the host.
      expect(awaitUserResponse).not.toHaveBeenCalled();
    });

    it('feeds awaitUserResponse rejections back as synthetic failures', async () => {
      const host = makeHost();
      const awaitUserResponse = jest
        .fn<Promise<string>, [string, string[] | undefined]>()
        .mockRejectedValue(new Error('user closed the panel'));

      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
        awaitUserResponse,
      });

      const result = await executor(ASK_USER_TOOL_NAME, { question: 'go?' });
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('user closed the panel');
    });

    it("returns a friendly failure when the model calls ask_user but no callback is wired", async () => {
      // Defensive: this path can only fire if the LLM hallucinates the
      // tool (we don't register it without a callback). Verify we
      // recover instead of hanging.
      const host = makeHost();
      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });

      const result = await executor(ASK_USER_TOOL_NAME, { question: 'x' });
      expect(result.success).toBe(false);
      expect(result.stderr).toMatch(/not available/);
    });

    it('filters non-string entries out of the options array before forwarding', async () => {
      const host = makeHost();
      const awaitUserResponse = jest
        .fn<Promise<string>, [string, string[] | undefined]>()
        .mockResolvedValue('ok');

      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
        awaitUserResponse,
      });

      // Mixed-type options array — typical when the LLM half-coerces.
      await executor(ASK_USER_TOOL_NAME, {
        question: 'go?',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: ['a', 1, null, 'b'] as any,
      });

      expect(awaitUserResponse).toHaveBeenCalledWith('go?', ['a', 'b']);
    });
  });
});
