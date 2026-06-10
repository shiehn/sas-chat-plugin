/**
 * Tests for buildPanelTools — discovery + sceneId injection + executor wiring.
 *
 * `invokeSas` is mocked so we can assert the executor would call the right
 * action with the right (sceneId-injected) params, without actually
 * spawning a subprocess.
 */

import { ASK_USER_TOOL_NAME, buildAmbientContext, buildPanelTools, extractNextSteps, _resetAmbientCacheForTests } from '../panel-tools';
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

// Tools registered with `deferLoading: true` — `tool_search` advertises
// them but `listAppTools({ scope: 'scene' })` filters them out. The
// chat-plugin must resolve them on-demand when the agent invokes by name.
const DEFERRED_ONLY_TOOLS: PluginAppTool[] = [
  {
    name: 'render_to_performance',
    description: 'Render the scene to the performance deck',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string', description: 'Scene UUID' },
        loopBars: { type: 'number', description: 'Loop bars' },
      },
      required: [],
    },
    scope: 'scene',
  },
  {
    name: 'create_transition',
    description: 'Create a transition between two scenes',
    inputSchema: {
      type: 'object',
      properties: {
        fromScene: { type: 'string' },
        toScene: { type: 'string' },
      },
      required: ['fromScene', 'toScene'],
    },
    scope: 'project',
  },
];
const FULL_TOOLS: PluginAppTool[] = [...SCENE_TOOLS, ...DEFERRED_ONLY_TOOLS];

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

