/**
 * Iteration budget — structural continue-confirmation (Phase 2c).
 *
 * At the cap the loop asks the user (via the ask_user transport in the
 * executor) whether to keep going. Approval grants ITERATION_EXTENSION_STEP
 * more iterations; max MAX_ITERATION_EXTENSIONS approvals; absolute
 * HARD_ITERATION_CEILING. Decline / missing transport / executor throw all
 * fall back to the historical iteration_limit path.
 */

import {
  AgentLoop,
  isAffirmativeContinue,
  ITERATION_EXTENSION_STEP,
  MAX_ITERATION_EXTENSIONS,
} from '../agent-loop';
import type { AgentLoopEvent, ToolExecutor } from '../agent-loop';
import type { AgentBackend } from '../backend';
import type { LLMToolUseResponse, PluginHost } from '@signalsandsorcery/plugin-sdk';
import { ASK_USER_TOOL_NAME } from '../constants';

const host = {} as PluginHost;

/** Backend that ALWAYS asks for another tool call — never terminates. */
function endlessToolBackend(): AgentBackend {
  const response: LLMToolUseResponse = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'busy_tool', args: {} } }] as never,
        },
      },
    ],
  };
  return {
    name: 'fake',
    defaultModel: 'fake-pro',
    compactionModel: 'fake-flash',
    capabilities: { preservesThoughtSignatures: true, requiresStringEnums: true },
    complete: jest.fn(async () => response),
  };
}

function makeExecutor(
  askUserReplies: Array<{ success: boolean; stdout: string }>,
): { executor: ToolExecutor; askUserCalls: Array<Record<string, unknown>> } {
  const askUserCalls: Array<Record<string, unknown>> = [];
  const replies = [...askUserReplies];
  const executor: ToolExecutor = async (name, args) => {
    if (name === ASK_USER_TOOL_NAME) {
      askUserCalls.push(args);
      const reply = replies.shift() ?? { success: false, stdout: '' };
      return {
        success: reply.success,
        exitCode: reply.success ? 0 : 1,
        stdout: reply.stdout,
        stderr: reply.success ? '' : 'ask_user unavailable',
      };
    }
    return { success: true, exitCode: 0, stdout: '{}', stderr: '' };
  };
  return { executor, askUserCalls };
}

function runLoop(
  maxIterations: number,
  askUserReplies: Array<{ success: boolean; stdout: string }>,
): Promise<{
  result: Awaited<ReturnType<AgentLoop['run']>>;
  events: AgentLoopEvent[];
  askUserCalls: Array<Record<string, unknown>>;
}> {
  const { executor, askUserCalls } = makeExecutor(askUserReplies);
  const loop = new AgentLoop({
    host,
    backend: endlessToolBackend(),
    tools: [],
    toolExecutor: executor,
    systemPrompt: 'sys',
    maxIterations,
  });
  const events: AgentLoopEvent[] = [];
  return loop
    .run('endless task', (e) => events.push(e))
    .then((result) => ({ result, events, askUserCalls }));
}

describe('isAffirmativeContinue', () => {
  it.each([
    ['Keep going', true],
    ['keep going!', true],
    ['yes', true],
    ['Continue', true],
    ['go ahead', true],
    ['Stop and summarize', false],
    ['no', false],
    ['', false],
    ['stop', false],
  ])('%s → %s', (reply, expected) => {
    expect(isAffirmativeContinue(reply)).toBe(expected);
  });
});

describe('continue-confirmation at the iteration cap', () => {
  it('decline stops at the base cap with iteration_limit', async () => {
    const { result, events, askUserCalls } = await runLoop(3, [
      { success: true, stdout: 'Stop and summarize' },
    ]);
    expect(result.iterationLimitHit).toBe(true);
    expect(result.iterations).toBe(3);
    expect(askUserCalls).toHaveLength(1);
    expect(String(askUserCalls[0].question)).toContain('step budget');
    expect(events.some((e) => e.type === 'iterations_extended')).toBe(false);
    expect(events.some((e) => e.type === 'iteration_limit')).toBe(true);
  });

  it('missing ask_user transport (structured failure) stops at the base cap', async () => {
    const { result, events } = await runLoop(3, [{ success: false, stdout: '' }]);
    expect(result.iterationLimitHit).toBe(true);
    expect(result.iterations).toBe(3);
    expect(events.some((e) => e.type === 'iterations_extended')).toBe(false);
  });

  it('approval extends the budget by ITERATION_EXTENSION_STEP', async () => {
    const { result, events, askUserCalls } = await runLoop(3, [
      { success: true, stdout: 'Keep going' },
      { success: true, stdout: 'Stop and summarize' },
    ]);
    expect(result.iterations).toBe(3 + ITERATION_EXTENSION_STEP);
    expect(result.iterationLimitHit).toBe(true);
    expect(askUserCalls).toHaveLength(2);
    const extended = events.filter((e) => e.type === 'iterations_extended');
    expect(extended).toHaveLength(1);
    expect(extended[0]).toMatchObject({ newLimit: 3 + ITERATION_EXTENSION_STEP });
  });

  it('caps the number of extensions at MAX_ITERATION_EXTENSIONS', async () => {
    const approvals = Array.from({ length: 10 }, () => ({
      success: true,
      stdout: 'Keep going',
    }));
    const { result, events, askUserCalls } = await runLoop(2, approvals);
    // 2 base + 3 × 15 = 47; the 4th ask never happens.
    expect(askUserCalls).toHaveLength(MAX_ITERATION_EXTENSIONS);
    expect(result.iterations).toBe(2 + MAX_ITERATION_EXTENSIONS * ITERATION_EXTENSION_STEP);
    expect(result.iterationLimitHit).toBe(true);
    expect(events.filter((e) => e.type === 'iterations_extended')).toHaveLength(
      MAX_ITERATION_EXTENSIONS,
    );
  });

  it('an executor that throws on ask_user counts as a decline', async () => {
    const executor: ToolExecutor = async (name) => {
      if (name === ASK_USER_TOOL_NAME) throw new Error('transport gone');
      return { success: true, exitCode: 0, stdout: '{}', stderr: '' };
    };
    const loop = new AgentLoop({
      host,
      backend: endlessToolBackend(),
      tools: [],
      toolExecutor: executor,
      systemPrompt: 'sys',
      maxIterations: 2,
    });
    const result = await loop.run('endless');
    expect(result.iterationLimitHit).toBe(true);
    expect(result.iterations).toBe(2);
  });
});
