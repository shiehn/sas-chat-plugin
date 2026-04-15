/**
 * LLMCallFn ↔ PluginHost.generateWithLLM adapter spec.
 *
 * The existing PluginHost LLM interface is text-in/text-out. Our ChatAgent
 * wants a structured tool-calling interface. The adapter bridges them by
 * using a strict JSON protocol: the LLM is instructed to emit either
 *   {"type": "text", "content": "..."}
 * or
 *   {"type": "tool_use", "toolCalls": [{"id": "...", "name": "...", "parameters": {...}}]}
 *
 * The adapter:
 *   - Builds a system prompt listing available tools and their schemas
 *   - Flattens conversation history into a user prompt the host LLM can consume
 *   - Parses the JSON response, with tolerant handling for prose wrappers
 *   - Falls back to "text" response if parsing fails (so the agent loop
 *     always terminates gracefully)
 */

import { describe, it, expect, jest } from '@jest/globals';
import { makeLLMAdapter, type PluginHostLLMFn } from '../llm-adapter';
import type { LLMMessage, ChatAgentTool } from '../chat-agent';

function fakeHostLLM(responseContent: string): jest.MockedFunction<PluginHostLLMFn> {
  const fn = jest.fn<PluginHostLLMFn>();
  fn.mockResolvedValue({ content: responseContent, tokensUsed: 10, model: 'test' });
  return fn;
}

const sampleTool: ChatAgentTool = {
  name: 'get_tracks',
  description: 'List tracks in the current scene',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ tracks: [] }),
};

