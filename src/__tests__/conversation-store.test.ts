/**
 * ConversationStore — per-project persistence (Phase 2b).
 */

import {
  ConversationStore,
  CONVERSATION_KEY,
  CONVERSATION_SIZE_CAP_BYTES,
} from '../conversation-store';
import type { LLMContent, PluginHost } from '@signalsandsorcery/plugin-sdk';

function makeHost(): { host: PluginHost; data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const host = {
    getProjectData: jest.fn(async (key: string) => data.get(key) ?? null),
    setProjectData: jest.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
  } as unknown as PluginHost;
  return { host, data };
}

const contents: LLMContent[] = [
  { role: 'user', parts: [{ text: 'hello' }] },
  { role: 'model', parts: [{ text: 'hi' }] },
];

describe('ConversationStore', () => {
  it('round-trips a conversation', async () => {
    const { host } = makeHost();
    const store = new ConversationStore(host);
    await store.save({ projectId: 'p1', model: 'gemini-x', contents });
    const loaded = await store.load();
    expect(loaded?.version).toBe(1);
    expect(loaded?.projectId).toBe('p1');
    expect(loaded?.model).toBe('gemini-x');
    expect(loaded?.contents).toEqual(contents);
    expect(typeof loaded?.savedAt).toBe('number');
  });

  it('returns null when nothing is stored', async () => {
    const { host } = makeHost();
    await expect(new ConversationStore(host).load()).resolves.toBeNull();
  });

  it.each([
    ['wrong version', { version: 2, projectId: 'p', model: 'm', contents: [] }],
    ['missing contents', { version: 1, projectId: 'p', model: 'm' }],
    ['bad role', { version: 1, projectId: 'p', model: 'm', contents: [{ role: 'x', parts: [] }] }],
    ['parts not array', { version: 1, projectId: 'p', model: 'm', contents: [{ role: 'user', parts: 'no' }] }],
    ['not an object', 'garbage'],
  ])('rejects malformed payloads (%s)', async (_label, payload) => {
    const { host, data } = makeHost();
    data.set(CONVERSATION_KEY, payload);
    await expect(new ConversationStore(host).load()).resolves.toBeNull();
  });

  it('load() swallows storage errors', async () => {
    const host = {
      getProjectData: jest.fn(async () => {
        throw new Error('db locked');
      }),
      setProjectData: jest.fn(),
    } as unknown as PluginHost;
    await expect(new ConversationStore(host).load()).resolves.toBeNull();
  });

  it('clear() removes the stored conversation', async () => {
    const { host } = makeHost();
    const store = new ConversationStore(host);
    await store.save({ projectId: 'p1', model: 'm', contents });
    await store.clear();
    await expect(store.load()).resolves.toBeNull();
  });

  it('reports overCap for oversized payloads', async () => {
    const { host } = makeHost();
    const store = new ConversationStore(host);
    const fat: LLMContent[] = [
      { role: 'user', parts: [{ text: 'x'.repeat(CONVERSATION_SIZE_CAP_BYTES) }] },
    ];
    const result = await store.save({ projectId: 'p1', model: 'm', contents: fat });
    expect(result.overCap).toBe(true);
    expect(result.bytes).toBeGreaterThan(CONVERSATION_SIZE_CAP_BYTES);

    const small = await store.save({ projectId: 'p1', model: 'm', contents });
    expect(small.overCap).toBe(false);
  });
});
