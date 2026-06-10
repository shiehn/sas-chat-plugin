/**
 * Phase 5b/5c — surface promotion + producer-preference memory.
 *
 *   - PROMOTED_PROJECT_TOOLS appear on the default declaration set via ONE
 *     includeDeferred scan, deduped against the scene surface, and are
 *     dispatchable without the lazy deferred lookup;
 *   - `producer_preferences` records/updates/removes durable taste lessons
 *     in project-scoped plugin_data with inferred-first eviction at the cap.
 */

import {
  buildPanelTools,
  evictPreferences,
  PROMOTED_PROJECT_TOOLS,
  PRODUCER_PREFERENCES_TOOL_NAME,
} from '../panel-tools';
import type { PluginAppTool, PluginHost, LLMFunctionDeclaration } from '@signalsandsorcery/plugin-sdk';

jest.mock('../sas-tool-handler', () => ({
  invokeSas: jest.fn(),
}));

const SCENE_TOOLS: PluginAppTool[] = [
  {
    name: 'scene_get_tracks',
    description: 'List tracks',
    inputSchema: { type: 'object', properties: {} },
    scope: 'scene',
  },
];

const FULL_TOOLS: PluginAppTool[] = [
  ...SCENE_TOOLS,
  {
    name: 'get_job_status',
    description: 'Poll a job',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } } },
    scope: 'project',
  },
  {
    name: 'deck_play',
    description: 'Play a deck',
    inputSchema: { type: 'object', properties: {} },
    scope: 'project',
  },
  {
    name: 'some_other_deferred',
    description: 'Not promoted',
    inputSchema: { type: 'object', properties: {} },
    scope: 'project',
  },
];

interface MockHost {
  listAppTools: jest.Mock;
  getActiveSceneId: jest.Mock;
  executeAppTool: jest.Mock;
  getProjectData: jest.Mock;
  setProjectData: jest.Mock;
}

const dataStore = new Map<string, unknown>();

function makeHost(): MockHost {
  return {
    listAppTools: jest.fn(async (opts?: { scope?: string; includeDeferred?: boolean }) =>
      opts?.includeDeferred ? FULL_TOOLS : SCENE_TOOLS,
    ),
    getActiveSceneId: jest.fn().mockReturnValue('scene-1'),
    executeAppTool: jest.fn().mockResolvedValue({
      success: true,
      action: 'x',
      message: 'ok',
      data: { success: true, action: 'x', message: 'ok' },
    }),
    getProjectData: jest.fn(async (key: string) => dataStore.get(key) ?? null),
    setProjectData: jest.fn(async (key: string, value: unknown) => {
      dataStore.set(key, value);
    }),
  };
}

function declarationNames(tools: { functionDeclarations: LLMFunctionDeclaration[] }[]): string[] {
  return tools.flatMap((t) => t.functionDeclarations.map((d) => d.name));
}

beforeEach(() => {
  jest.clearAllMocks();
  dataStore.clear();
});

describe('surface promotion (Phase 5b)', () => {
  it('promotes allowlisted project tools onto the default declarations', async () => {
    const host = makeHost();
    const { tools } = await buildPanelTools({ host: host as unknown as PluginHost });
    const names = declarationNames(tools);
    expect(names).toContain('get_job_status');
    expect(names).toContain('deck_play');
    expect(names).not.toContain('some_other_deferred');
    // Exactly one includeDeferred scan.
    const deferredScans = host.listAppTools.mock.calls.filter(
      (c) => c[0]?.includeDeferred === true,
    );
    expect(deferredScans).toHaveLength(1);
  });

  it('promoted tools dispatch in-process without a deferred lookup', async () => {
    const host = makeHost();
    const { executor } = await buildPanelTools({ host: host as unknown as PluginHost });
    host.listAppTools.mockClear();
    const result = await executor('get_job_status', { jobId: 'j1' });
    expect(result.success).toBe(true);
    expect(host.executeAppTool).toHaveBeenCalledWith(
      'get_job_status',
      { jobId: 'j1' },
      { provenance: 'agent' },
    );
    // No lazy includeDeferred re-scan needed.
    expect(host.listAppTools).not.toHaveBeenCalled();
  });

  it('a failing promotion scan degrades to the un-promoted surface', async () => {
    const host = makeHost();
    host.listAppTools.mockImplementation(async (opts?: { includeDeferred?: boolean }) => {
      if (opts?.includeDeferred) throw new Error('registry busy');
      return SCENE_TOOLS;
    });
    const { tools } = await buildPanelTools({ host: host as unknown as PluginHost });
    const names = declarationNames(tools);
    expect(names).toContain('scene_get_tracks');
    expect(names).not.toContain('get_job_status');
  });

  it('the promotion list stays modest (prompt-token budget)', () => {
    expect(PROMOTED_PROJECT_TOOLS.length).toBeLessThanOrEqual(15);
  });
});

