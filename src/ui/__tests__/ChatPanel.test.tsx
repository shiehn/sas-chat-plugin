/**
 * ChatPanel spec — terminal-log behavior.
 *
 * The ChatPanel subscribes to ChatAgentEvents while sendMessage is in
 * flight. Each event mutates the running log: tool_call_start inserts a
 * pending row, tool_call_done replaces it with a result row, final_text
 * appends the assistant line. After the turn completes, tool rows collapse
 * to a one-line summary that can be re-expanded.
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ChatPanel } from '../ChatPanel';
import type { AgentResponse, ChatAgentEvent } from '../../chat-agent';

type SendFn = (
  message: string,
  onEvent: (event: ChatAgentEvent) => void
) => Promise<AgentResponse>;

function typeAndSend(text: string): void {
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
}

describe('ChatPanel (terminal log)', () => {
  let sendFn: jest.Mock<SendFn>;

  beforeEach(() => {
    sendFn = jest.fn<SendFn>();
  });

  describe('basic flow', () => {
    it('renders user prompt and final assistant text', async () => {
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({ type: 'final_text', content: 'Hello back.' });
        return { text: 'Hello back.', actions: [] };
      });
      render(<ChatPanel sendMessage={sendFn} />);

      await act(async () => {
        typeAndSend('hi');
      });

      expect(screen.getByText('hi')).not.toBeNull();
      expect(screen.getByText('Hello back.')).not.toBeNull();
      expect(sendFn).toHaveBeenCalledWith('hi', expect.any(Function));
    });

    it('clears the input after send', async () => {
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({ type: 'final_text', content: 'ok' });
        return { text: 'ok', actions: [] };
      });
      render(<ChatPanel sendMessage={sendFn} />);

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      await act(async () => {
        typeAndSend('x');
      });
      expect(textarea.value).toBe('');
    });
  });

  describe('tool streaming', () => {
    it('renders a pending tool row on tool_call_start and fills in the result on tool_call_done', async () => {
      let capturedOnEvent: (e: ChatAgentEvent) => void = () => {};
      let resolveSend: (v: AgentResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<AgentResponse>((resolve) => {
            capturedOnEvent = onEvent;
            resolveSend = resolve;
          })
      );

      render(<ChatPanel sendMessage={sendFn} />);

      await act(async () => {
        typeAndSend('list tracks');
      });

      // Tool call starts — pending row appears without a result
      act(() => {
        capturedOnEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          tool: 'get_tracks',
          params: {},
        });
      });
      expect(screen.getByText('get_tracks')).not.toBeNull();
      // No result yet — the ↳ line should not be present
      expect(screen.queryByText(/↳/)).toBeNull();

      // Result arrives — ↳ line appears with a formatted result
      act(() => {
        capturedOnEvent({
          type: 'tool_call_done',
          iteration: 1,
          callId: 'c1',
          tool: 'get_tracks',
          params: {},
          result: { tracks: ['Bass', 'Drums'] },
        });
      });
      expect(screen.getByText(/↳/)).not.toBeNull();
      expect(screen.getByText(/Bass/)).not.toBeNull();

      // Finish the turn
      act(() => {
        capturedOnEvent({ type: 'final_text', content: 'Found 2.' });
      });
      await act(async () => {
        resolveSend({ text: 'Found 2.', actions: [] });
      });
    });

    it('renders tool errors with an error class on the ↳ line', async () => {
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          tool: 'bad',
          params: {},
        });
        onEvent({
          type: 'tool_call_done',
          iteration: 1,
          callId: 'c1',
          tool: 'bad',
          params: {},
          error: 'track not found',
        });
        onEvent({ type: 'final_text', content: 'Could not find it.' });
        return { text: 'Could not find it.', actions: [] };
      });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('do it');
      });

      expect(screen.getByText(/track not found/)).not.toBeNull();
    });
  });

  describe('collapse-to-summary', () => {
    it('collapses tool rows into a one-line summary after the turn completes', async () => {
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          tool: 'get_tracks',
          params: {},
        });
        onEvent({
          type: 'tool_call_done',
          iteration: 1,
          callId: 'c1',
          tool: 'get_tracks',
          params: {},
          result: { tracks: ['Bass'] },
        });
        onEvent({
          type: 'tool_call_start',
          iteration: 2,
          callId: 'c2',
          tool: 'set_fx',
          params: { enabled: true },
        });
        onEvent({
          type: 'tool_call_done',
          iteration: 2,
          callId: 'c2',
          tool: 'set_fx',
          params: { enabled: true },
          result: null,
        });
        onEvent({ type: 'final_text', content: 'Done.' });
        return { text: 'Done.', actions: [] };
      });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('add fx');
      });

      // After the turn, the tool names are hidden — only the summary remains
      await waitFor(() => {
        expect(screen.queryByText('get_tracks')).toBeNull();
        expect(screen.queryByText('set_fx')).toBeNull();
      });
      expect(screen.getByText(/2 tool calls/)).not.toBeNull();
      expect(screen.getByText('Done.')).not.toBeNull();
    });

    it('re-expands the tool rows when the summary is clicked', async () => {
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          tool: 'get_tracks',
          params: {},
        });
        onEvent({
          type: 'tool_call_done',
          iteration: 1,
          callId: 'c1',
          tool: 'get_tracks',
          params: {},
          result: null,
        });
        onEvent({ type: 'final_text', content: 'Done.' });
        return { text: 'Done.', actions: [] };
      });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('x');
      });

      await waitFor(() => {
        expect(screen.queryByText('get_tracks')).toBeNull();
      });

      const summary = screen.getByText(/1 tool call/);
      await act(async () => {
        fireEvent.click(summary);
      });

      expect(screen.getByText('get_tracks')).not.toBeNull();
    });

    it('does not show a summary when the turn had zero tool calls', async () => {
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({ type: 'final_text', content: 'just talking' });
        return { text: 'just talking', actions: [] };
      });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('hi');
      });

      expect(screen.queryByText(/tool call/)).toBeNull();
      expect(screen.getByText('just talking')).not.toBeNull();
    });
  });

  describe('processing state', () => {
    it('disables input while a turn is in flight', async () => {
      let resolveSend: (v: AgentResponse) => void = () => {};
      sendFn.mockImplementation(
        () => new Promise<AgentResponse>((resolve) => { resolveSend = resolve; })
      );
      render(<ChatPanel sendMessage={sendFn} />);

      await act(async () => {
        typeAndSend('x');
      });

      expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);

      await act(async () => {
        resolveSend({ text: 'done', actions: [] });
      });

      await waitFor(() => {
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
      });
    });
  });

  describe('error handling', () => {
    it('renders an error row when the agent rejects', async () => {
      sendFn.mockRejectedValue(new Error('LLM unreachable'));
      render(<ChatPanel sendMessage={sendFn} />);

      await act(async () => {
        typeAndSend('hi');
      });

      expect(screen.getByText(/LLM unreachable/)).not.toBeNull();
    });
  });

  describe('multi-turn', () => {
    it('keeps prior turns visible', async () => {
      sendFn
        .mockImplementationOnce(async (_msg, onEvent) => {
          onEvent({ type: 'final_text', content: 'one' });
          return { text: 'one', actions: [] };
        })
        .mockImplementationOnce(async (_msg, onEvent) => {
          onEvent({ type: 'final_text', content: 'two' });
          return { text: 'two', actions: [] };
        });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('first');
      });
      await act(async () => {
        typeAndSend('second');
      });

      expect(screen.getByText('first')).not.toBeNull();
      expect(screen.getByText('one')).not.toBeNull();
      expect(screen.getByText('second')).not.toBeNull();
      expect(screen.getByText('two')).not.toBeNull();
    });
  });

  describe('scene reset', () => {
    it('clears the log when the registered reset callback is invoked', async () => {
      let doReset: (() => void) | null = null;
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({ type: 'final_text', content: 'ok' });
        return { text: 'ok', actions: [] };
      });

      render(
        <ChatPanel
          sendMessage={sendFn}
          registerReset={(fn) => {
            doReset = fn;
          }}
        />
      );
      await act(async () => {
        typeAndSend('hi');
      });
      expect(screen.getByText('hi')).not.toBeNull();

      act(() => {
        doReset?.();
      });

      expect(screen.queryByText('hi')).toBeNull();
      expect(screen.queryByText('ok')).toBeNull();
    });
  });

  describe('iteration limit', () => {
    it('tags the assistant row when iteration_limit is emitted before final_text', async () => {
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          tool: 'noop',
          params: {},
        });
        onEvent({
          type: 'tool_call_done',
          iteration: 1,
          callId: 'c1',
          tool: 'noop',
          params: {},
          result: null,
        });
        onEvent({ type: 'final_text', content: 'hit the cap' });
        onEvent({ type: 'iteration_limit' });
        return { text: 'hit the cap', actions: [], iterationLimitHit: true };
      });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('go forever');
      });

      expect(screen.getByText(/iteration limit/i)).not.toBeNull();
    });
  });
});
