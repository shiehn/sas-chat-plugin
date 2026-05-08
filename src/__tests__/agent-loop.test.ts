/**
 * Tests for AgentLoop — drives the model ↔ tool ↔ tool-response cycle.
 *
 * The host's `generateWithLLMTools` is mocked to return scripted responses
 * for each turn. We verify:
 *   - text-only response → loop exits with text
 *   - tool call → executor invoked → tool response fed back → next turn
 *   - iteration cap hit → graceful exit with cap message
 *   - synthetic failure on executor exception
 *   - reset() clears history
 *   - events emitted in order
 */

import { AgentLoop, type AgentLoopEvent, type ToolExecutor } from '../agent-loop';
import type { LLMTool, LLMToolUseResponse } from '@signalsandsorcery/plugin-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string): LLMToolUseResponse {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: 'STOP',
        index: 0,
      },
    ],
  };
}

function toolCallResponse(
  name: string,
  args: Record<string, unknown>
): LLMToolUseResponse {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name, args } }],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
  };
}

interface ScriptedHost {
  generateWithLLMTools: jest.Mock<Promise<LLMToolUseResponse>, [unknown]>;
}

function makeScriptedHost(responses: LLMToolUseResponse[]): ScriptedHost {
  const mock = jest.fn<Promise<LLMToolUseResponse>, [unknown]>();
  for (const r of responses) {
    mock.mockResolvedValueOnce(r);
  }
  // After the script runs out, return a terminal text response
  mock.mockResolvedValue(textResponse('done'));
  return { generateWithLLMTools: mock };
}

const TOOLS: LLMTool[] = [
  {
    functionDeclarations: [
      {
        name: 'scene_get_tracks',
        description: 'List tracks in active scene',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'set_volume',
        description: 'Set track volume',
        parameters: {
          type: 'object',
          properties: {
            trackId: { type: 'string' },
            volume: { type: 'number' },
          },
          required: ['trackId', 'volume'],
        },
      },
    ],
  },
];

