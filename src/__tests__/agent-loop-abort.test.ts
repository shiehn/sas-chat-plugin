/**
 * Abort semantics for AgentLoop (stop button / turn budget / bridge unstick).
 *
 * The load-bearing invariant in every case: after an abort, `contents` must
 * be a provider-valid conversation — every functionCall part answered by a
 * functionResponse part, strict user/model alternation, turn closed with a
 * model ack — so the NEXT run can proceed without tripping Gemini's
 * "function response turn comes immediately after a function call turn"
 * rejection.
 */

import { describe, it, expect } from '@jest/globals';
import {
  AgentLoop,
  type AgentLoopEvent,
  type ToolExecutionResult,
} from '../agent-loop';
import type { AgentBackend } from '../backend';
import type {
  LLMContent,
  LLMToolUseRequest,
  LLMToolUseResponse,
  PluginHost,
} from '@signalsandsorcery/plugin-sdk';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const host = {} as PluginHost; // never touched when a backend is injected

function textResponse(text: string): LLMToolUseResponse {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
  } as unknown as LLMToolUseResponse;
}

function toolCallResponse(
  calls: Array<{ name: string; args?: Record<string, unknown> }>,
): LLMToolUseResponse {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } })),
        },
      },
    ],
  } as unknown as LLMToolUseResponse;
}

/** Backend whose complete() resolutions are hand-controlled per call. */
class ScriptedBackend implements AgentBackend {
  readonly name = 'scripted';
  readonly defaultModel = 'scripted-model';
  readonly compactionModel = 'scripted-compact';
  readonly capabilities = {
    preservesThoughtSignatures: false,
    requiresStringEnums: false,
  };
  readonly requests: LLMToolUseRequest[] = [];
  private readonly script: Array<() => Promise<LLMToolUseResponse>>;

  constructor(script: Array<() => Promise<LLMToolUseResponse>>) {
    this.script = script;
  }

  complete(request: LLMToolUseRequest): Promise<LLMToolUseResponse> {
    this.requests.push(request);
    const step = this.script.shift();
    if (!step) return Promise.resolve(textResponse('done'));
    return step();
  }
}

const okResult: ToolExecutionResult = {
  success: true,
  exitCode: 0,
  stdout: '{"success":true}',
  stderr: '',
};

