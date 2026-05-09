/**
 * ChatPanel spec — terminal-log behavior.
 *
 * The ChatPanel subscribes to AgentLoopEvents while sendMessage is in flight.
 * Each event mutates the running log: tool_call_start inserts a pending row,
 * tool_call_done replaces it with a result row, final_text appends the
 * assistant line. After the turn completes, tool rows collapse to a one-line
 * summary that can be re-expanded.
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ChatPanel, type ChatPanelResponse } from '../ChatPanel';
import type { AgentLoopEvent } from '../../agent-loop';

type SendFn = (
  message: string,
  onEvent: (event: AgentLoopEvent) => void
) => Promise<ChatPanelResponse>;

function typeAndSend(text: string): void {
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
}

/** Helper: build a tool_call_done success event with stdout JSON. */
function toolDoneSuccess(
  iteration: number,
  callId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  stdout: string
): AgentLoopEvent {
  return {
    type: 'tool_call_done',
    iteration,
    callId,
    toolName,
    toolArgs,
    result: { success: true, exitCode: 0, stdout, stderr: '' },
  };
}

/** Helper: build a tool_call_done failure event with stderr text. */
function toolDoneFailure(
  iteration: number,
  callId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  stderr: string
): AgentLoopEvent {
  return {
    type: 'tool_call_done',
    iteration,
    callId,
    toolName,
    toolArgs,
    result: { success: false, exitCode: 1, stdout: '', stderr },
  };
}