// This suite pins the CLI transport's dispatch mechanics (Phase 2a made
// 'in-process' the default; 'cli' remains the SAS_CHAT_TOOL_TRANSPORT=cli
// rollback path). The in-process transport has its own suite in
// panel-tools-in-process.test.ts.
beforeAll(() => {
  process.env.SAS_CHAT_TOOL_TRANSPORT = 'cli';
});
afterAll(() => {
  delete process.env.SAS_CHAT_TOOL_TRANSPORT;
});

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
    // 2 scene tools + 2 promoted journal tools + the chat_task_ledger and
    // producer_preferences synthetics.
    expect(result.tools[0].functionDeclarations).toHaveLength(6);
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

  it('always offers the synthetic memory + ledger tools even when no app tools are discovered', async () => {
    const host = makeHost();
    host.listAppTools.mockResolvedValueOnce([]);

    const result = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    // No app tools, but cross-session memory + the session ledger are
    // plugin-local and always surfaced.
    expect(result.tools).toHaveLength(1);
    const names = result.tools[0].functionDeclarations.map((d) => d.name);
    expect(names).toEqual([
      'sas_project_notes_read',
      'sas_project_notes_write',
      'chat_task_ledger',
      'producer_preferences',
    ]);
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

  describe('deferred tool surface (tool_search → invoke contract)', () => {
    // Mirrors the registry's progressive-disclosure split: `listAppTools`
    // with `scope:'scene'` returns the curated default tools; with
    // `includeDeferred:true` it returns the FULL surface (default +
    // deferLoading=true tools). The chat-plugin must lazy-load deferred
    // tools the agent reaches via tool_search.
    function makeSplitHost(activeSceneId: string | null = 'scene-uuid-123'): {
      listAppTools: jest.Mock;
      getActiveSceneId: jest.Mock;
    } {
      return {
        listAppTools: jest.fn().mockImplementation((opts?: { scope?: string; includeDeferred?: boolean }) => {
          return Promise.resolve(opts?.includeDeferred ? FULL_TOOLS : SCENE_TOOLS);
        }),
        getActiveSceneId: jest.fn().mockReturnValue(activeSceneId),
      };
    }

    it('(a) resolves a deferred tool on invoke and dispatches via the CLI', async () => {
      const host = makeSplitHost('scene-uuid-abc');
      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });

      const result = await executor('render_to_performance', {});

      expect(result.success).toBe(true);
      // Build-time call (scope:'scene') + on-demand deferred call.
      expect(host.listAppTools).toHaveBeenCalledTimes(2);
      expect(host.listAppTools).toHaveBeenNthCalledWith(1, { scope: 'scene' });
      expect(host.listAppTools).toHaveBeenNthCalledWith(2, { includeDeferred: true });
      expect(mockInvokeSas).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'render_to_performance',
          // sceneId injection still fires for deferred tools that declare
          // a sceneId property.
          params: { sceneId: 'scene-uuid-abc' },
        }),
      );
    });

    it('(b) caches the resolved deferred tool — second call hits the cache', async () => {
      const host = makeSplitHost();
      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });

      await executor('render_to_performance', {});
      await executor('render_to_performance', {});

      // Two invocations, but only ONE deferred-surface lookup
      // (build-time scope:'scene' + one includeDeferred:true).
      expect(host.listAppTools).toHaveBeenCalledTimes(2);
      expect(mockInvokeSas).toHaveBeenCalledTimes(2);
    });

    it('(c) concurrent misses share one in-flight listAppTools call (single-flight)', async () => {
      // Phase 5b pre-seeds the deferred cache from the build-time promotion
      // scan; fail that scan so the LAZY single-flight path (what this test
      // pins) is the one that runs.
      const host = makeSplitHost();
      let deferredCallCount = 0;
      host.listAppTools.mockImplementation((opts?: { includeDeferred?: boolean }) => {
        if (opts?.includeDeferred) {
          deferredCallCount += 1;
          if (deferredCallCount === 1) {
            return Promise.reject(new Error('registry busy during build'));
          }
          return Promise.resolve(FULL_TOOLS);
        }
        return Promise.resolve(SCENE_TOOLS);
      });
      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });
      // Reset the mock's history so the count below is unambiguous.
      host.listAppTools.mockClear();

      await Promise.all([
        executor('render_to_performance', {}),
        executor('create_transition', { fromScene: 'A', toScene: 'B' }),
      ]);

      // Two distinct deferred tools, but only ONE includeDeferred call —
      // both resolutions awaited the same in-flight promise.
      const calls = host.listAppTools.mock.calls;
      const deferredCalls = calls.filter(
        ([opts]) => (opts as { includeDeferred?: boolean })?.includeDeferred === true,
      );
      expect(deferredCalls.length).toBe(1);
      expect(mockInvokeSas).toHaveBeenCalledTimes(2);
    });

    it('(d) truly bogus names still fail with a helpful error mentioning both surfaces', async () => {
      const host = makeSplitHost();
      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });

      const result = await executor('frobnicate_synergy', {});

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown tool 'frobnicate_synergy'");
      expect(result.stderr).toContain('deferred surface either');
      expect(result.stderr).toContain('scene_get_tracks'); // default list nudge
      expect(mockInvokeSas).not.toHaveBeenCalled();
    });

    it('(e) deferred-lookup rejection returns a structured failure; in-flight handle clears so retry works', async () => {
      const host = makeSplitHost();
      // First includeDeferred call rejects; subsequent one succeeds.
      let deferredCallCount = 0;
      host.listAppTools.mockImplementation((opts?: { includeDeferred?: boolean }) => {
        if (opts?.includeDeferred) {
          deferredCallCount += 1;
          // Call 1 = the Phase-5b build-time promotion scan (failure caught
          // silently); call 2 = the lazy lookup this test pins.
          if (deferredCallCount <= 2) {
            return Promise.reject(new Error('engine unreachable'));
          }
          return Promise.resolve(FULL_TOOLS);
        }
        return Promise.resolve(SCENE_TOOLS);
      });

      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });

      const first = await executor('render_to_performance', {});
      expect(first.success).toBe(false);
      expect(first.stderr).toContain('Unable to look up deferred tool');
      expect(first.stderr).toContain('engine unreachable');
      expect(mockInvokeSas).not.toHaveBeenCalled();

      // Retry — the in-flight handle was cleared, so this hits the
      // (now successful) listAppTools impl and dispatches.
      const second = await executor('render_to_performance', {});
      expect(second.success).toBe(true);
      expect(deferredCallCount).toBe(3);
      expect(mockInvokeSas).toHaveBeenCalledTimes(1);
    });

    it('(f) cross-scope deferred tool (scope=project) still dispatches from a scene-scoped chat surface', async () => {
      const host = makeSplitHost();
      const { executor } = await buildPanelTools({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
        cliPaths: CLI_PATHS,
      });

      const result = await executor('create_transition', {
        fromScene: 'Verse',
        toScene: 'Chorus',
      });

      expect(result.success).toBe(true);
      expect(mockInvokeSas).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'create_transition',
          // create_transition has no sceneId in its schema, so no injection.
          params: { fromScene: 'Verse', toScene: 'Chorus' },
        }),
      );
    });
  });

  it('executor surfaces nextSteps from the CLI parsed OperationResult', async () => {
    const host = makeHost();
    mockInvokeSas.mockResolvedValueOnce({
      success: true,
      exitCode: 0,
      stdout: JSON.stringify({
        success: true,
        action: 'transport_play',
        nextSteps: [
          {
            description: 'Stop playback',
            cli: 'sas transport_stop',
            mcp: { tool: 'transport_stop', args: {} },
            priority: 'primary',
          },
        ],
      }),
      stderr: '',
      parsedStdout: {
        success: true,
        action: 'transport_play',
        nextSteps: [
          {
            description: 'Stop playback',
            cli: 'sas transport_stop',
            mcp: { tool: 'transport_stop', args: {} },
            priority: 'primary',
          },
        ],
      },
    });
    const { executor } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    const result = await executor('transport_play', {});

    expect(result.success).toBe(true);
    expect(result.nextSteps).toHaveLength(1);
    expect(result.nextSteps?.[0]).toEqual({
      description: 'Stop playback',
      cli: 'sas transport_stop',
      mcp: { tool: 'transport_stop', args: {} },
      priority: 'primary',
    });
  });

  it('executor returns no nextSteps when the CLI output has none', async () => {
    const host = makeHost();
    // Default mock returns stdout: '{}' with no parsedStdout — but be explicit.
    mockInvokeSas.mockResolvedValueOnce({
      success: true,
      exitCode: 0,
      stdout: '{"success":true,"action":"transport_play"}',
      stderr: '',
      parsedStdout: { success: true, action: 'transport_play' },
    });
    const { executor } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    const result = await executor('transport_play', {});

    expect(result.success).toBe(true);
    expect(result.nextSteps).toBeUndefined();
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

describe('extractNextSteps', () => {
  it('returns the array when parsed is a success envelope with well-formed steps', () => {
    const steps = extractNextSteps({
      success: true,
      action: 'compose_scene',
      nextSteps: [
        { description: 'a', cli: 'sas a', priority: 'primary' },
        { description: 'b', mcp: { tool: 'b', args: { x: 1 } } },
      ],
    });
    expect(steps).toEqual([
      { description: 'a', cli: 'sas a', priority: 'primary' },
      { description: 'b', mcp: { tool: 'b', args: { x: 1 } } },
    ]);
  });

  it('returns undefined when success !== true', () => {
    expect(
      extractNextSteps({
        success: false,
        nextSteps: [{ description: 'x' }],
      }),
    ).toBeUndefined();
  });

  it('returns undefined for non-objects, missing nextSteps, or empty arrays', () => {
    expect(extractNextSteps(undefined)).toBeUndefined();
    expect(extractNextSteps(null)).toBeUndefined();
    expect(extractNextSteps('string')).toBeUndefined();
    expect(extractNextSteps({ success: true })).toBeUndefined();
    expect(extractNextSteps({ success: true, nextSteps: [] })).toBeUndefined();
  });

  it('drops malformed items (missing description) but keeps the well-formed siblings', () => {
    const steps = extractNextSteps({
      success: true,
      nextSteps: [
        { description: 'good' },
        { cli: 'no description' }, // dropped
        { description: 42 }, // dropped (wrong type)
        { description: 'also good', priority: 'secondary' },
      ],
    });
    expect(steps).toEqual([
      { description: 'good' },
      { description: 'also good', priority: 'secondary' },
    ]);
  });

  it('ignores unknown priority values', () => {
    const steps = extractNextSteps({
      success: true,
      nextSteps: [{ description: 'x', priority: 'tertiary' }],
    });
    expect(steps).toEqual([{ description: 'x' }]);
  });

  it('drops malformed mcp shapes', () => {
    const steps = extractNextSteps({
      success: true,
      nextSteps: [
        { description: 'a', mcp: { tool: 'a' } }, // missing args
        { description: 'b', mcp: 'not-an-object' },
        { description: 'c', mcp: { tool: 'c', args: { ok: true } } },
      ],
    });
    expect(steps).toEqual([
      { description: 'a' },
      { description: 'b' },
      { description: 'c', mcp: { tool: 'c', args: { ok: true } } },
    ]);
  });
});

describe('chat_task_ledger (synthetic) + journal surfacing', () => {
  function makeLedgerHost() {
    const store = new Map<string, unknown>();
    return {
      store,
      host: {
        listAppTools: jest.fn().mockResolvedValue(SCENE_TOOLS),
        getActiveSceneId: jest.fn().mockReturnValue('scene-uuid-123'),
        getProjectData: jest.fn(async (key: string) => store.get(key) ?? null),
        setProjectData: jest.fn(async (key: string, value: unknown) => {
          store.set(key, value);
        }),
        getMutationSeq: jest.fn(() => 1),
      },
    };
  }

  beforeEach(() => {
    mockInvokeSas.mockReset();
    mockInvokeSas.mockResolvedValue({ success: true, exitCode: 0, stdout: '{}', stderr: '' });
  });

  it('surfaces the journal + ledger tools by name on the default surface', async () => {
    const host = makeHost();
    const { tools } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });
    const names = tools[0].functionDeclarations.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'scene_get_tracks',
        'sas_project_notes_read',
        'sas_project_notes_write',
        'chat_task_ledger',
      ]),
    );
  });

  it('set_goals stores todos, update flips status, clear empties — all without the CLI', async () => {
    const { host, store } = makeLedgerHost();
    const { executor } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });

    const r1 = await executor('chat_task_ledger', {
      op: 'set_goals',
      goals: ['Make drums punchier', 'Add a riser'],
    });
    expect(r1.success).toBe(true);
    expect(store.get('chat.taskLedger')).toEqual([
      { text: 'Make drums punchier', status: 'todo' },
      { text: 'Add a riser', status: 'todo' },
    ]);
    expect(mockInvokeSas).not.toHaveBeenCalled(); // synthetic — never spawns the CLI

    const r2 = await executor('chat_task_ledger', { op: 'update', index: 1, status: 'in_progress' });
    expect(r2.success).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((store.get('chat.taskLedger') as any)[0].status).toBe('in_progress');

    const r3 = await executor('chat_task_ledger', { op: 'clear' });
    expect(r3.success).toBe(true);
    expect(store.get('chat.taskLedger')).toEqual([]);
  });

  it('update rejects an out-of-range index; unknown ops fail cleanly', async () => {
    const { host } = makeLedgerHost();
    const { executor } = await buildPanelTools({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      cliPaths: CLI_PATHS,
    });
    await executor('chat_task_ledger', { op: 'set_goals', goals: ['only one'] });

    const oob = await executor('chat_task_ledger', { op: 'update', index: 5, status: 'done' });
    expect(oob.success).toBe(false);
    expect(oob.stderr).toContain('out of range');

    const bad = await executor('chat_task_ledger', { op: 'frobnicate' });
    expect(bad.success).toBe(false);
    expect(bad.stderr).toContain('unknown op');
  });
});