function hangForever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** Assert strict user/model alternation and full functionCall coverage. */
function assertProviderValid(contents: LLMContent[]): void {
  for (let i = 1; i < contents.length; i++) {
    expect(contents[i].role).not.toBe(contents[i - 1].role);
  }
  for (let i = 0; i < contents.length; i++) {
    const calls = (contents[i].parts ?? []).filter(
      (p) => (p as { functionCall?: unknown }).functionCall !== undefined,
    ).length;
    if (calls > 0) {
      const next = contents[i + 1];
      expect(next).toBeDefined();
      const responses = (next.parts ?? []).filter(
        (p) => (p as { functionResponse?: unknown }).functionResponse !== undefined,
      ).length;
      expect(responses).toBe(calls);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop.abort', () => {
  it('abort while the provider is thinking → aborted result, valid history, next run works', async () => {
    const backend = new ScriptedBackend([
      () => hangForever<LLMToolUseResponse>(),
      () => Promise.resolve(textResponse('second turn ok')),
    ]);
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: async () => okResult,
      systemPrompt: 'test',
    });

    const events: AgentLoopEvent[] = [];
    const runPromise = loop.run('do something slow', (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10)); // let the backend call start
    loop.abort('user');
    const result = await runPromise;

    expect(result.aborted).toBe('user');
    expect(result.iterationLimitHit).toBe(false);
    expect(result.text).toMatch(/Stopped/);
    expect(events.some((e) => e.type === 'aborted')).toBe(true);
    // llm_call_start/end stay paired so the UI clears its thinking row.
    expect(events.filter((e) => e.type === 'llm_call_start').length).toBe(
      events.filter((e) => e.type === 'llm_call_end').length,
    );
    const contents = loop.getHistorySnapshot();
    // [user, model-ack] — the hung provider call recorded no model turn.
    expect(contents).toHaveLength(2);
    expect(contents[1].role).toBe('model');
    assertProviderValid(contents);

    // The next turn proceeds normally on top of the closed history.
    const second = await loop.run('and now?');
    expect(second.aborted).toBeUndefined();
    expect(second.text).toBe('second turn ok');
    assertProviderValid(loop.getHistorySnapshot());
  });

  it('abort mid-tool-batch → synthetic responses for EVERY functionCall, in-flight call closed in the UI', async () => {
    const backend = new ScriptedBackend([
      () =>
        Promise.resolve(
          toolCallResponse([
            { name: 'slow_tool', args: { a: 1 } },
            { name: 'never_started_tool' },
          ]),
        ),
    ]);
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: (name) =>
        name === 'slow_tool' ? hangForever<ToolExecutionResult>() : Promise.resolve(okResult),
      systemPrompt: 'test',
    });

    const events: AgentLoopEvent[] = [];
    const runPromise = loop.run('run two tools', (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10)); // reach the hanging tool
    loop.abort('user');
    const result = await runPromise;

    expect(result.aborted).toBe('user');
    // The in-flight call's UI row resolves with a structured stop failure…
    const done = events.filter(
      (e): e is Extract<AgentLoopEvent, { type: 'tool_call_done' }> =>
        e.type === 'tool_call_done',
    );
    expect(done).toHaveLength(1);
    expect(done[0].toolName).toBe('slow_tool');
    expect(done[0].result.success).toBe(false);
    expect(done[0].result.stderr).toMatch(/Stopped by the user/);
    // …and the never-started sibling gets NO start event (it never ran).
    const starts = events.filter(
      (e): e is Extract<AgentLoopEvent, { type: 'tool_call_start' }> =>
        e.type === 'tool_call_start',
    );
    expect(starts.map((s) => s.toolName)).toEqual(['slow_tool']);

    // History: [user, model(fc,fc), user(fr,fr), model-ack] — provider-valid.
    const contents = loop.getHistorySnapshot();
    expect(contents).toHaveLength(4);
    assertProviderValid(contents);
    const frs = (contents[2].parts ?? []).map(
      (p) => (p as { functionResponse: { name: string; response: { stderr: string } } }).functionResponse,
    );
    expect(frs.map((f) => f.name)).toEqual(['slow_tool', 'never_started_tool']);
    expect(frs[1].response.stderr).toMatch(/Skipped/);
  });

  it('abort when idle is a no-op and never poisons the next run', async () => {
    const backend = new ScriptedBackend([() => Promise.resolve(textResponse('fine'))]);
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: async () => okResult,
      systemPrompt: 'test',
    });
    loop.abort('user'); // idle — must not arm anything
    const result = await loop.run('hello');
    expect(result.aborted).toBeUndefined();
    expect(result.text).toBe('fine');
  });

  it('turn budget expiry aborts with reason=budget and says so', async () => {
    const backend = new ScriptedBackend([() => hangForever<LLMToolUseResponse>()]);
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: async () => okResult,
      systemPrompt: 'test',
      turnBudgetMs: 40,
    });
    const events: AgentLoopEvent[] = [];
    const result = await loop.run('slow thing', (e) => events.push(e));
    expect(result.aborted).toBe('budget');
    expect(result.text).toMatch(/time budget/);
    const abortedEvent = events.find(
      (e): e is Extract<AgentLoopEvent, { type: 'aborted' }> => e.type === 'aborted',
    );
    expect(abortedEvent?.reason).toBe('budget');
  });

  it('reset() requested mid-run still applies after an abort', async () => {
    const backend = new ScriptedBackend([() => hangForever<LLMToolUseResponse>()]);
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: async () => okResult,
      systemPrompt: 'test',
    });
    const runPromise = loop.run('slow');
    await new Promise((r) => setTimeout(r, 10));
    loop.reset(); // deferred — run in flight
    loop.abort('user');
    await runPromise;
    expect(loop.getHistorySnapshot()).toHaveLength(0);
  });

  it('abort during the continue-at-cap question reports a stop, not an iteration limit', async () => {
    // Two iterations of tool calls with maxIterations=1 → cap question fires.
    const backend = new ScriptedBackend([
      () => Promise.resolve(toolCallResponse([{ name: 'quick_tool' }])),
    ]);
    let loopRef: AgentLoop | null = null;
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      maxIterations: 1,
      toolExecutor: (name) => {
        if (name === 'ask_user') {
          // The cap question — stop while it's pending.
          setTimeout(() => loopRef?.abort('user'), 5);
          return hangForever<ToolExecutionResult>();
        }
        return Promise.resolve(okResult);
      },
      systemPrompt: 'test',
    });
    loopRef = loop;
    const result = await loop.run('cap me');
    expect(result.aborted).toBe('user');
    expect(result.iterationLimitHit).toBe(false);
    expect(result.text).toMatch(/Stopped/);
    assertProviderValid(loop.getHistorySnapshot());
  });
});
