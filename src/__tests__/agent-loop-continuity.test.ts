/**
 * AgentLoop continuity surface (Phase 2b):
 *   - seedHistory / getHistorySnapshot (restart restore)
 *   - updateToolSurface (scene change without losing history)
 *   - queueContextNote (state-change breadcrumbs on the next user turn)
 *   - start-of-turn compaction (summarize-don't-wipe pressure valve)
 */

import {
  AgentLoop,
  findCompactionCut,
  renderTranscriptForCompaction,
} from '../agent-loop';
import type { ToolExecutor } from '../agent-loop';
import type { AgentBackend } from '../backend';
import type {
  LLMContent,
  LLMTool,
  LLMToolUseRequest,
  LLMToolUseResponse,
  PluginHost,
} from '@signalsandsorcery/plugin-sdk';

const COMPACTION_MODEL = 'fake-compactor';

function textResponse(text: string): LLMToolUseResponse {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] } }] };
}

/**
 * Scripted backend: compaction-model requests get a fixed summary; agent
 * requests pop from a queue (default: terminal "done").
 */
function makeBackend(opts?: {
  agentResponses?: LLMToolUseResponse[];
  summaryText?: string | null;
  failCompaction?: boolean;
}): { backend: AgentBackend; calls: LLMToolUseRequest[] } {
  const calls: LLMToolUseRequest[] = [];
  const agentQueue = [...(opts?.agentResponses ?? [])];
  const backend: AgentBackend = {
    name: 'fake',
    defaultModel: 'fake-pro',
    compactionModel: COMPACTION_MODEL,
    capabilities: { preservesThoughtSignatures: true, requiresStringEnums: true },
    complete: jest.fn(async (request: LLMToolUseRequest) => {
      calls.push(request);
      if (request.model === COMPACTION_MODEL) {
        if (opts?.failCompaction) throw new Error('summarizer down');
        if (opts?.summaryText === null) return textResponse('');
        return textResponse(opts?.summaryText ?? '- earlier: user built a house beat at 124 BPM');
      }
      return agentQueue.shift() ?? textResponse('done');
    }),
  };
  return { backend, calls };
}

const noopExecutor: ToolExecutor = async () => ({
  success: true,
  exitCode: 0,
  stdout: '{}',
  stderr: '',
});

const host = {} as PluginHost;

function userTurn(text: string): LLMContent {
  return { role: 'user', parts: [{ text }] };
}
function modelTurn(text: string): LLMContent {
  return { role: 'model', parts: [{ text }] };
}
function toolCallTurn(name: string): LLMContent {
  return {
    role: 'model',
    parts: [{ functionCall: { name, args: {}, thoughtSignature: 'sig-1' } }] as never,
  };
}
function toolResponseTurn(name: string): LLMContent {
  return {
    role: 'user',
    parts: [{ functionResponse: { name, response: { success: true } } }] as never,
  };
}

describe('seedHistory / getHistorySnapshot', () => {
  it('round-trips and isolates the snapshot from live history', async () => {
    const { backend } = makeBackend();
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: noopExecutor,
      systemPrompt: 'sys',
    });
    const seeded = [userTurn('hello'), modelTurn('hi!')];
    loop.seedHistory(seeded);
    const snap = loop.getHistorySnapshot();
    expect(snap).toEqual(seeded);
    // Mutating the snapshot must not touch live history.
    snap.push(userTurn('injected'));
    expect(loop.getHistorySnapshot()).toHaveLength(2);
  });

  it('filters malformed entries defensively', () => {
    const { backend } = makeBackend();
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: noopExecutor,
      systemPrompt: 'sys',
    });
    loop.seedHistory([
      userTurn('ok'),
      { role: 'narrator', parts: [] } as unknown as LLMContent,
      { role: 'model' } as unknown as LLMContent,
      null as unknown as LLMContent,
    ]);
    expect(loop.getHistorySnapshot()).toEqual([userTurn('ok')]);
  });

  it('seeded history is sent to the backend on the next run', async () => {
    const { backend, calls } = makeBackend();
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: noopExecutor,
      systemPrompt: 'sys',
    });
    loop.seedHistory([userTurn('earlier message'), modelTurn('earlier reply')]);
    await loop.run('new message');
    const req = calls[0];
    expect(req.contents).toHaveLength(3);
    expect(req.contents[0].parts[0].text).toBe('earlier message');
    expect(req.contents[2].parts[0].text).toBe('new message');
  });
});