describe('makeLLMAdapter', () => {
  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  describe('response parsing', () => {
    it('parses a clean JSON text response', async () => {
      const host = fakeHostLLM(JSON.stringify({ type: 'text', content: 'Hello there.' }));
      const adapter = makeLLMAdapter(host);

      const result = await adapter({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      });

      expect(result).toEqual({ type: 'text', content: 'Hello there.' });
    });

    it('parses a clean JSON tool_use response', async () => {
      const host = fakeHostLLM(
        JSON.stringify({
          type: 'tool_use',
          toolCalls: [{ id: 'c1', name: 'get_tracks', parameters: {} }],
        })
      );
      const adapter = makeLLMAdapter(host);

      const result = await adapter({
        system: 'sys',
        messages: [{ role: 'user', content: 'what tracks' }],
        tools: [sampleTool],
      });

      expect(result.type).toBe('tool_use');
      if (result.type === 'tool_use') {
        expect(result.toolCalls).toEqual([{ id: 'c1', name: 'get_tracks', parameters: {} }]);
      }
    });

    it('extracts JSON from prose-wrapped responses (LLMs sometimes add commentary)', async () => {
      const prose = `Sure, here's what I'll do:\n\n{"type": "text", "content": "Done."}`;
      const host = fakeHostLLM(prose);
      const adapter = makeLLMAdapter(host);

      const result = await adapter({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
      expect(result.type).toBe('text');
      if (result.type === 'text') expect(result.content).toBe('Done.');
    });

    it('handles fenced-code-block JSON (```json ... ```)', async () => {
      const fenced = '```json\n{"type": "text", "content": "fenced"}\n```';
      const host = fakeHostLLM(fenced);
      const adapter = makeLLMAdapter(host);

      const result = await adapter({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
      expect(result.type).toBe('text');
      if (result.type === 'text') expect(result.content).toBe('fenced');
    });

    it('falls back to a text response when parsing fails (graceful degradation)', async () => {
      const host = fakeHostLLM('not json at all — just prose');
      const adapter = makeLLMAdapter(host);

      const result = await adapter({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
      expect(result.type).toBe('text');
      if (result.type === 'text') {
        expect(result.content).toContain('not json at all');
      }
    });

    it('treats an empty toolCalls array as a text response (no-op tool turn)', async () => {
      // If the LLM emits {"type": "tool_use", "toolCalls": []} we should NOT
      // loop forever — treat as done with empty text.
      const host = fakeHostLLM(JSON.stringify({ type: 'tool_use', toolCalls: [] }));
      const adapter = makeLLMAdapter(host);

      const result = await adapter({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
      expect(result.type).toBe('text');
    });

    it('generates call ids when the LLM omits them', async () => {
      const host = fakeHostLLM(
        JSON.stringify({
          type: 'tool_use',
          toolCalls: [{ name: 'get_tracks', parameters: {} }],
        })
      );
      const adapter = makeLLMAdapter(host);

      const result = await adapter({
        system: 's',
        messages: [{ role: 'user', content: 'x' }],
        tools: [sampleTool],
      });

      if (result.type === 'tool_use') {
        expect(result.toolCalls[0].id).toBeDefined();
        expect(result.toolCalls[0].id.length).toBeGreaterThan(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Prompt construction
  // ---------------------------------------------------------------------------

  describe('prompt construction', () => {
    it('injects tool definitions into the system prompt', async () => {
      const host = fakeHostLLM(JSON.stringify({ type: 'text', content: 'ok' }));
      const adapter = makeLLMAdapter(host);

      await adapter({
        system: 'you are a helper',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [sampleTool],
      });

      const [req] = host.mock.calls[0];
      expect(req.system).toContain('you are a helper');
      expect(req.system).toContain('get_tracks');
      expect(req.system).toContain('List tracks');
    });

    it('instructs the LLM to emit JSON in one of the two allowed shapes', async () => {
      const host = fakeHostLLM(JSON.stringify({ type: 'text', content: 'ok' }));
      const adapter = makeLLMAdapter(host);

      await adapter({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });

      const [req] = host.mock.calls[0];
      expect(req.system).toMatch(/\{"type"\s*:\s*"text"/);
      expect(req.system).toMatch(/\{"type"\s*:\s*"tool_use"/);
    });

    it('flattens multi-turn history into the user prompt', async () => {
      const host = fakeHostLLM(JSON.stringify({ type: 'text', content: 'ok' }));
      const adapter = makeLLMAdapter(host);

      const messages: LLMMessage[] = [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ];

      await adapter({ system: 's', messages, tools: [] });

      const [req] = host.mock.calls[0];
      expect(req.user).toContain('first question');
      expect(req.user).toContain('first answer');
      expect(req.user).toContain('second question');
    });

    it('includes tool-result messages in the user prompt (keyed by toolCallId)', async () => {
      const host = fakeHostLLM(JSON.stringify({ type: 'text', content: 'ok' }));
      const adapter = makeLLMAdapter(host);

      const messages: LLMMessage[] = [
        { role: 'user', content: 'go' },
        { role: 'tool', content: '{"tracks":["Bass"]}', toolCallId: 'c1' },
      ];

      await adapter({ system: 's', messages, tools: [] });
      const [req] = host.mock.calls[0];
      expect(req.user).toContain('c1');
      expect(req.user).toContain('"tracks"');
    });

    it('requests JSON responseFormat from the host', async () => {
      const host = fakeHostLLM(JSON.stringify({ type: 'text', content: 'ok' }));
      const adapter = makeLLMAdapter(host);
      await adapter({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
      const [req] = host.mock.calls[0];
      expect(req.responseFormat).toBe('json');
    });

    it('sets skipContextPrefix=true so the adapter controls the system prompt', async () => {
      const host = fakeHostLLM(JSON.stringify({ type: 'text', content: 'ok' }));
      const adapter = makeLLMAdapter(host);
      await adapter({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
      const [req] = host.mock.calls[0];
      expect(req.skipContextPrefix).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-end with ChatAgent
  // ---------------------------------------------------------------------------

  describe('integration with ChatAgent', () => {
    it('supports the full tool-loop pattern', async () => {
      const { ChatAgent } = await import('../chat-agent');

      const host = jest.fn<PluginHostLLMFn>()
        .mockResolvedValueOnce({
          content: JSON.stringify({
            type: 'tool_use',
            toolCalls: [{ id: 'c1', name: 'get_tracks', parameters: {} }],
          }),
          tokensUsed: 5,
          model: 'test',
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ type: 'text', content: 'Found Bass.' }),
          tokensUsed: 5,
          model: 'test',
        });

      const get: ChatAgentTool = {
        name: 'get_tracks',
        description: 'list',
        parameters: { type: 'object' },
        handler: async () => ({ tracks: ['Bass'] }),
      };

      const adapter = makeLLMAdapter(host);
      const agent = new ChatAgent({
        llm: adapter,
        tools: [get],
        buildSceneContext: async () => 'scene state',
      });

      const result = await agent.handleUserMessage('what tracks?');
      expect(result.text).toBe('Found Bass.');
      expect(host).toHaveBeenCalledTimes(2);
    });
  });
});
