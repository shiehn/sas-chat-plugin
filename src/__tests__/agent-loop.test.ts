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

import { AgentLoop, truncateForLLM, type AgentLoopEvent, type ToolExecutor, type ToolExecutionResult } from '../agent-loop';
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
    expect(events.map((e) => e.type)).toEqual([
      'llm_call_start',
      'llm_call_end',
      'final_text',
    ]);
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
    expect(executor).toHaveBeenCalledWith('scene_get_tracks', {}, expect.any(Function));

    // Event sequence: turn 1 wraps an llm call + the tool call,
    // turn 2 wraps a second llm call → final_text.
    expect(events.map((e) => e.type)).toEqual([
      'llm_call_start',
      'llm_call_end',
      'tool_call_start',
      'tool_call_done',
      'llm_call_start',
      'llm_call_end',
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

  it('emits next_steps after a successful tool call when result.nextSteps is populated', async () => {
    const host = makeScriptedHost([
      toolCallResponse('dsl_shuffle_preset', { track: 'Snare' }),
      textResponse('Done — try one of the suggestions.'),
    ]);
    const executor: ToolExecutor = jest.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '{"success":true}',
      stderr: '',
      nextSteps: [
        {
          description: 'Try a different snare preset',
          cli: 'sas dsl_shuffle_preset --track Snare',
          mcp: { tool: 'dsl_shuffle_preset', args: { track: 'Snare' } },
          priority: 'primary',
        },
        {
          description: 'Add an FX rack to this track',
          cli: 'sas dsl_set_track_fx --track Snare',
          priority: 'secondary',
        },
      ],
    } satisfies ToolExecutionResult);
    const events: AgentLoopEvent[] = [];

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      onEvent: (e) => events.push(e),
    });

    await loop.run('reshuffle the snare');

    // next_steps must land between tool_call_done and the next llm_call_start
    // so the UI can render buttons before the loop continues.
    const types = events.map((e) => e.type);
    const doneIdx = types.indexOf('tool_call_done');
    const stepsIdx = types.indexOf('next_steps');
    expect(stepsIdx).toBe(doneIdx + 1);

    const stepsEvent = events[stepsIdx];
    if (stepsEvent.type !== 'next_steps') throw new Error('wrong event type');
    expect(stepsEvent.toolName).toBe('dsl_shuffle_preset');
    expect(stepsEvent.steps).toHaveLength(2);
    expect(stepsEvent.steps[0].description).toBe('Try a different snare preset');
    expect(stepsEvent.steps[0].priority).toBe('primary');
    expect(stepsEvent.steps[1].cli).toBe('sas dsl_set_track_fx --track Snare');
  });

  it('does NOT emit next_steps when the tool call failed', async () => {
    const host = makeScriptedHost([
      toolCallResponse('dsl_shuffle_preset', { track: 'Nope' }),
      textResponse('couldnt find that track'),
    ]);
    // Failed result that still carries nextSteps (defensive — the executor
    // shouldn't, but the agent loop should not emit either way).
    const executor: ToolExecutor = jest.fn().mockResolvedValue({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'track_not_found',
      nextSteps: [
        { description: 'try a different track', cli: 'sas scene_get_tracks' },
      ],
    } satisfies ToolExecutionResult);
    const events: AgentLoopEvent[] = [];

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      onEvent: (e) => events.push(e),
    });

    await loop.run('shuffle nope');

    expect(events.some((e) => e.type === 'next_steps')).toBe(false);
  });

  it('does NOT emit next_steps when result.nextSteps is empty or absent', async () => {
    const host = makeScriptedHost([
      toolCallResponse('scene_get_tracks', {}),
      textResponse('ok'),
    ]);
    const executor: ToolExecutor = jest.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '{}',
      stderr: '',
      // nextSteps deliberately omitted
    } satisfies ToolExecutionResult);
    const events: AgentLoopEvent[] = [];

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      onEvent: (e) => events.push(e),
    });

    await loop.run('list tracks');

    expect(events.some((e) => e.type === 'next_steps')).toBe(false);
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

  it('forces role: model on assistant turns even when upstream omits it', async () => {
    // Simulate a malformed upstream response missing the role field. The
    // loop must default to 'model' so the next request still passes
    // Gemini's strict alternation check.
    const host = {
      generateWithLLMTools: jest.fn() as jest.Mock,
    };
    host.generateWithLLMTools
      .mockResolvedValueOnce({
        candidates: [
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content: { parts: [{ functionCall: { name: 'set_volume', args: {} } }] } as any,
          },
        ],
      })
      .mockResolvedValueOnce({
        candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] } }],
      });

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: jest.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      }) as ToolExecutor,
      systemPrompt: SYSTEM_PROMPT,
    });

    await loop.run('do it');

    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: { role: string }[];
    };
    // user('do it') → model(functionCall) → user(functionResponse)
    expect(secondCall.contents).toHaveLength(3);
    expect(secondCall.contents[1].role).toBe('model'); // <- normalized
    expect(secondCall.contents[2].role).toBe('user');
  });

  it('preserves Gemini-3 functionCall.thoughtSignature verbatim on the next turn', async () => {
    // Gemini-3 stamps a `thoughtSignature` on functionCall parts that MUST be
    // replayed exactly on the following turn or the API 400s. The loop copies
    // the model's parts by reference into history, so the field must survive
    // into the next request's `contents`.
    const SIGNATURE = 'thought-sig-abc123==';
    const host = {
      generateWithLLMTools: jest.fn() as jest.Mock,
    };
    host.generateWithLLMTools
      .mockResolvedValueOnce({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                { functionCall: { name: 'set_volume', args: {}, thoughtSignature: SIGNATURE } } as any,
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] } }],
      });

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: jest.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      }) as ToolExecutor,
      systemPrompt: SYSTEM_PROMPT,
    });

    await loop.run('quieter please');

    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: Array<{
        role: string;
        parts: Array<{ functionCall?: { thoughtSignature?: string } }>;
      }>;
    };
    // contents[1] is the model turn carrying the functionCall part.
    const fcPart = secondCall.contents[1].parts.find((p) => p.functionCall);
    expect(fcPart?.functionCall?.thoughtSignature).toBe(SIGNATURE);
  });

  it('recovers from a Gemini 400 "function response turn" error by resetting history and retrying once', async () => {
    // Long history accumulated from prior failed turns:
    // user → model(text) → user → model(fc) → user(fr) → model(text)
    // Then we kick off a fresh user turn ("create a beat...") and the
    // first request 400s. The loop should drop everything except the
    // most-recent user message and retry — and the retry succeeds.
    const shapeError = new Error(
      'LLM tool-use generation failed: Request failed: 400 - ' +
        '{"error":{"code":400,"message":"Please ensure that function ' +
        'response turn comes immediately after a function call turn."}}'
    );

    const host = {
      generateWithLLMTools: jest.fn() as jest.Mock,
    };
    host.generateWithLLMTools
      .mockRejectedValueOnce(shapeError)
      .mockResolvedValueOnce({
        candidates: [{ content: { role: 'model', parts: [{ text: 'fresh start' }] } }],
      });

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: jest.fn(),
      systemPrompt: SYSTEM_PROMPT,
    });

    // Seed the loop with a long, possibly-malformed history.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (loop as any).contents = [
      { role: 'user', parts: [{ text: 'old: make a beat' }] },
      { role: 'model', parts: [{ text: 'What scene name?' }] },
      { role: 'user', parts: [{ text: 'old: funky break' }] },
      { role: 'model', parts: [{ functionCall: { name: 'compose_scene', args: {} } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'compose_scene', response: { success: false } } }],
      },
      { role: 'model', parts: [{ text: "I'm sorry, I'm encountering..." }] },
    ];

    const result = await loop.run('create a beat with kick, snare, hat');

    expect(result.text).toBe('fresh start');
    // After retry: contents = [user('create a beat...'), model('fresh start')]
    // (the 6 stale turns were dropped on retry).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((loop as any).contents).toHaveLength(2);
    expect(host.generateWithLLMTools).toHaveBeenCalledTimes(2);

    // First request: full polluted history + new user msg = 7 entries.
    const firstCall = host.generateWithLLMTools.mock.calls[0][0] as {
      contents: unknown[];
    };
    expect(firstCall.contents).toHaveLength(7);
    // Second (retry) request: just the new user msg.
    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: { role: string; parts: { text?: string }[] }[];
    };
    expect(secondCall.contents).toHaveLength(1);
    expect(secondCall.contents[0].parts[0].text).toBe('create a beat with kick, snare, hat');
  });

  it('does not auto-retry shape errors past iteration 1 (avoids retry loops)', async () => {
    const shapeError = new Error(
      '400 - "function response turn comes immediately after function call turn"'
    );

    const host = {
      generateWithLLMTools: jest.fn() as jest.Mock,
    };
    // First send returns a tool call. After the tool runs, the second
    // send hits the shape error — at iteration 2, no retry. The error
    // should propagate to the caller.
    host.generateWithLLMTools
      .mockResolvedValueOnce({
        candidates: [
          { content: { role: 'model', parts: [{ functionCall: { name: 'set_volume', args: {} } }] } },
        ],
      })
      .mockRejectedValueOnce(shapeError);

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: jest.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      }) as ToolExecutor,
      systemPrompt: SYSTEM_PROMPT,
    });

    await expect(loop.run('do it')).rejects.toThrow(/function response/);
    expect(host.generateWithLLMTools).toHaveBeenCalledTimes(2);
  });

  it('truncates large stdout/stderr in functionResponse to keep context bounded', async () => {
    // 8 KB stdout — twice the 4_000-char cap.
    const bigStdout = 'A'.repeat(8_000);
    const host = makeScriptedHost([
      toolCallResponse('compose_scene', {}),
      textResponse('done'),
    ]);

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: jest.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: bigStdout,
        stderr: '',
      }) as ToolExecutor,
      systemPrompt: SYSTEM_PROMPT,
    });

    await loop.run('compose');

    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: Array<{
        parts: Array<{ functionResponse?: { response: { stdout: string } } }>;
      }>;
    };
    const fr = secondCall.contents[secondCall.contents.length - 1].parts[0].functionResponse;
    expect(fr).toBeDefined();
    const stdout = fr!.response.stdout;
    expect(stdout.length).toBeLessThan(bigStdout.length);
    expect(stdout).toMatch(/truncated/);
    // Head and tail should both be present (structure-preserving truncation).
    expect(stdout.startsWith('A')).toBe(true);
    expect(stdout.endsWith('A')).toBe(true);
  });

  it('defers reset() requests that arrive while a run is in flight (scene-change race)', async () => {
    /**
     * Regression test for a Gemini "function response turn comes immediately
     * after a function call turn" 400 observed in production on 2026-05-09.
     *
     * The chat-plugin's `onSceneChanged` calls `agent.reset()` on scene change.
     * Tool calls that activate a new scene (e.g. `compose_scene`) trip this
     * handler *while the AgentLoop is still inside* `await toolExecutor(...)`.
     * Without deferral, reset() empties `this.contents` mid-flight, so when
     * the tool finishes and run() pushes the user-funcResp turn, the loop's
     * iter 2 sends a single content `[user-funcResp]` with no preceding
     * `[user, model(toolCall)]` — exactly the shape Gemini rejects.
     *
     * The fix: reset() during a live run() defers to a finally{} block.
     * Concretely, this test simulates the race by calling reset() from
     * inside the toolExecutor callback (the same point where a real scene
     * change would fire).
     */
    const host = makeScriptedHost([
      toolCallResponse('compose_scene', { description: 'A simple beat' }),
      textResponse('Composed.'),
    ]);

    let loopRef: AgentLoop | null = null;
    const executor: ToolExecutor = jest.fn().mockImplementation(async () => {
      // Mid-flight reset — same shape as onSceneChanged firing during tool exec.
      loopRef!.reset();
      return {
        success: true,
        exitCode: 0,
        stdout: JSON.stringify({ success: true }),
        stderr: '',
      };
    });

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
    });
    loopRef = loop;

    const result = await loop.run('make a beat');
    expect(result.text).toBe('Composed.');
    expect(result.iterations).toBe(2);

    // Iter 2 must carry [user, model(toolCall), user(funcResp)] — three turns,
    // not just the lone funcResp. This is the exact symptom the bug produced.
    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: Array<{ role: string; parts: Array<{ text?: string; functionCall?: unknown; functionResponse?: unknown }> }>;
    };
    expect(secondCall.contents).toHaveLength(3);
    expect(secondCall.contents[0]).toMatchObject({
      role: 'user',
      parts: [{ text: 'make a beat' }],
    });
    expect(secondCall.contents[1].role).toBe('model');
    expect(secondCall.contents[1].parts[0]).toHaveProperty('functionCall');
    expect(secondCall.contents[2].role).toBe('user');
    expect(secondCall.contents[2].parts[0]).toHaveProperty('functionResponse');

    // After run() returns, the deferred reset has applied — next run() starts fresh.
    await loop.run('next request');
    const thirdCall = host.generateWithLLMTools.mock.calls[2][0] as {
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
    };
    expect(thirdCall.contents).toHaveLength(1);
    expect(thirdCall.contents[0].parts[0].text).toBe('next request');
  });

  it('defers reset() requests fired by the host-level onSceneChanged path', async () => {
    /**
     * Integration-style companion to the executor-triggered test above.
     * Models the actual production code path: the chat-plugin subscribes
     * to `host.on('sceneChange', ...)` and calls `agent.reset()` in the
     * handler. We simulate that wiring with a tiny event emitter so the
     * test exercises "tool fires → host broadcasts scene change → handler
     * reaches into AgentLoop.reset() while it's still awaiting" — same
     * shape as the real onSceneChanged plumbing.
     *
     * Covers C-8 in `docs/chat-cli-architecture.md`. The earlier test calls
     * `loop.reset()` directly; this test ensures the deferral also works
     * when reset arrives via the listener edge.
     */
    const sceneListeners: Array<() => void> = [];
    const emitSceneChange = (): void => {
      for (const l of sceneListeners) l();
    };

    const host = makeScriptedHost([
      toolCallResponse('compose_scene', { description: 'A simple beat' }),
      textResponse('Composed.'),
    ]);

    let loopRef: AgentLoop | null = null;
    const executor: ToolExecutor = jest.fn().mockImplementation(async () => {
      // Tool execution side-effect emits a scene change — listeners fire
      // synchronously and one of them calls reset().
      emitSceneChange();
      return {
        success: true,
        exitCode: 0,
        stdout: JSON.stringify({ success: true }),
        stderr: '',
      };
    });

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
    });
    loopRef = loop;
    sceneListeners.push(() => loopRef!.reset());

    const result = await loop.run('make a beat');
    expect(result.text).toBe('Composed.');
    expect(result.iterations).toBe(2);

    // Iter 2 must carry [user, model(toolCall), user(funcResp)] — same
    // shape the direct-reset case requires. The deferral guard makes this
    // path identical regardless of who called reset().
    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: Array<{ role: string; parts: unknown[] }>;
    };
    expect(secondCall.contents).toHaveLength(3);
    expect(secondCall.contents[0].role).toBe('user');
    expect(secondCall.contents[1].role).toBe('model');
    expect(secondCall.contents[2].role).toBe('user');
  });

  it('emits llm_call_start before generateWithLLMTools and llm_call_end after (success path)', async () => {
    const host = makeScriptedHost([textResponse('hi')]);
    const events: AgentLoopEvent[] = [];
    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: jest.fn(),
      systemPrompt: SYSTEM_PROMPT,
      onEvent: (e) => events.push(e),
    });

    await loop.run('hello');

    const types = events.map((e) => e.type);
    const startIdx = types.indexOf('llm_call_start');
    const endIdx = types.indexOf('llm_call_end');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    // both events report the same iteration number
    const startEvt = events[startIdx];
    const endEvt = events[endIdx];
    if (startEvt.type === 'llm_call_start' && endEvt.type === 'llm_call_end') {
      expect(startEvt.iteration).toBe(1);
      expect(endEvt.iteration).toBe(1);
    }
  });

  it('emits llm_call_end even when generateWithLLMTools throws', async () => {
    const boom = new Error('LLM unreachable');
    const host = {
      generateWithLLMTools: jest.fn().mockRejectedValue(boom) as jest.Mock,
    };
    const events: AgentLoopEvent[] = [];
    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: jest.fn(),
      systemPrompt: SYSTEM_PROMPT,
      onEvent: (e) => events.push(e),
    });

    await expect(loop.run('hi')).rejects.toThrow(/LLM unreachable/);
    const types = events.map((e) => e.type);
    expect(types).toContain('llm_call_start');
    expect(types).toContain('llm_call_end');
    // start must precede end even on the error path
    expect(types.indexOf('llm_call_end')).toBeGreaterThan(
      types.indexOf('llm_call_start')
    );
  });

  it('forwards executor onProgress as tool_progress events tagged with the live callId', async () => {
    const host = makeScriptedHost([
      toolCallResponse('compose_scene', {}),
      textResponse('done'),
    ]);
    // Capture progress chunks as the executor invokes them; respond synchronously.
    const executor: ToolExecutor = jest
      .fn()
      .mockImplementation(async (_name, _args, onProgress) => {
        onProgress?.({ stream: 'stdout', line: 'loading synth...' });
        onProgress?.({ stream: 'stderr', line: 'warning: slow disk' });
        onProgress?.({ stream: 'stdout', line: 'done' });
        return { success: true, exitCode: 0, stdout: '{}', stderr: '' };
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
    await loop.run('compose');

    const startEvt = events.find((e) => e.type === 'tool_call_start');
    const progress = events.filter((e) => e.type === 'tool_progress');
    expect(startEvt).toBeDefined();
    expect(progress).toHaveLength(3);
    if (startEvt && startEvt.type === 'tool_call_start') {
      for (const p of progress) {
        if (p.type === 'tool_progress') {
          expect(p.callId).toBe(startEvt.callId);
          expect(p.iteration).toBe(1);
        }
      }
    }
    const lines = progress.map((p) => (p.type === 'tool_progress' ? p.line : ''));
    expect(lines).toEqual(['loading synth...', 'warning: slow disk', 'done']);
    const streams = progress.map((p) => (p.type === 'tool_progress' ? p.stream : ''));
    expect(streams).toEqual(['stdout', 'stderr', 'stdout']);
  });

  it('completes a full ask_user round-trip without restarting the turn', async () => {
    /** Simulates the model calling `ask_user`, the executor returning the
     *  user's response as stdout, and the model continuing to a final text.
     *  This is the load-bearing test for the clarification feature: it
     *  proves the loop treats ask_user like any other tool — single turn,
     *  single user message, history threaded correctly. */
    const host = makeScriptedHost([
      // Iter 1: model calls ask_user.
      toolCallResponse('ask_user', {
        question: 'Which bass: track 2 or track 5?',
        options: ['track 2', 'track 5'],
      }),
      // Iter 2: model emits final text with the user's choice baked in.
      textResponse('Boosted track 2 with reverb.'),
    ]);

    // Executor pretends to be the chat plugin's ask_user routing — the
    // user replied "track 2".
    const executor: ToolExecutor = jest.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: 'track 2',
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

    const result = await loop.run('boost the bass with reverb');

    expect(result.text).toBe('Boosted track 2 with reverb.');
    expect(result.iterations).toBe(2);
    expect(executor).toHaveBeenCalledWith(
      'ask_user',
      { question: 'Which bass: track 2 or track 5?', options: ['track 2', 'track 5'] },
      expect.any(Function),
    );

    // The user's response must be threaded back in as a functionResponse so
    // the model has the answer when generating the final text.
    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: Array<{
        role: string;
        parts: Array<{ functionResponse?: { name: string; response: { stdout: string } } }>;
      }>;
    };
    const lastPart = secondCall.contents[secondCall.contents.length - 1].parts[0];
    expect(lastPart.functionResponse?.name).toBe('ask_user');
    expect(lastPart.functionResponse?.response.stdout).toBe('track 2');
  });

  it('feeds an executor rejection on ask_user back as a synthetic failure (loop continues)', async () => {
    /** Mirrors the cancellation path: the user closed the panel mid-question.
     *  The executor rejects, the loop wraps the rejection into a synthetic
     *  failure, and the model recovers in the next turn. */
    const host = makeScriptedHost([
      toolCallResponse('ask_user', { question: 'which one?' }),
      textResponse('Cancelled — let me know when you decide.'),
    ]);
    const executor: ToolExecutor = jest
      .fn()
      .mockRejectedValueOnce(new Error('Clarification cancelled'));

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
    });

    const result = await loop.run('do the thing');

    expect(result.text).toBe('Cancelled — let me know when you decide.');
    const secondCall = host.generateWithLLMTools.mock.calls[1][0] as {
      contents: Array<{
        parts: Array<{ functionResponse?: { response: { success: boolean; stderr: string } } }>;
      }>;
    };
    const fr = secondCall.contents[secondCall.contents.length - 1].parts[0].functionResponse;
    expect(fr?.response.success).toBe(false);
    expect(fr?.response.stderr).toContain('Clarification cancelled');
  });

  it('refuses concurrent run() calls', async () => {
    /** Defensive: if someone fires two run()s in parallel (UI guard bypassed),
     *  surface the violation instead of corrupting `this.contents`. */
    const host = makeScriptedHost([
      toolCallResponse('compose_scene', {}),
      textResponse('done'),
    ]);
    let resolveExecutor: (() => void) | undefined;
    const executor: ToolExecutor = jest.fn().mockImplementation(
      () =>
        new Promise<ToolExecutionResult>((resolve) => {
          resolveExecutor = () =>
            resolve({ success: true, exitCode: 0, stdout: '{}', stderr: '' });
        })
    );

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
    });

    const firstRun = loop.run('first');
    // Wait for the loop to enter the toolExecutor await.
    await new Promise((r) => setTimeout(r, 10));
    await expect(loop.run('second')).rejects.toThrow(/already in flight|previous run/);

    resolveExecutor!();
    await firstRun;
  });

  it('appends ambient context to systemInstruction when getAmbientContext is provided', async () => {
    const host = makeScriptedHost([textResponse('done')]);
    const executor: ToolExecutor = jest.fn();
    const ambient = '=== Current state ===\nProject: "Demo"\nActive scene: "Verse 1"\n=== End ===';

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      getAmbientContext: async () => ambient,
    });

    await loop.run('hello');

    const callArgs = host.generateWithLLMTools.mock.calls[0][0] as {
      systemInstruction: { parts: Array<{ text: string }> };
    };
    const sysText = callArgs.systemInstruction.parts[0].text;
    expect(sysText).toContain(SYSTEM_PROMPT);
    expect(sysText).toContain('Project: "Demo"');
    expect(sysText).toContain('Active scene: "Verse 1"');
  });

  it('proceeds without ambient context when the callback throws', async () => {
    const host = makeScriptedHost([textResponse('done')]);
    const executor: ToolExecutor = jest.fn();

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      getAmbientContext: async () => {
        throw new Error('inspect failed');
      },
    });

    const result = await loop.run('hello');
    expect(result.text).toBe('done');

    const callArgs = host.generateWithLLMTools.mock.calls[0][0] as {
      systemInstruction: { parts: Array<{ text: string }> };
    };
    expect(callArgs.systemInstruction.parts[0].text).toBe(SYSTEM_PROMPT);
  });

  it('reuses the same ambient context across iterations within one run', async () => {
    const host = makeScriptedHost([
      toolCallResponse('scene_get_tracks', {}),
      textResponse('done'),
    ]);
    const executor: ToolExecutor = jest.fn().mockResolvedValue({
      success: true, exitCode: 0, stdout: '{}', stderr: '',
    });
    let ambientCalls = 0;

    const loop = new AgentLoop({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
      tools: TOOLS,
      toolExecutor: executor,
      systemPrompt: SYSTEM_PROMPT,
      getAmbientContext: async () => {
        ambientCalls++;
        return '[ambient]';
      },
    });

    await loop.run('do it');

    expect(ambientCalls).toBe(1); // ONE call per run, not per iteration
    // But injected on every iteration's request:
    const calls = host.generateWithLLMTools.mock.calls;
    expect(calls.length).toBe(2);
    for (const c of calls) {
      const sys = (c[0] as { systemInstruction: { parts: Array<{ text: string }> } })
        .systemInstruction.parts[0].text;
      expect(sys).toContain('[ambient]');
    }
  });
});