describe('producer_preferences (Phase 5c)', () => {
  async function exec(args: Record<string, unknown>, host = makeHost()) {
    const { executor } = await buildPanelTools({ host: host as unknown as PluginHost });
    return { result: await executor(PRODUCER_PREFERENCES_TOOL_NAME, args), host };
  }

  it('declares the tool on the default surface', async () => {
    const host = makeHost();
    const { tools } = await buildPanelTools({ host: host as unknown as PluginHost });
    expect(declarationNames(tools)).toContain(PRODUCER_PREFERENCES_TOOL_NAME);
  });

  it('add → list round-trips through project data', async () => {
    const host = makeHost();
    const first = await exec(
      { op: 'add', category: 'mix', text: 'Keep the bass low in the mix', source: 'explicit' },
      host,
    );
    expect(first.result.success).toBe(true);
    expect(first.result.stdout).toContain('[mix] Keep the bass low in the mix (explicit)');

    const listed = await exec({ op: 'list' }, host);
    expect(listed.result.stdout).toContain('1. [mix] Keep the bass low in the mix');
  });

  it('update and remove address entries by 1-based index', async () => {
    const host = makeHost();
    await exec({ op: 'add', category: 'fx', text: 'Light reverb only', source: 'inferred' }, host);
    await exec({ op: 'add', category: 'density', text: 'Sparse hats', source: 'explicit' }, host);

    const updated = await exec({ op: 'update', index: 1, text: 'Reverb at most 20% wet' }, host);
    expect(updated.result.stdout).toContain('1. [fx] Reverb at most 20% wet');

    const removed = await exec({ op: 'remove', index: 2 }, host);
    expect(removed.result.stdout).not.toContain('Sparse hats');
  });

  it('rejects bad categories, empty text, and out-of-range indices', async () => {
    const host = makeHost();
    const badCat = await exec({ op: 'add', category: 'vibes', text: 'x', source: 'explicit' }, host);
    expect(badCat.result.success).toBe(false);
    const noText = await exec({ op: 'add', category: 'mix', text: '  ', source: 'explicit' }, host);
    expect(noText.result.success).toBe(false);
    const badIdx = await exec({ op: 'remove', index: 5 }, host);
    expect(badIdx.result.success).toBe(false);
  });

  it('evicts inferred-first (oldest-first) at the cap; explicit survive', () => {
    const prefs = [
      ...Array.from({ length: 20 }, (_, i) => ({
        category: 'mix' as const,
        text: `explicit ${i}`,
        source: 'explicit' as const,
      })),
      ...Array.from({ length: 15 }, (_, i) => ({
        category: 'fx' as const,
        text: `inferred ${i}`,
        source: 'inferred' as const,
      })),
    ];
    const evicted = evictPreferences(prefs);
    expect(evicted).toHaveLength(30);
    // 5 evictions, all from the inferred class, oldest first.
    expect(evicted.filter((p) => p.source === 'explicit')).toHaveLength(20);
    expect(evicted.find((p) => p.text === 'inferred 0')).toBeUndefined();
    expect(evicted.find((p) => p.text === 'inferred 4')).toBeUndefined();
    expect(evicted.find((p) => p.text === 'inferred 5')).toBeDefined();
  });
});
