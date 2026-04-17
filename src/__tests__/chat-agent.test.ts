/**
 * ChatAgent tool-loop spec — TDD.
 *
 * The core loop: user message in → LLM reasons → (optional) tool calls →
 * observe results → (optional) more tool calls → final text response.
 *
 * Matches Section 15 of ai-orchestration-design.md, with reinforcement
 * injection from Section 23.7 (fresh scene state refreshed after every
 * mutating tool call).
 *
 * The LLM itself is mocked — the loop is fully deterministic given a
 * scripted sequence of LLM responses.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  ChatAgent,
  type ChatAgentEvent,
  type ChatAgentTool,
  type LLMCallFn,
  type LLMResponse,
} from '../chat-agent';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function textResponse(content: string): LLMResponse {
  return { type: 'text', content };
}

function toolResponse(
  calls: Array<{ id: string; name: string; parameters: Record<string, unknown> }>
): LLMResponse {
  return { type: 'tool_use', toolCalls: calls };
}

function makeTool(name: string, handler: ChatAgentTool['handler']): ChatAgentTool {
  return {
    name,
    description: `Description for ${name}`,
    parameters: { type: 'object', properties: {} },
    handler,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('ChatAgent', () => {
  let agent: ChatAgent;
  let llm: jest.MockedFunction<LLMCallFn>;
  let buildSceneContext: jest.MockedFunction<() => Promise<string>>;

  beforeEach(() => {
    llm = jest.fn<LLMCallFn>();
    buildSceneContext = jest.fn<() => Promise<string>>().mockResolvedValue('scene: Verse; bpm 90');
  });

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  describe('basic flow', () => {
    it('returns the LLM text directly when no tool calls are made', async () => {
      llm.mockResolvedValue(textResponse('I cannot do that in this scene.'));
      agent = new ChatAgent({ llm, tools: [], buildSceneContext });

      const result = await agent.handleUserMessage('hello');

      expect(result.text).toBe('I cannot do that in this scene.');
      expect(result.actions).toEqual([]);
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it('calls one tool then observes result and returns text', async () => {
      const tool = makeTool('get_tracks', async () => ({ tracks: ['Bass', 'Drums'] }));
      llm
        .mockResolvedValueOnce(
          toolResponse([{ id: 'c1', name: 'get_tracks', parameters: {} }])
        )
        .mockResolvedValueOnce(textResponse('Found Bass and Drums.'));

      agent = new ChatAgent({ llm, tools: [tool], buildSceneContext });

      const result = await agent.handleUserMessage('what tracks do I have?');

      expect(result.text).toBe('Found Bass and Drums.');
      expect(result.actions).toEqual([
        expect.objectContaining({ tool: 'get_tracks', params: {}, result: { tracks: ['Bass', 'Drums'] } }),
      ]);
      // LLM called twice: one to decide, one to respond after observing
      expect(llm).toHaveBeenCalledTimes(2);
    });

    it('handles multiple tool calls in a single LLM turn', async () => {
      const get = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ tracks: ['Bass'] });
      const setFx = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ enabled: true });

      llm
        .mockResolvedValueOnce(
          toolResponse([
            { id: 'c1', name: 'get_tracks', parameters: {} },
            { id: 'c2', name: 'set_fx', parameters: { track: 'Bass', category: 'reverb' } },
          ])
        )
        .mockResolvedValueOnce(textResponse('Added reverb to Bass.'));

      agent = new ChatAgent({
        llm,
        tools: [makeTool('get_tracks', get), makeTool('set_fx', setFx)],
        buildSceneContext,
      });

      const result = await agent.handleUserMessage('add reverb to bass');

      expect(result.text).toBe('Added reverb to Bass.');
      expect(get).toHaveBeenCalledTimes(1);
      expect(setFx).toHaveBeenCalledWith({ track: 'Bass', category: 'reverb' });
      expect(result.actions).toHaveLength(2);
    });

    it('runs multiple LLM turns in sequence (observe → call more tools → respond)', async () => {
      const get = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ tracks: ['Bass'] });
      const set = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ done: true });

      llm
        .mockResolvedValueOnce(toolResponse([{ id: 'c1', name: 'get_tracks', parameters: {} }]))
        .mockResolvedValueOnce(toolResponse([{ id: 'c2', name: 'set_fx', parameters: {} }]))
        .mockResolvedValueOnce(textResponse('Done.'));

      agent = new ChatAgent({
        llm,
        tools: [makeTool('get_tracks', get), makeTool('set_fx', set)],
        buildSceneContext,
      });

      const result = await agent.handleUserMessage('add reverb to bass');

      expect(result.text).toBe('Done.');
      expect(get).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledTimes(1);
      expect(llm).toHaveBeenCalledTimes(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown tools
  // ---------------------------------------------------------------------------

  describe('unknown tools', () => {
    it('reports "unknown tool" back to the LLM instead of crashing', async () => {
      llm
        .mockResolvedValueOnce(
          toolResponse([{ id: 'c1', name: 'no_such_tool', parameters: {} }])
        )
        .mockResolvedValueOnce(textResponse('I apologize; that tool is not available.'));

      agent = new ChatAgent({ llm, tools: [], buildSceneContext });

      const result = await agent.handleUserMessage('do something');

      expect(result.text).toContain('apologize');
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].error).toMatch(/unknown tool/i);
    });

    it('feeds the error back to the LLM so it can recover', async () => {
      const real = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ ok: true });

      llm
        .mockResolvedValueOnce(toolResponse([{ id: 'c1', name: 'wrong_name', parameters: {} }]))
        .mockResolvedValueOnce(toolResponse([{ id: 'c2', name: 'real_tool', parameters: {} }]))
        .mockResolvedValueOnce(textResponse('Recovered.'));

      agent = new ChatAgent({ llm, tools: [makeTool('real_tool', real)], buildSceneContext });

      const result = await agent.handleUserMessage('go');

      expect(real).toHaveBeenCalled();
      expect(result.text).toBe('Recovered.');
    });
  });

  // ---------------------------------------------------------------------------
  // Tool errors
  // ---------------------------------------------------------------------------

  describe('tool errors', () => {
    it('captures a thrown error in the action log and lets the LLM observe', async () => {
      const bad = jest.fn<ChatAgentTool['handler']>().mockRejectedValue(new Error('track not found'));

      llm
        .mockResolvedValueOnce(toolResponse([{ id: 'c1', name: 'bad', parameters: {} }]))
        .mockResolvedValueOnce(textResponse('That track does not exist. Try a different one.'));

      agent = new ChatAgent({ llm, tools: [makeTool('bad', bad)], buildSceneContext });

      const result = await agent.handleUserMessage('do it');

      expect(result.text).toContain('not exist');
      expect(result.actions[0].error).toContain('track not found');
    });
  });

  // ---------------------------------------------------------------------------
  // Max iterations
  // ---------------------------------------------------------------------------

  describe('max iterations', () => {
    it('stops at the configured MAX_ITERATIONS and returns what was done so far', async () => {
      const noop = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ ok: true });

      // LLM perpetually calls tools — never emits text. MAX_ITERATIONS guards it.
      llm.mockResolvedValue(
        toolResponse([{ id: 'c1', name: 'noop', parameters: {} }])
      );

      agent = new ChatAgent({
        llm,
        tools: [makeTool('noop', noop)],
        buildSceneContext,
        maxIterations: 3,
      });

      const result = await agent.handleUserMessage('go forever');

      expect(result.iterationLimitHit).toBe(true);
      expect(result.actions.length).toBeGreaterThanOrEqual(3);
      // Text response includes the action log hint (agent can continue)
      expect(result.text).toMatch(/iteration|limit|continue/i);
    });

    it('defaults MAX_ITERATIONS to 10 when not specified', async () => {
      const noop = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ ok: true });
      llm.mockResolvedValue(toolResponse([{ id: 'c1', name: 'noop', parameters: {} }]));

      agent = new ChatAgent({ llm, tools: [makeTool('noop', noop)], buildSceneContext });

      const result = await agent.handleUserMessage('go');
      expect(result.iterationLimitHit).toBe(true);
      expect(result.actions.length).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Reinforcement injection (Section 23.7)
  // ---------------------------------------------------------------------------

  describe('reinforcement injection — fresh scene context after every tool call', () => {
    it('rebuilds scene context ONCE at the start of a turn', async () => {
      llm.mockResolvedValue(textResponse('ok'));
      agent = new ChatAgent({ llm, tools: [], buildSceneContext });

      await agent.handleUserMessage('hello');
      expect(buildSceneContext).toHaveBeenCalledTimes(1);
    });

    it('rebuilds scene context AFTER a mutating tool call, before the next LLM call', async () => {
      const mutating = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ ok: true });

      llm
        .mockResolvedValueOnce(toolResponse([{ id: 'c1', name: 'mutating', parameters: {} }]))
        .mockResolvedValueOnce(textResponse('done'));

      agent = new ChatAgent({
        llm,
        tools: [{ ...makeTool('mutating', mutating), mutates: true }],
        buildSceneContext,
      });

      await agent.handleUserMessage('change something');
      // Twice: initial + after the mutating tool
      expect(buildSceneContext).toHaveBeenCalledTimes(2);
    });

    it('does NOT rebuild scene context after a read-only tool', async () => {
      const readOnly = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ data: 1 });

      llm
        .mockResolvedValueOnce(toolResponse([{ id: 'c1', name: 'read', parameters: {} }]))
        .mockResolvedValueOnce(textResponse('done'));

      agent = new ChatAgent({
        llm,
        tools: [{ ...makeTool('read', readOnly), mutates: false }],
        buildSceneContext,
      });

      await agent.handleUserMessage('query');
      // Once only — the initial pre-turn build
      expect(buildSceneContext).toHaveBeenCalledTimes(1);
    });

    it('injects the rebuilt scene context into the next LLM system prompt', async () => {
      const mutating = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ ok: true });
      buildSceneContext
        .mockResolvedValueOnce('scene snapshot 1')
        .mockResolvedValueOnce('scene snapshot 2 (after mutation)');

      llm
        .mockResolvedValueOnce(toolResponse([{ id: 'c1', name: 'mutating', parameters: {} }]))
        .mockResolvedValueOnce(textResponse('done'));

      agent = new ChatAgent({
        llm,
        tools: [{ ...makeTool('mutating', mutating), mutates: true }],
        buildSceneContext,
      });

      await agent.handleUserMessage('mutate');

      // Second LLM call received the refreshed context
      const secondCallArgs = llm.mock.calls[1][0];
      expect(secondCallArgs.system).toContain('scene snapshot 2');
    });
  });

  // ---------------------------------------------------------------------------
  // Conversation history
  // ---------------------------------------------------------------------------

  describe('conversation history', () => {
    it('includes prior turns in subsequent LLM calls', async () => {
      llm
        .mockResolvedValueOnce(textResponse('first response'))
        .mockResolvedValueOnce(textResponse('second response'));

      agent = new ChatAgent({ llm, tools: [], buildSceneContext });

      await agent.handleUserMessage('first question');
      await agent.handleUserMessage('second question');

      // Second LLM call should carry the full history
      const secondCall = llm.mock.calls[1][0];
      expect(secondCall.messages.map((m) => m.content).join(' ')).toContain('first question');
      expect(secondCall.messages.map((m) => m.content).join(' ')).toContain('first response');
      expect(secondCall.messages.map((m) => m.content).join(' ')).toContain('second question');
    });

    it('clearHistory() resets the conversation', async () => {
      llm.mockResolvedValue(textResponse('ok'));
      agent = new ChatAgent({ llm, tools: [], buildSceneContext });

      await agent.handleUserMessage('first');
      agent.clearHistory();
      await agent.handleUserMessage('second');

      const secondCall = llm.mock.calls[1][0];
      // After clearHistory, only the fresh user message remains
      expect(secondCall.messages.map((m) => m.content).join(' ')).not.toContain('first');
    });
  });

  // ---------------------------------------------------------------------------
  // Per-iteration event stream (for terminal UI)
  // ---------------------------------------------------------------------------

  describe('onEvent stream', () => {
    it('emits tool_call_start / tool_call_done / final_text in order', async () => {
      const tool = makeTool('get_tracks', async () => ({ tracks: ['Bass'] }));
      llm
        .mockResolvedValueOnce(
          toolResponse([{ id: 'c1', name: 'get_tracks', parameters: {} }])
        )
        .mockResolvedValueOnce(textResponse('Found Bass.'));

      agent = new ChatAgent({ llm, tools: [tool], buildSceneContext });
      const events: ChatAgentEvent[] = [];
      await agent.handleUserMessage('what tracks', (e) => events.push(e));

      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'tool_call_done',
        'final_text',
      ]);
      expect(events[0]).toMatchObject({
        type: 'tool_call_start',
        callId: 'c1',
        tool: 'get_tracks',
      });
      expect(events[1]).toMatchObject({
        type: 'tool_call_done',
        callId: 'c1',
        result: { tracks: ['Bass'] },
      });
      expect(events[2]).toMatchObject({
        type: 'final_text',
        content: 'Found Bass.',
      });
    });

    it('emits a tool_call_done with an error field when the tool throws', async () => {
      const bad = jest.fn<ChatAgentTool['handler']>().mockRejectedValue(new Error('boom'));
      llm
        .mockResolvedValueOnce(toolResponse([{ id: 'c1', name: 'bad', parameters: {} }]))
        .mockResolvedValueOnce(textResponse('ok'));

      agent = new ChatAgent({ llm, tools: [makeTool('bad', bad)], buildSceneContext });
      const events: ChatAgentEvent[] = [];
      await agent.handleUserMessage('go', (e) => events.push(e));

      const doneEvent = events.find((e) => e.type === 'tool_call_done');
      expect(doneEvent).toMatchObject({ type: 'tool_call_done', error: 'boom' });
    });

    it('emits iteration_limit followed by final_text when the cap is hit', async () => {
      const noop = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ ok: true });
      llm.mockResolvedValue(toolResponse([{ id: 'c1', name: 'noop', parameters: {} }]));

      agent = new ChatAgent({
        llm,
        tools: [makeTool('noop', noop)],
        buildSceneContext,
        maxIterations: 2,
      });
      const events: ChatAgentEvent[] = [];
      await agent.handleUserMessage('loop', (e) => events.push(e));

      const types = events.map((e) => e.type);
      const limitIdx = types.indexOf('iteration_limit');
      const finalIdx = types.indexOf('final_text');
      expect(limitIdx).toBeGreaterThanOrEqual(0);
      expect(finalIdx).toBeGreaterThan(limitIdx);
    });

    it('handler thrown errors never break the agent loop', async () => {
      const tool = makeTool('get_tracks', async () => ({ ok: true }));
      llm
        .mockResolvedValueOnce(toolResponse([{ id: 'c1', name: 'get_tracks', parameters: {} }]))
        .mockResolvedValueOnce(textResponse('Done.'));

      agent = new ChatAgent({ llm, tools: [tool], buildSceneContext });
      const result = await agent.handleUserMessage('go', () => {
        throw new Error('observer crashed');
      });

      expect(result.text).toBe('Done.');
    });

    it('AgentResponse shape is unchanged when onEvent is passed', async () => {
      const tool = makeTool('get_tracks', async () => ({ tracks: ['Bass'] }));
      llm
        .mockResolvedValueOnce(
          toolResponse([{ id: 'c1', name: 'get_tracks', parameters: {} }])
        )
        .mockResolvedValueOnce(textResponse('Found.'));

      agent = new ChatAgent({ llm, tools: [tool], buildSceneContext });
      const result = await agent.handleUserMessage('x', () => {});
      expect(result.text).toBe('Found.');
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject({
        tool: 'get_tracks',
        result: { tracks: ['Bass'] },
      });
    });

    it('uses the default onEvent from options when no per-call override is given', async () => {
      const events: ChatAgentEvent[] = [];
      llm.mockResolvedValue(textResponse('hello'));
      agent = new ChatAgent({
        llm,
        tools: [],
        buildSceneContext,
        onEvent: (e) => events.push(e),
      });

      await agent.handleUserMessage('hi');
      expect(events).toEqual([{ type: 'final_text', content: 'hello' }]);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool result serialization
  // ---------------------------------------------------------------------------

  describe('tool-result serialization', () => {
    it('feeds tool results back to the LLM as a tool message referencing the call id', async () => {
      const tool = jest.fn<ChatAgentTool['handler']>().mockResolvedValue({ tracks: ['Bass'] });

      llm
        .mockResolvedValueOnce(toolResponse([{ id: 'call-123', name: 'get', parameters: {} }]))
        .mockResolvedValueOnce(textResponse('ok'));

      agent = new ChatAgent({ llm, tools: [makeTool('get', tool)], buildSceneContext });

      await agent.handleUserMessage('go');

      const secondCall = llm.mock.calls[1][0];
      const toolMsg = secondCall.messages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg?.toolCallId).toBe('call-123');
    });
  });
});