describe('truncateForLLM', () => {
  it('passes through strings under the cap unchanged', () => {
    const small = 'x'.repeat(1000);
    expect(truncateForLLM(small)).toBe(small);
  });

  it('keeps both head and tail with a marker in between for non-JSON oversized strings', () => {
    const big = 'a'.repeat(2_400) + 'MIDDLE_MARKER'.repeat(200) + 'z'.repeat(1_200);
    const result = truncateForLLM(big);
    expect(result.length).toBeLessThan(big.length);
    expect(result).toMatch(/truncated/);
    expect(result.startsWith('a')).toBe(true);
    expect(result.endsWith('z')).toBe(true);
    expect(result.includes('MIDDLE_MARKER')).toBe(false);
  });

  it('preserves clarification + remediation envelopes even when the payload is huge', () => {
    // Build an OperationResult with a 4-option clarification AND a bulky
    // changes payload that pushes the whole thing well over the cap. The
    // agent MUST receive every clarification option so it can call ask_user.
    const candidates = [
      { id: 'scene-a1b2', name: 'Bass thing', displayName: 'Bass thing', genre: 'lofi', key: 'C', lengthBars: 4 },
      { id: 'scene-c3d4', name: 'Funky bass', displayName: 'Funky bass', genre: 'funk', key: 'F', lengthBars: 8 },
      { id: 'scene-e5f6', name: 'Bassline draft', displayName: 'Bassline draft', genre: 'house', key: 'A', lengthBars: 4 },
      { id: 'scene-g7h8', name: 'Sub bass', displayName: 'Sub bass', genre: 'dnb', key: 'D', lengthBars: 2 },
    ];
    const envelope = {
      success: false,
      action: 'play_scene',
      message: "Selector 'bass scene' matches 4 scenes",
      error: 'ambiguous_selector',
      remediation: {
        type: 'clarification_needed',
        reason: "'bass scene' matches 4 scenes",
        fix: 'Pick one with the resolved id and retry play_scene.',
      },
      clarification: {
        question: 'Which scene did you mean by "bass scene"?',
        context: '4 scenes match.',
        options: candidates.map((c) => ({ label: c.name, detail: `id=${c.id}`, value: c.id })),
      },
      changes: {
        availableScenes: candidates,
        // Bulk junk that pushes the payload way past LLM_OUTPUT_CAP. In real
        // life this might be the full project state snapshot.
        debugSnapshot: 'x'.repeat(8_000),
      },
    };
    const json = JSON.stringify(envelope);
    expect(json.length).toBeGreaterThan(4_000);

    const result = truncateForLLM(json);
    // The result must still be parseable JSON (envelope-aware path).
    const reparsed = JSON.parse(result);
    expect(reparsed.success).toBe(false);
    expect(reparsed.error).toBe('ambiguous_selector');
    expect(reparsed.remediation.type).toBe('clarification_needed');
    expect(reparsed.remediation.fix).toBeTruthy();
    expect(reparsed.clarification.question).toBe('Which scene did you mean by "bass scene"?');
    expect(reparsed.clarification.options).toHaveLength(4);
    // availableScenes preserved (4 items, all under MAX_CANDIDATE_ITEMS).
    expect(reparsed.changes.availableScenes).toHaveLength(4);
    expect(reparsed.changes.availableScenes[0].id).toBe('scene-a1b2');
  });

  it('trims bulky db_query rows with a "more rows" hint instead of head/tail-slicing JSON', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}`, name: `Track ${i}`, role: 'bass', volume: 0.7 }));
    const envelope = {
      success: true,
      action: 'db_query',
      message: 'Returned 100 rows',
      changes: { rows, rowCount: 100, columns: ['id', 'name', 'role', 'volume'], truncated: false },
    };
    const json = JSON.stringify(envelope);
    expect(json.length).toBeGreaterThan(4_000);

    const result = truncateForLLM(json);
    const reparsed = JSON.parse(result);
    expect(reparsed.success).toBe(true);
    // Last element should be the "more rows" sentinel.
    expect(reparsed.changes.rows.length).toBe(21); // 20 rows + sentinel
    expect(reparsed.changes.rows[20]).toMatch(/more rows/);
    expect(reparsed.changes.truncated).toBe(true);
  });

  it('trims overflowing candidate lists to MAX_CANDIDATE_ITEMS with a count summary', () => {
    // Pad each candidate so the JSON exceeds LLM_OUTPUT_CAP; otherwise we
    // wouldn't enter the truncation path at all.
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      id: `scene-${i.toString().padStart(8, '0')}`,
      name: `Scene ${i} ` + 'x'.repeat(80),
      displayName: `Scene ${i} ` + 'x'.repeat(80),
      genre: 'lofi',
      key: 'C',
      lengthBars: 4,
    }));
    const envelope = {
      success: false,
      action: 'play_scene',
      error: 'ambiguous_selector',
      remediation: { type: 'clarification_needed', reason: 'too many', fix: 'pick one' },
      clarification: { question: 'Which scene?', options: [] },
      changes: { availableScenes: candidates },
    };
    const json = JSON.stringify(envelope);
    expect(json.length).toBeGreaterThan(4_000);
    const result = truncateForLLM(json);
    const reparsed = JSON.parse(result);
    expect(reparsed.changes.availableScenes.length).toBe(13); // 12 candidates + sentinel
    expect(reparsed.changes.availableScenes[12]).toMatch(/\+18 more/);
  });

  it('falls back to head/tail when the JSON does not look like an OperationResult', () => {
    // Valid JSON but no `success` key — not an envelope. Should head/tail.
    const arr = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ deeply: 'nested', value: i })));
    expect(arr.length).toBeGreaterThan(4_000);
    const result = truncateForLLM(arr);
    expect(result).toMatch(/truncated/);
    // head + tail format includes the "[... N chars truncated ...]" marker
    expect(result.split('truncated').length).toBeGreaterThanOrEqual(2);
  });

  it('handles empty and malformed inputs without throwing', () => {
    expect(truncateForLLM('')).toBe('');
    expect(truncateForLLM('not json {{{')).toBe('not json {{{');
  });
});