describe('updateToolSurface', () => {
  const toolsA: LLMTool[] = [
    { functionDeclarations: [{ name: 'tool_a', description: 'a', parameters: { type: 'object', properties: {} } }] },
  ];
  const toolsB: LLMTool[] = [
    { functionDeclarations: [{ name: 'tool_b', description: 'b', parameters: { type: 'object', properties: {} } }] },
  ];

  it('applies immediately when idle; history survives', async () => {
    const { backend, calls } = makeBackend({
      agentResponses: [textResponse('first'), textResponse('second')],
    });
    const loop = new AgentLoop({
      host,
      backend,
      tools: toolsA,
      toolExecutor: noopExecutor,
      systemPrompt: 'sys',
    });
    await loop.run('turn one');
    loop.updateToolSurface(toolsB, noopExecutor);
    await loop.run('turn two');

    expect(calls[0].tools).toBe(toolsA);
    expect(calls[1].tools).toBe(toolsB);
    // History from turn one survived the surface swap.
    expect(calls[1].contents[0].parts[0].text).toBe('turn one');
  });

  it('defers a swap that arrives mid-run', async () => {
    const { backend, calls } = makeBackend({
      agentResponses: [
        // Iter 1: call a tool (so the executor runs mid-turn).
        {
          candidates: [
            { content: { role: 'model', parts: [{ functionCall: { name: 'tool_a', args: {} } }] as never } },
          ],
        },
        textResponse('done after tool'),
        textResponse('second turn'),
      ],
    });
    let loopRef: AgentLoop | null = null;
    const swappingExecutor: ToolExecutor = async () => {
      loopRef?.updateToolSurface(toolsB, noopExecutor);
      return { success: true, exitCode: 0, stdout: '{}', stderr: '' };
    };
    const loop = new AgentLoop({
      host,
      backend,
      tools: toolsA,
      toolExecutor: swappingExecutor,
      systemPrompt: 'sys',
    });
    loopRef = loop;
    await loop.run('turn one');
    // Both iterations of turn one used toolsA (swap deferred)…
    expect(calls[0].tools).toBe(toolsA);
    expect(calls[1].tools).toBe(toolsA);
    // …and turn two uses toolsB.
    await loop.run('turn two');
    expect(calls[2].tools).toBe(toolsB);
  });
});

describe('queueContextNote', () => {
  it('prepends queued notes to the next user message, once', async () => {
    const { backend, calls } = makeBackend({
      agentResponses: [textResponse('one'), textResponse('two')],
    });
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: noopExecutor,
      systemPrompt: 'sys',
    });
    loop.queueContextNote('[state change] Active scene switched.');
    await loop.run('do the thing');
    const turnOneUser = calls[0].contents[calls[0].contents.length - 1];
    expect(turnOneUser.parts[0].text).toBe(
      '[state change] Active scene switched.\n\ndo the thing',
    );
    // Cleared after use.
    await loop.run('next');
    const turnTwoUser = calls[1].contents[calls[1].contents.length - 1];
    expect(turnTwoUser.parts[0].text).toBe('next');
  });

  it('ignores empty notes', async () => {
    const { backend, calls } = makeBackend();
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: noopExecutor,
      systemPrompt: 'sys',
    });
    loop.queueContextNote('   ');
    await loop.run('plain');
    expect(calls[0].contents[0].parts[0].text).toBe('plain');
  });
});