const SYSTEM_PROMPT = 'You are a test agent.';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop', () => {
  it('returns the model text on a single-turn response', async () => {
    const host = makeScriptedHost([textResponse('Hello!')]);
    const executor: ToolExecutor = jest.fn();
    const events: AgentLoopEvent[] = [];

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      onEvent: (e) => events.push(e),
    });

    const result = await loop.run('hi');

    expect(result.text).toBe('Hello!');
    expect(result.iterations).toBe(1);
    expect(result.iterationLimitHit).toBe(false);
    expect(executor).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['final_text']);
  });

  it('dispatches tool calls and feeds responses back into the loop', async () => {
    const host = makeScriptedHost([
      toolCallResponse('scene_get_tracks', {}),
      textResponse('There are 2 tracks.'),
    ]);
    const executor: ToolExecutor = jest.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: JSON.stringify({ tracks: ['drum', 'bass'] }),
      stderr: '',
    });
    const events: AgentLoopEvent[] = [];

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      onEvent: (e) => events.push(e),
    });

    const result = await loop.run('list tracks');

    expect(result.text).toBe('There are 2 tracks.');
    expect(result.iterations).toBe(2);
    expect(executor).toHaveBeenCalledWith('scene_get_tracks', {});

    // Event sequence: start → done → final_text
    expect(events.map((e) => e.type)).toEqual([
      'tool_call_start',
      'tool_call_done',
      'final_text',
    ]);

    // Verify the second LLM call carried the functionResponse part
    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: Array<{ role: string; parts: Array<{ functionResponse?: unknown }> }>;
    };
    const lastContent = secondCall.contents[secondCall.contents.length - 1];
    expect(lastContent.role).toBe('user');
    expect(lastContent.parts[0]).toHaveProperty('functionResponse');
  });

  it('feeds executor exceptions back as synthetic failures (loop continues)', async () => {
    const host = makeScriptedHost([
      toolCallResponse('set_volume', { trackId: 'x', volume: 0.5 }),
      textResponse('Got it.'),
    ]);
    const executor: ToolExecutor = jest
      .fn()
      .mockRejectedValueOnce(new Error('subprocess died'));
    const events: AgentLoopEvent[] = [];

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      onEvent: (e) => events.push(e),
    });

    const result = await loop.run('turn it down');

    expect(result.text).toBe('Got it.');

    const doneEvent = events.find((e) => e.type === 'tool_call_done');
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === 'tool_call_done') {
      expect(doneEvent.result.success).toBe(false);
      expect(doneEvent.result.stderr).toContain('subprocess died');
    }
  });

  it('stops at maxIterations with a cap message', async () => {
    const host = makeScriptedHost([
      toolCallResponse('scene_get_tracks', {}),
      toolCallResponse('scene_get_tracks', {}),
      toolCallResponse('scene_get_tracks', {}),
    ]);
    const executor: ToolExecutor = jest.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '{}',
      stderr: '',
    });
    const events: AgentLoopEvent[] = [];

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      maxIterations: 3,
      onEvent: (e) => events.push(e),
    });

    const result = await loop.run('go');

    expect(result.iterationLimitHit).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.text).toMatch(/iteration limit/i);

    const limitEvent = events.find((e) => e.type === 'iteration_limit');
    expect(limitEvent).toBeDefined();
  });

  it('passes systemInstruction and tools to host.generateWithLLMTools', async () => {
    const host = makeScriptedHost([textResponse('ok')]);
    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: jest.fn(),
      systemPrompt: SYSTEM_PROMPT,
    });

    await loop.run('hello');

    const call = host.generateWithLLMTools.mock.calls[0][0] as {
      systemInstruction?: { parts: { text: string }[] };
      tools?: LLMTool[];
      contents: { role: string; parts: { text?: string }[] }[];
    };
    expect(call.systemInstruction?.parts[0].text).toBe(SYSTEM_PROMPT);
    expect(call.tools).toEqual(TOOLS);
    expect(call.contents[0].role).toBe('user');
    expect(call.contents[0].parts[0].text).toBe('hello');
  });

  it('emits unique callIds for each tool call within a turn', async () => {
    const host = makeScriptedHost([
      // Two function calls in one turn
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { name: 'scene_get_tracks', args: {} } },
                { functionCall: { name: 'set_volume', args: { trackId: 'a', volume: 1 } } },
              ],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      },
      textResponse('done'),
    ]);
    const executor: ToolExecutor = jest.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '{}',
      stderr: '',
    });
    const events: AgentLoopEvent[] = [];

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      onEvent: (e) => events.push(e),
    });

    await loop.run('do two things');

    const startEvents = events.filter((e) => e.type === 'tool_call_start');
    expect(startEvents).toHaveLength(2);
    if (
      startEvents[0].type === 'tool_call_start' &&
      startEvents[1].type === 'tool_call_start'
    ) {
      expect(startEvents[0].callId).not.toBe(startEvents[1].callId);
    }
  });

  it('reset() clears history so subsequent runs start fresh', async () => {
    const host = makeScriptedHost([
      textResponse('first'),
      textResponse('second'),
    ]);

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: jest.fn(),
      systemPrompt: SYSTEM_PROMPT,
    });

    await loop.run('one');
    loop.reset();
    await loop.run('two');

    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: { role: string; parts: { text?: string }[] }[];
    };
    // After reset, history should only contain the new user message
    expect(secondCall.contents).toHaveLength(1);
    expect(secondCall.contents[0].parts[0].text).toBe('two');
  });

  it('preserves history across runs when reset() is not called', async () => {
    const host = makeScriptedHost([
      textResponse('first'),
      textResponse('second'),
    ]);

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: jest.fn(),
      systemPrompt: SYSTEM_PROMPT,
    });

    await loop.run('one');
    await loop.run('two');

    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: { role: string; parts: { text?: string }[] }[];
    };
    // Should have: user('one'), model('first'), user('two')
    expect(secondCall.contents).toHaveLength(3);
    expect(secondCall.contents[0].parts[0].text).toBe('one');
    expect(secondCall.contents[2].parts[0].text).toBe('two');
  });
});
