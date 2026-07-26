/**
 * historyToEntries — persisted LLMContent[] → TerminalEntry[] for restart
 * hydration. Persisted state is untrusted; malformed entries must skip,
 * never break the panel.
 */

import { describe, it, expect } from '@jest/globals';
import { historyToEntries } from '../history-hydration';
import type { LLMContent } from '@signalsandsorcery/plugin-sdk';

const user = (text: string): LLMContent => ({ role: 'user', parts: [{ text }] });
const modelText = (text: string): LLMContent => ({ role: 'model', parts: [{ text }] });
const modelCalls = (
  ...calls: Array<{ name: string; args?: Record<string, unknown> }>
): LLMContent => ({
  role: 'model',
  parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } })),
});
const responses = (
  ...rs: Array<{ name: string; success: boolean; stdout?: string; stderr?: string }>
): LLMContent => ({
  role: 'user',
  parts: rs.map((r) => ({
    functionResponse: {
      name: r.name,
      response: { success: r.success, exitCode: r.success ? 0 : 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' },
    },
  })),
});

describe('historyToEntries', () => {
  it('maps a plain text exchange to user + assistant rows', () => {
    const { entries, maxTurnId } = historyToEntries([user('hello'), modelText('hi there')]);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant']);
    expect(entries[0]).toMatchObject({ turnId: 1, text: 'hello' });
    expect(entries[1]).toMatchObject({ turnId: 1, text: 'hi there', toolCount: 0, collapsed: false });
    expect(maxTurnId).toBe(1);
  });

  it('pairs functionCalls with the following functionResponse turn, positionally', () => {
    const { entries } = historyToEntries([
      user('set tempo and mute bass'),
      modelCalls({ name: 'dsl_set_tempo', args: { bpm: 128 } }, { name: 'dsl_track_mute' }),
      responses(
        { name: 'dsl_set_tempo', success: true, stdout: '{"success":true}' },
        { name: 'dsl_track_mute', success: false, stderr: 'no track' },
      ),
      modelText('Done — tempo set; muting failed.'),
    ]);
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toEqual(['user', 'tool_done', 'tool_done', 'assistant']);
    expect(entries[1]).toMatchObject({
      tool: 'dsl_set_tempo',
      params: { bpm: 128 },
      result: '{"success":true}',
      error: undefined,
    });
    expect(entries[2]).toMatchObject({ tool: 'dsl_track_mute', error: 'no track' });
    // functionResponse turn itself never renders standalone; the assistant
    // summary carries the whole turn's tool count and starts collapsed.
    expect(entries[3]).toMatchObject({ toolCount: 2, collapsed: true, turnId: 1 });
  });

  it('accumulates toolCount across multiple model turns of the same user turn', () => {
    const { entries } = historyToEntries([
      user('do three things'),
      modelCalls({ name: 'a_tool' }),
      responses({ name: 'a_tool', success: true }),
      modelCalls({ name: 'b_tool' }, { name: 'c_tool' }),
      responses({ name: 'b_tool', success: true }, { name: 'c_tool', success: true }),
      modelText('all done'),
    ]);
    const assistant = entries.find((e) => e.kind === 'assistant');
    expect(assistant).toMatchObject({ toolCount: 3, collapsed: true, turnId: 1 });
    expect(entries.filter((e) => e.kind === 'tool_done')).toHaveLength(3);
  });

  it('maps ask_user pairs to clarification_resolved (not tool rows)', () => {
    const { entries } = historyToEntries([
      user('add reverb to the bass'),
      modelCalls({ name: 'ask_user', args: { question: 'Which bass?', options: ['A', 'B'] } }),
      responses({ name: 'ask_user', success: true, stdout: 'A' }),
      modelText('Added to A.'),
    ]);
    const clar = entries.find((e) => e.kind === 'clarification_resolved');
    expect(clar).toMatchObject({ question: 'Which bass?', response: 'A' });
    const assistant = entries.find((e) => e.kind === 'assistant');
    // ask_user is not a tool row — no collapse group for a pure clarification turn.
    expect(assistant).toMatchObject({ toolCount: 0, collapsed: false });
  });

  it('renders a functionCall with no recorded response as a tool_done with an explanatory error', () => {
    const { entries } = historyToEntries([
      user('render it'),
      modelCalls({ name: 'compose_scene' }),
      // session died here — no functionResponse turn was recorded
    ]);
    const tool = entries.find((e) => e.kind === 'tool_done');
    expect(tool).toMatchObject({ tool: 'compose_scene' });
    expect((tool as { error?: string }).error).toMatch(/ended mid-turn/);
  });

  it('turn numbering increments only on real user messages; maxTurnId seeds the live counter', () => {
    const { entries, maxTurnId } = historyToEntries([
      user('one'),
      modelText('1'),
      user('two'),
      modelCalls({ name: 'x_tool' }),
      responses({ name: 'x_tool', success: true }),
      modelText('2'),
    ]);
    expect(entries.filter((e) => e.kind === 'user').map((e) => e.turnId)).toEqual([1, 2]);
    expect(maxTurnId).toBe(2);
  });

  it('skips malformed entries without throwing and survives garbage input', () => {
    const garbage = [
      null,
      42,
      { role: 'user' }, // no parts
      { role: 'model', parts: 'nope' },
      { role: 'alien', parts: [{ text: 'zzz' }] },
      user('still works'),
      modelText('yes'),
    ] as unknown as LLMContent[];
    const { entries } = historyToEntries(garbage);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant']);
    expect(historyToEntries(undefined as unknown as LLMContent[]).entries).toEqual([]);
  });

  it('renders compaction summaries and stop-acks transparently as ordinary rows', () => {
    const { entries } = historyToEntries([
      user('[Conversation summary — 40 earlier entries compacted. Treat this as ground truth:]\n- made a scene'),
      modelText('Understood — continuing from that summary.'),
      user('go on'),
      modelText('(Stopped by user.)'),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect((entries[0] as { text: string }).text).toContain('Conversation summary');
  });
});