describe('findCompactionCut', () => {
  it('cuts at the last real user message', () => {
    const contents = [
      userTurn('one'),
      modelTurn('reply'),
      userTurn('two'),
      toolCallTurn('t'),
      toolResponseTurn('t'),
      modelTurn('done'),
    ];
    expect(findCompactionCut(contents)).toBe(2);
  });

  it('never cuts between a functionCall and its functionResponse', () => {
    const contents = [
      userTurn('one'),
      toolCallTurn('t'),
      toolResponseTurn('t'), // user-role but functionResponse — not a cut point
      modelTurn('done'),
    ];
    expect(findCompactionCut(contents)).toBe(0);
  });

  it('returns 0 for empty / single-user histories', () => {
    expect(findCompactionCut([])).toBe(0);
    expect(findCompactionCut([userTurn('only')])).toBe(0);
  });
});

describe('compaction', () => {
  function bigHistory(turns: number): LLMContent[] {
    const out: LLMContent[] = [];
    for (let i = 0; i < turns; i++) {
      out.push(userTurn(`request ${i}`));
      out.push(modelTurn(`reply ${i}`));
    }
    return out;
  }

  it('compacts at start of run when the entry threshold is exceeded', async () => {
    const { backend, calls } = makeBackend();
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: noopExecutor,
      systemPrompt: 'sys',
    });
    loop.seedHistory(bigHistory(50)); // 100 entries > 80 threshold
    await loop.run('latest ask');

    // First backend call is the summarizer (cheap model, tools disabled)…
    const compactionCall = calls[0];
    expect(compactionCall.model).toBe(COMPACTION_MODEL);
    expect(compactionCall.toolConfig?.functionCallingConfig?.mode).toBe('NONE');
    // …then the agent call runs on the compacted history:
    // [summary, model-ack, last-real-user-turn, last-model-reply, new user msg]
    const agentCall = calls[1];
    expect(agentCall.model).toBe('fake-pro');
    expect(agentCall.contents).toHaveLength(5);
    expect(agentCall.contents[0].role).toBe('user');
    expect(agentCall.contents[0].parts[0].text).toContain('[Conversation summary');
    expect(agentCall.contents[0].parts[0].text).toContain('124 BPM');
    expect(agentCall.contents[1].role).toBe('model');
    expect(agentCall.contents[2].parts[0].text).toBe('request 49');
    expect(agentCall.contents[4].parts[0].text).toBe('latest ask');
  });

  it('requestCompaction() forces a pass below the thresholds', async () => {
    const { backend, calls } = makeBackend();
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: noopExecutor,
      systemPrompt: 'sys',
    });
    loop.seedHistory(bigHistory(3)); // 6 entries — far below thresholds
    loop.requestCompaction();
    await loop.run('go');
    expect(calls[0].model).toBe(COMPACTION_MODEL);
  });

  it('summarizer failure proceeds uncompacted', async () => {
    const { backend, calls } = makeBackend({ failCompaction: true });
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: noopExecutor,
      systemPrompt: 'sys',
    });
    loop.seedHistory(bigHistory(50));
    const result = await loop.run('still works');
    expect(result.text).toBe('done');
    // Agent call carries the FULL uncompacted history + the new message.
    const agentCall = calls.find((c) => c.model === 'fake-pro');
    expect(agentCall?.contents).toHaveLength(101);
  });

  it('does not compact small conversations', async () => {
    const { backend, calls } = makeBackend();
    const loop = new AgentLoop({
      host,
      backend,
      tools: [],
      toolExecutor: noopExecutor,
      systemPrompt: 'sys',
    });
    loop.seedHistory(bigHistory(3));
    await loop.run('hi');
    expect(calls.every((c) => c.model !== COMPACTION_MODEL)).toBe(true);
  });
});

describe('renderTranscriptForCompaction', () => {
  it('renders text, tool calls, and tool results compactly', () => {
    const transcript = renderTranscriptForCompaction([
      userTurn('make a beat'),
      toolCallTurn('compose_scene'),
      toolResponseTurn('compose_scene'),
      modelTurn('done!'),
    ]);
    expect(transcript).toContain('user: make a beat');
    expect(transcript).toContain('→ tool compose_scene');
    expect(transcript).toContain('tool compose_scene ← OK');
    expect(transcript).toContain('model: done!');
  });
});