describe('buildAmbientContext', () => {
  /**
   * `executeAppTool` returns a PluginAppToolResult whose `data` field is the
   * underlying OperationResult (with `changes`). The tests describe the
   * OperationResult shape directly via `inspectInner` and we wrap it here so
   * they read like the real on-the-wire payload.
   */
  function makeAmbientHost(opts: {
    inspectInner?: { success: boolean; changes?: unknown; error?: string };
    inspectThrows?: Error;
    activeSceneId?: string | null;
  } = {}) {
    const inner = opts.inspectInner ?? { success: true, changes: {} };
    return {
      executeAppTool: jest.fn(async () => {
        if (opts.inspectThrows) throw opts.inspectThrows;
        return {
          success: inner.success,
          action: 'sas_inspect_project',
          message: 'ok',
          error: inner.error,
          data: { ...inner, action: 'sas_inspect_project' },
        };
      }),
      getActiveSceneId: jest.fn(() => opts.activeSceneId ?? null),
    };
  }

  it('formats project, active scene, scene list, and tracks-in-active-scene', async () => {
    const host = makeAmbientHost({
      inspectInner: {
        success: true,
        changes: {
          project: { id: 'proj-12345678-aaaa-bbbb-cccc-dddddddddddd', name: 'Demo', activeSceneId: 'scene-aaaa1111-2222-3333-4444-555555555555' },
          musical_context: { key: 'A minor', bpm: 120, chord_progression: 'Am - F - C - G' },
          scenes: [
            { id: 'scene-aaaa1111-2222-3333-4444-555555555555', name: 'Verse 1', displayName: 'Verse 1' },
            { id: 'scene-bbbb2222-2222-3333-4444-555555555555', name: 'Chorus', displayName: 'Chorus' },
          ],
          tracks: [
            { id: 't1', sceneId: 'scene-aaaa1111-2222-3333-4444-555555555555', name: 'Drums', role: 'drums', solo: true },
            { id: 't2', sceneId: 'scene-aaaa1111-2222-3333-4444-555555555555', name: 'Bass', role: 'bass', muted: true },
            { id: 't3', sceneId: 'scene-bbbb2222-2222-3333-4444-555555555555', name: 'Pad', role: 'pads' }, // different scene
          ],
        },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = await buildAmbientContext(host as any);

    // Project block: full id + bind-param hint, not just an 8-char prefix.
    expect(text).toContain('Project name: "Demo"');
    expect(text).toContain('Project id  : proj-12345678-aaaa-bbbb-cccc-dddddddddddd');
    expect(text).toMatch(/project_id = \?/);

    // Active scene block: full id + usage hint.
    expect(text).toContain('Active scene name: "Verse 1"');
    expect(text).toContain('Active scene id  : scene-aaaa1111-2222-3333-4444-555555555555');
    expect(text).toMatch(/scene_id = \?/);

    // Scene listing uses the arrow format (name → id), no bracketed prefix.
    expect(text).toMatch(/"Verse 1"\s+→\s+id = scene-aaaa1111-2222-3333-4444-555555555555/);
    expect(text).toMatch(/"Chorus"\s+→\s+id = scene-bbbb2222-2222-3333-4444-555555555555/);

    // Active-scene track listing only includes tracks for that scene
    expect(text).toMatch(/Tracks in active scene \(2\):/);
    expect(text).toMatch(/"Drums" — role: drums/);
    expect(text).toMatch(/"Bass" — role: bass/);
    expect(text).not.toContain('Pad'); // belongs to a different scene

    // Musical contract rides the same inspect round-trip (include:['musical_context']).
    expect(text).toContain('Active scene contract: key=A minor bpm=120 chords=Am - F - C - G');

    // Mute/solo flags surface inline, only when set.
    expect(text).toMatch(/"Drums" — role: drums \[SOLO\]/);
    expect(text).toMatch(/"Bass" — role: bass \[MUTED\]/);
  });

  it('uses NO bracketed UUID-prefix on scene names (regression guard for the [fdee5834] confusion)', async () => {
    // Pre-fix the scene listing was `"techno" [fdee5834]` and Gemini tried to
    // pass that bracketed value AS a sceneName argument. The new format must
    // structurally separate name from id with the arrow notation.
    const host = makeAmbientHost({
      inspectInner: {
        success: true,
        changes: {
          project: { id: 'proj-x', name: 'p', activeSceneId: null },
          scenes: [
            { id: 'fdee5834-d206-4ba6-96e4-c65d93e52419', name: 'techno', displayName: 'techno' },
          ],
          tracks: [],
        },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = await buildAmbientContext(host as any);
    // The bracketed-prefix format is a regression source — assert NEVER present.
    expect(text).not.toMatch(/"techno"\s+\[/);
    expect(text).not.toMatch(/\[fdee5834\]/);
    // The arrow-form replacement must be present.
    expect(text).toMatch(/"techno"\s+→\s+id = fdee5834-d206-4ba6-96e4-c65d93e52419/);
  });

  it('returns empty string when executeAppTool fails (never blocks the turn)', async () => {
    const host = makeAmbientHost({ inspectThrows: new Error('no project bound') });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = await buildAmbientContext(host as any);
    expect(text).toBe('');
  });

  it('returns empty string when the inspect result is unsuccessful', async () => {
    const host = makeAmbientHost({
      inspectInner: { success: false, error: 'no project', changes: {} },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = await buildAmbientContext(host as any);
    expect(text).toBe('');
  });

  it('caps the preamble at ~2.6KB even with many scenes/tracks', async () => {
    const scenes = Array.from({ length: 50 }, (_, i) => ({
      id: `scene-${i.toString().padStart(8, '0')}`,
      name: `Scene ${i}`,
      displayName: `Scene ${i} ` + 'x'.repeat(50),
    }));
    const tracks = Array.from({ length: 100 }, (_, i) => ({
      id: `t-${i}`,
      sceneId: 'scene-00000000',
      name: `Track ${i} ` + 'y'.repeat(40),
      role: 'bass',
    }));
    const host = makeAmbientHost({
      inspectInner: {
        success: true,
        changes: {
          project: { id: 'proj-12345678', name: 'Big', activeSceneId: 'scene-00000000' },
          scenes,
          tracks,
        },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = await buildAmbientContext(host as any);
    expect(text.length).toBeLessThanOrEqual(2_600);
    expect(text).toContain('+'); // truncation indicator from "+N more" hint
  });

  it('handles missing activeSceneId gracefully (no Active scene line)', async () => {
    const host = makeAmbientHost({
      inspectInner: {
        success: true,
        changes: {
          project: { id: 'proj-12345678', name: 'Demo', activeSceneId: null },
          scenes: [{ id: 'scene-x', name: 'Lone', displayName: 'Lone' }],
          tracks: [],
        },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = await buildAmbientContext(host as any);
    expect(text).toContain('Project name: "Demo"');
    expect(text).toContain('"Lone"');
    expect(text).not.toContain('Active scene name:');
    expect(text).not.toContain('Active scene id  :');
  });

  describe('memory + session-goals injection', () => {
    function makeMemoryAmbientHost(opts: { ledger?: unknown; journal?: string }) {
      const store = new Map<string, unknown>();
      if (opts.ledger !== undefined) store.set('chat.taskLedger', opts.ledger);
      return {
        listAppTools: jest.fn().mockResolvedValue([]),
        getActiveSceneId: jest.fn(() => 'scene-1'),
        getMutationSeq: jest.fn(() => 1),
        getProjectData: jest.fn(async (k: string) => store.get(k) ?? null),
        executeAppTool: jest.fn(async (name: string) => {
          if (name === 'sas_project_notes_read') {
            return {
              success: true,
              action: name,
              data: {
                success: true,
                action: name,
                changes: { body: opts.journal ?? '', exists: Boolean(opts.journal) },
              },
            };
          }
          return {
            success: true,
            action: name,
            data: {
              success: true,
              action: name,
              changes: {
                project: { id: 'p1', name: 'Demo', activeSceneId: 'scene-1' },
                scenes: [{ id: 'scene-1', name: 'Verse', displayName: 'Verse' }],
                tracks: [],
              },
            },
          };
        }),
      };
    }

    it('renders open session goals from the ledger (done items collapse to a counter)', async () => {
      const host = makeMemoryAmbientHost({
        ledger: [
          { text: 'Make drums punchier', status: 'in_progress' },
          { text: 'Add a riser', status: 'todo' },
          { text: 'Pick a key', status: 'done' },
        ],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _resetAmbientCacheForTests(host as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = await buildAmbientContext(host as any);

      expect(text).toContain('Session goals');
      expect(text).toMatch(/1\. \[in progress\] Make drums punchier/);
      expect(text).toMatch(/2\. \[todo\] Add a riser/);
      expect(text).not.toContain('Pick a key'); // done items are hidden
      expect(text).toContain('(+1 done)');
    });

    it('renders the journal tail as "Remembered notes & preferences"', async () => {
      const host = makeMemoryAmbientHost({
        journal: 'User likes jazzy 7th chords.\nKeep choruses 8 bars.',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _resetAmbientCacheForTests(host as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = await buildAmbientContext(host as any);

      expect(text).toContain('Remembered notes & preferences');
      expect(text).toContain('Keep choruses 8 bars.');
    });
  });

  // -----------------------------------------------------------------------
  // C-5 / §2.6 mutation-seq cache invalidation
  // -----------------------------------------------------------------------

  describe('cache (mutation-seq + TTL fallback)', () => {
    function makeSeqHost(opts: {
      sceneId?: string | null;
      initialSeq?: number;
    } = {}) {
      let seq = opts.initialSeq ?? 0;
      let sceneId = opts.sceneId ?? 'scene-aaaa1111-2222-3333-4444-555555555555';
      const execute = jest.fn(async () => ({
        success: true,
        action: 'sas_inspect_project',
        message: 'ok',
        data: {
          success: true,
          action: 'sas_inspect_project',
          changes: {
            project: { id: 'p1', name: 'Demo', activeSceneId: sceneId },
            scenes: sceneId ? [{ id: sceneId, name: 'S', displayName: 'S' }] : [],
            tracks: [],
          },
        },
      }));
      return {
        execute,
        bumpSeq: (): void => {
          seq++;
        },
        setSceneId: (id: string | null): void => {
          sceneId = id;
        },
        host: {
          executeAppTool: execute,
          getActiveSceneId: jest.fn(() => sceneId),
          getMutationSeq: jest.fn(() => seq),
        },
      };
    }

    it('hits the cache across turns even though executeAppTool bumps the seq (production model)', async () => {
      // In production EVERY executeAppTool — including the preamble's own
      // inspect — bumps getMutationSeq (broadcastMutation). Snapshotting the
      // seq AFTER the build (not before) is what lets a no-external-change turn
      // still hit the cache instead of recomputing forever.
      const seqState = { value: 10 };
      const executeAppTool = jest.fn(async (name: string) => {
        seqState.value++; // model the broadcastMutation bump on every executeAppTool
        return {
          success: true,
          action: name,
          data: {
            success: true,
            action: name,
            changes: {
              project: { id: 'p1', name: 'Demo', activeSceneId: 'scene-1' },
              scenes: [{ id: 'scene-1', name: 'S', displayName: 'S' }],
              tracks: [],
            },
          },
        };
      });
      const host = {
        listAppTools: jest.fn().mockResolvedValue(SCENE_TOOLS),
        getActiveSceneId: jest.fn(() => 'scene-1'),
        executeAppTool,
        getMutationSeq: jest.fn(() => seqState.value),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _resetAmbientCacheForTests(host as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const first = await buildAmbientContext(host as any);
      const inspects1 = executeAppTool.mock.calls.filter(
        (c) => c[0] === 'sas_inspect_project',
      ).length;
      // No external mutation between turns → the second build must hit cache.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const second = await buildAmbientContext(host as any);
      const inspects2 = executeAppTool.mock.calls.filter(
        (c) => c[0] === 'sas_inspect_project',
      ).length;

      expect(first).toBe(second);
      expect(inspects2).toBe(inspects1); // cache hit despite the seq bumps
      expect(second).not.toContain('state changed since your last turn');
    });

    it('returns cached preamble when active scene + mutation seq are unchanged', async () => {
      const h = makeSeqHost({ initialSeq: 5 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _resetAmbientCacheForTests(h.host as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const first = await buildAmbientContext(h.host as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const second = await buildAmbientContext(h.host as any);

      expect(first).toBe(second);
      // One inspect (recompute) — the second invocation hit cache. Count
      // inspect calls, not total executeAppTool: each build also reads the
      // journal via sas_project_notes_read.
      expect(
        h.execute.mock.calls.filter((c) => c[0] === 'sas_inspect_project'),
      ).toHaveLength(1);
    });

    it('invalidates cache when getMutationSeq() changes (any mutation)', async () => {
      const h = makeSeqHost({ initialSeq: 5 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _resetAmbientCacheForTests(h.host as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await buildAmbientContext(h.host as any);
      h.bumpSeq();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await buildAmbientContext(h.host as any);

      // Re-inspected because a mutation occurred between turns.
      expect(
        h.execute.mock.calls.filter((c) => c[0] === 'sas_inspect_project'),
      ).toHaveLength(2);
    });

    it('prepends a "state changed" breadcrumb when a mutation lands on the same scene', async () => {
      const h = makeSeqHost({ initialSeq: 5 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _resetAmbientCacheForTests(h.host as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const first = await buildAmbientContext(h.host as any);
      // First turn has no prior snapshot → no breadcrumb.
      expect(first).not.toContain('state changed since your last turn');

      h.bumpSeq(); // a mutation lands while the active scene is unchanged
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const second = await buildAmbientContext(h.host as any);
      expect(second).toContain('state changed since your last turn');
    });

    it('does NOT show the breadcrumb on a scene change (different scene, not a same-scene mutation)', async () => {
      const h = makeSeqHost({ initialSeq: 5 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _resetAmbientCacheForTests(h.host as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await buildAmbientContext(h.host as any);
      h.setSceneId('scene-bbbb2222-2222-3333-4444-555555555555');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const second = await buildAmbientContext(h.host as any);
      expect(second).not.toContain('state changed since your last turn');
    });

    it('invalidates immediately on active-scene change (even without a mutation)', async () => {
      const h = makeSeqHost({ initialSeq: 5 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _resetAmbientCacheForTests(h.host as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await buildAmbientContext(h.host as any);
      h.setSceneId('scene-bbbb2222-2222-3333-4444-555555555555');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await buildAmbientContext(h.host as any);

      expect(
        h.execute.mock.calls.filter((c) => c[0] === 'sas_inspect_project'),
      ).toHaveLength(2);
    });

    it('falls back to TTL when host predates SDK 2.6 (no getMutationSeq)', async () => {
      // Same host shape as makeSeqHost, but without getMutationSeq.
      const sceneId = 'scene-aaaa1111-2222-3333-4444-555555555555';
      const execute = jest.fn(async () => ({
        success: true,
        action: 'sas_inspect_project',
        message: 'ok',
        data: {
          success: true,
          action: 'sas_inspect_project',
          changes: {
            project: { id: 'p1', name: 'Demo', activeSceneId: sceneId },
            scenes: [{ id: sceneId, name: 'S', displayName: 'S' }],
            tracks: [],
          },
        },
      }));
      const host = {
        executeAppTool: execute,
        getActiveSceneId: jest.fn(() => sceneId),
        // No getMutationSeq.
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _resetAmbientCacheForTests(host as any);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await buildAmbientContext(host as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await buildAmbientContext(host as any);

      // Hit the cache via TTL — both calls within the 5s window. Count inspect
      // recomputes, not total executeAppTool (each build also reads the journal).
      expect(
        execute.mock.calls.filter((c) => c[0] === 'sas_inspect_project'),
      ).toHaveLength(1);
    });
  });
});