describe('ChatPanel (terminal log)', () => {
  let sendFn: jest.Mock<SendFn>;

  beforeEach(() => {
    sendFn = jest.fn<SendFn>();
  });

  describe('basic flow', () => {
    it('renders user prompt and final assistant text', async () => {
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({ type: 'final_text', iterations: 1, text: 'Hello back.' });
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
        onEvent({ type: 'final_text', iterations: 1, text: 'ok' });
        return { text: 'ok', actions: [] };
      });
      render(<ChatPanel sendMessage={sendFn} />);

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      await act(async () => {
        typeAndSend('hi');
      });

      expect(textarea.value).toBe('');
    });
  });

  describe('tool streaming', () => {
    it('renders a pending tool row on tool_call_start and fills in the result on tool_call_done', async () => {
      let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<ChatPanelResponse>((resolve) => {
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
          toolName: 'get_tracks',
          toolArgs: {},
        });
      });
      expect(screen.getByText('get_tracks')).not.toBeNull();
      // No result yet — the ↳ line should not be present
      expect(screen.queryByText(/↳/)).toBeNull();

      // Result arrives — ↳ line appears with a formatted result
      act(() => {
        capturedOnEvent(
          toolDoneSuccess(1, 'c1', 'get_tracks', {}, JSON.stringify({ tracks: ['Bass', 'Drums'] }))
        );
      });
      expect(screen.getByText(/↳/)).not.toBeNull();
      expect(screen.getByText(/Bass/)).not.toBeNull();

      // Finish the turn
      act(() => {
        capturedOnEvent({ type: 'final_text', iterations: 1, text: 'Found 2.' });
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
          toolName: 'bad',
          toolArgs: {},
        });
        onEvent(toolDoneFailure(1, 'c1', 'bad', {}, 'track not found'));
        onEvent({ type: 'final_text', iterations: 1, text: 'Could not find it.' });
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
          toolName: 'get_tracks',
          toolArgs: {},
        });
        onEvent(toolDoneSuccess(1, 'c1', 'get_tracks', {}, JSON.stringify({ tracks: ['Bass'] })));
        onEvent({
          type: 'tool_call_start',
          iteration: 2,
          callId: 'c2',
          toolName: 'set_fx',
          toolArgs: { enabled: true },
        });
        onEvent(toolDoneSuccess(2, 'c2', 'set_fx', { enabled: true }, ''));
        onEvent({ type: 'final_text', iterations: 2, text: 'Done.' });
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
          toolName: 'get_tracks',
          toolArgs: {},
        });
        onEvent(toolDoneSuccess(1, 'c1', 'get_tracks', {}, ''));
        onEvent({ type: 'final_text', iterations: 1, text: 'Done.' });
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
        onEvent({ type: 'final_text', iterations: 1, text: 'just talking' });
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
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        () => new Promise<ChatPanelResponse>((resolve) => { resolveSend = resolve; })
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
          onEvent({ type: 'final_text', iterations: 1, text: 'one' });
          return { text: 'one', actions: [] };
        })
        .mockImplementationOnce(async (_msg, onEvent) => {
          onEvent({ type: 'final_text', iterations: 1, text: 'two' });
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
        onEvent({ type: 'final_text', iterations: 1, text: 'ok' });
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
          toolName: 'noop',
          toolArgs: {},
        });
        onEvent(toolDoneSuccess(1, 'c1', 'noop', {}, ''));
        onEvent({ type: 'final_text', iterations: 1, text: 'hit the cap' });
        onEvent({ type: 'iteration_limit', iterations: 1 });
        return { text: 'hit the cap', actions: [] };
      });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('go forever');
      });

      expect(screen.getByText(/iteration limit/i)).not.toBeNull();
    });
  });

  describe('thinking indicator', () => {
    it('inserts a thinking row on llm_call_start and removes it on llm_call_end', async () => {
      let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<ChatPanelResponse>((resolve) => {
            capturedOnEvent = onEvent;
            resolveSend = resolve;
          })
      );

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('hi');
      });

      // Before llm_call_start: no thinking row.
      expect(screen.queryByText(/thinking/)).toBeNull();

      // After llm_call_start: a thinking row is visible.
      act(() => {
        capturedOnEvent({ type: 'llm_call_start', iteration: 1 });
      });
      expect(screen.getByText(/thinking/)).not.toBeNull();

      // After llm_call_end: it's gone again.
      act(() => {
        capturedOnEvent({ type: 'llm_call_end', iteration: 1 });
      });
      expect(screen.queryByText(/thinking/)).toBeNull();

      // Wrap up the turn cleanly so the test doesn't leak a pending promise.
      act(() => {
        capturedOnEvent({ type: 'final_text', iterations: 1, text: 'ok' });
      });
      await act(async () => {
        resolveSend({ text: 'ok', actions: [] });
      });
    });

    it('does not stack thinking rows when llm_call_start fires twice in a row', async () => {
      let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<ChatPanelResponse>((resolve) => {
            capturedOnEvent = onEvent;
            resolveSend = resolve;
          })
      );

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('hi');
      });

      act(() => {
        capturedOnEvent({ type: 'llm_call_start', iteration: 1 });
        capturedOnEvent({ type: 'llm_call_start', iteration: 1 });
      });
      // Only one thinking element should exist for this turn.
      expect(screen.getAllByText(/thinking/)).toHaveLength(1);

      act(() => {
        capturedOnEvent({ type: 'final_text', iterations: 1, text: 'ok' });
      });
      await act(async () => {
        resolveSend({ text: 'ok', actions: [] });
      });
    });

    it('strips a lingering thinking row when tool_call_start arrives', async () => {
      // Defensive case: llm_call_end is dropped (e.g., IPC reorder); the
      // arrival of a tool call must clear the thinking indicator.
      let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<ChatPanelResponse>((resolve) => {
            capturedOnEvent = onEvent;
            resolveSend = resolve;
          })
      );

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('list');
      });

      act(() => {
        capturedOnEvent({ type: 'llm_call_start', iteration: 1 });
        capturedOnEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          toolName: 'get_tracks',
          toolArgs: {},
        });
      });
      expect(screen.queryByText(/thinking/)).toBeNull();
      expect(screen.getByText('get_tracks')).not.toBeNull();

      act(() => {
        capturedOnEvent(toolDoneSuccess(1, 'c1', 'get_tracks', {}, ''));
        capturedOnEvent({ type: 'final_text', iterations: 1, text: 'done' });
      });
      await act(async () => {
        resolveSend({ text: 'done', actions: [] });
      });
    });
  });

  describe('running indicator', () => {
    it('shows "running..." under a pending tool until tool_call_done arrives', async () => {
      let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<ChatPanelResponse>((resolve) => {
            capturedOnEvent = onEvent;
            resolveSend = resolve;
          })
      );

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('compose');
      });

      // No pending tools yet — no running indicator.
      expect(screen.queryByText(/running/)).toBeNull();

      // tool_call_start → running indicator visible.
      act(() => {
        capturedOnEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          toolName: 'compose_scene',
          toolArgs: {},
        });
      });
      expect(screen.getByText(/running/)).not.toBeNull();

      // tool_call_done → running indicator gone, ↳ result row visible.
      act(() => {
        capturedOnEvent(toolDoneSuccess(1, 'c1', 'compose_scene', {}, '{}'));
      });
      expect(screen.queryByText(/running/)).toBeNull();
      expect(screen.getByText(/↳/)).not.toBeNull();

      act(() => {
        capturedOnEvent({ type: 'final_text', iterations: 1, text: 'ok' });
      });
      await act(async () => {
        resolveSend({ text: 'ok', actions: [] });
      });
    });
  });

  describe('tool_progress streaming', () => {
    it('renders streamed CLI lines under the pending tool with the matching callId', async () => {
      let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<ChatPanelResponse>((resolve) => {
            capturedOnEvent = onEvent;
            resolveSend = resolve;
          })
      );

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('compose');
      });

      act(() => {
        capturedOnEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          toolName: 'compose_scene',
          toolArgs: {},
        });
        capturedOnEvent({
          type: 'tool_progress',
          iteration: 1,
          callId: 'c1',
          stream: 'stdout',
          line: 'loading synth...',
        });
        capturedOnEvent({
          type: 'tool_progress',
          iteration: 1,
          callId: 'c1',
          stream: 'stderr',
          line: 'warn: slow disk',
        });
      });

      expect(screen.getByText(/loading synth/)).not.toBeNull();
      expect(screen.getByText(/slow disk/)).not.toBeNull();

      // Output lines persist across tool_call_done — they're scrollback,
      // not just an in-flight indicator.
      act(() => {
        capturedOnEvent(toolDoneSuccess(1, 'c1', 'compose_scene', {}, '{}'));
      });
      expect(screen.getByText(/loading synth/)).not.toBeNull();
      expect(screen.getByText(/slow disk/)).not.toBeNull();

      act(() => {
        capturedOnEvent({ type: 'final_text', iterations: 1, text: 'ok' });
      });
      await act(async () => {
        resolveSend({ text: 'ok', actions: [] });
      });
    });

    it('collapses output lines together with tool rows after a clean turn', async () => {
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          toolName: 'compose_scene',
          toolArgs: {},
        });
        onEvent({
          type: 'tool_progress',
          iteration: 1,
          callId: 'c1',
          stream: 'stdout',
          line: 'midline log',
        });
        onEvent(toolDoneSuccess(1, 'c1', 'compose_scene', {}, '{}'));
        onEvent({ type: 'final_text', iterations: 1, text: 'done' });
        return { text: 'done', actions: [] };
      });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('go');
      });

      // After collapse, output lines and tool rows are both hidden.
      await waitFor(() => {
        expect(screen.queryByText('compose_scene')).toBeNull();
        expect(screen.queryByText(/midline log/)).toBeNull();
      });

      // Re-expand and they reappear.
      const summary = screen.getByText(/1 tool call/);
      await act(async () => {
        fireEvent.click(summary);
      });
      expect(screen.getByText('compose_scene')).not.toBeNull();
      expect(screen.getByText(/midline log/)).not.toBeNull();
    });
  });
});
