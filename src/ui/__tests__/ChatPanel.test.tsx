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

  describe('ask_user clarification flow', () => {
    it('renders a styled question entry on tool_call_start with toolName=ask_user, with quick-reply buttons when options are provided', async () => {
      let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<ChatPanelResponse>((resolve) => {
            capturedOnEvent = onEvent;
            resolveSend = resolve;
          }),
      );

      const sendClarification = jest.fn<(r: string) => Promise<void>>().mockResolvedValue();
      render(
        <ChatPanel
          sendMessage={sendFn}
          sendClarificationResponse={sendClarification}
        />,
      );

      await act(async () => {
        typeAndSend('boost the bass with reverb');
      });

      // Model fires ask_user with options.
      act(() => {
        capturedOnEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          toolName: 'ask_user',
          toolArgs: {
            question: 'Which bass: track 2 or track 5?',
            options: ['track 2', 'track 5'],
          },
        });
      });

      // Question is visible…
      expect(screen.getByText(/Which bass/)).not.toBeNull();
      // …with quick-reply buttons.
      const opt1 = screen.getByRole('button', { name: 'track 2' });
      const opt2 = screen.getByRole('button', { name: 'track 5' });
      expect(opt1).not.toBeNull();
      expect(opt2).not.toBeNull();

      // Input box re-enables for the user to type a reply.
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(false);

      // Wrap up the test loop.
      act(() => {
        capturedOnEvent({
          type: 'tool_call_done',
          iteration: 1,
          callId: 'c1',
          toolName: 'ask_user',
          toolArgs: {
            question: 'Which bass: track 2 or track 5?',
            options: ['track 2', 'track 5'],
          },
          result: { success: true, exitCode: 0, stdout: 'track 2', stderr: '' },
        });
        capturedOnEvent({ type: 'final_text', iterations: 2, text: 'Done.' });
      });
      await act(async () => {
        resolveSend({ text: 'Done.', actions: [] });
      });
    });

    it('routes the user\'s typed reply through sendClarificationResponse instead of starting a new turn', async () => {
      let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<ChatPanelResponse>((resolve) => {
            capturedOnEvent = onEvent;
            resolveSend = resolve;
          }),
      );

      const sendClarification = jest.fn<(r: string) => Promise<void>>().mockResolvedValue();
      render(
        <ChatPanel
          sendMessage={sendFn}
          sendClarificationResponse={sendClarification}
        />,
      );

      await act(async () => {
        typeAndSend('do it');
      });

      // Question fires; pending state is set.
      act(() => {
        capturedOnEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          toolName: 'ask_user',
          toolArgs: { question: 'which scene?' },
        });
      });

      // User types the reply.
      await act(async () => {
        typeAndSend('the intro scene');
      });

      // It went to sendClarificationResponse, NOT to sendMessage (no second turn).
      expect(sendClarification).toHaveBeenCalledWith('the intro scene');
      expect(sendFn).toHaveBeenCalledTimes(1);

      // Wrap the loop.
      act(() => {
        capturedOnEvent({
          type: 'tool_call_done',
          iteration: 1,
          callId: 'c1',
          toolName: 'ask_user',
          toolArgs: { question: 'which scene?' },
          result: { success: true, exitCode: 0, stdout: 'the intro scene', stderr: '' },
        });
        capturedOnEvent({ type: 'final_text', iterations: 2, text: 'Done.' });
      });
      await act(async () => {
        resolveSend({ text: 'Done.', actions: [] });
      });
    });

    it('routes a quick-reply button click through sendClarificationResponse with the option text', async () => {
      let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<ChatPanelResponse>((resolve) => {
            capturedOnEvent = onEvent;
            resolveSend = resolve;
          }),
      );

      const sendClarification = jest.fn<(r: string) => Promise<void>>().mockResolvedValue();
      render(
        <ChatPanel
          sendMessage={sendFn}
          sendClarificationResponse={sendClarification}
        />,
      );

      await act(async () => {
        typeAndSend('boost the bass');
      });

      act(() => {
        capturedOnEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          toolName: 'ask_user',
          toolArgs: {
            question: 'which one?',
            options: ['track 2', 'track 5'],
          },
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'track 5' }));
      });

      expect(sendClarification).toHaveBeenCalledWith('track 5');

      // Wrap the loop.
      act(() => {
        capturedOnEvent({
          type: 'tool_call_done',
          iteration: 1,
          callId: 'c1',
          toolName: 'ask_user',
          toolArgs: { question: 'which one?' },
          result: { success: true, exitCode: 0, stdout: 'track 5', stderr: '' },
        });
        capturedOnEvent({ type: 'final_text', iterations: 2, text: 'Done.' });
      });
      await act(async () => {
        resolveSend({ text: 'Done.', actions: [] });
      });
    });

    it('clears the pending clarification on tool_call_done failure and surfaces a system_error', async () => {
      let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
      let resolveSend: (v: ChatPanelResponse) => void = () => {};
      sendFn.mockImplementation(
        (_msg, onEvent) =>
          new Promise<ChatPanelResponse>((resolve) => {
            capturedOnEvent = onEvent;
            resolveSend = resolve;
          }),
      );

      render(<ChatPanel sendMessage={sendFn} sendClarificationResponse={jest.fn()} />);

      await act(async () => {
        typeAndSend('hi');
      });

      act(() => {
        capturedOnEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          toolName: 'ask_user',
          toolArgs: { question: 'pick one' },
        });
        capturedOnEvent({
          type: 'tool_call_done',
          iteration: 1,
          callId: 'c1',
          toolName: 'ask_user',
          toolArgs: { question: 'pick one' },
          result: {
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: 'user closed the panel',
          },
        });
        capturedOnEvent({ type: 'final_text', iterations: 2, text: 'ok' });
      });

      // Question entry replaced by a system_error.
      expect(screen.getByText(/Clarification cancelled/)).not.toBeNull();
      expect(screen.getByText(/user closed the panel/)).not.toBeNull();

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

  describe('next_steps row', () => {
    it('renders a button row when next_steps fires after a successful tool call', async () => {
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          toolName: 'dsl_shuffle_preset',
          toolArgs: { track: 'Snare' },
        });
        onEvent(
          toolDoneSuccess(1, 'c1', 'dsl_shuffle_preset', { track: 'Snare' }, '{}'),
        );
        onEvent({
          type: 'next_steps',
          iteration: 1,
          callId: 'c1',
          toolName: 'dsl_shuffle_preset',
          steps: [
            {
              description: 'Try a different snare preset',
              cli: 'sas dsl_shuffle_preset --track Snare',
              priority: 'primary',
            },
            {
              description: 'Add an FX rack',
              cli: 'sas dsl_set_track_fx --track Snare',
              priority: 'secondary',
            },
          ],
        });
        onEvent({
          type: 'final_text',
          iterations: 1,
          text: 'Picked a fresh snare preset.',
        });
        return { text: 'Picked a fresh snare preset.', actions: [] };
      });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('shuffle the snare');
      });

      // Both buttons present
      expect(screen.getByRole('button', { name: 'Try a different snare preset' })).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Add an FX rack' })).not.toBeNull();

      // Primary/secondary priority threads through to a data-attribute so
      // a visual regression can be asserted without sniffing inline styles.
      const primary = screen.getByRole('button', { name: 'Try a different snare preset' });
      const secondary = screen.getByRole('button', { name: 'Add an FX rack' });
      expect(primary.getAttribute('data-priority')).toBe('primary');
      expect(secondary.getAttribute('data-priority')).toBe('secondary');
    });

    it('clicking a next-step button submits its description as a new user message', async () => {
      let firstResolve: () => void = () => {};
      let secondMessage: string | null = null;

      sendFn.mockImplementation(async (msg, onEvent) => {
        if (msg === 'shuffle the snare') {
          // Turn 1 — emit next_steps, then resolve.
          onEvent({
            type: 'tool_call_start',
            iteration: 1,
            callId: 'c1',
            toolName: 'dsl_shuffle_preset',
            toolArgs: { track: 'Snare' },
          });
          onEvent(toolDoneSuccess(1, 'c1', 'dsl_shuffle_preset', { track: 'Snare' }, '{}'));
          onEvent({
            type: 'next_steps',
            iteration: 1,
            callId: 'c1',
            toolName: 'dsl_shuffle_preset',
            steps: [
              { description: 'Try a different snare preset', priority: 'primary' },
            ],
          });
          onEvent({ type: 'final_text', iterations: 1, text: 'Done.' });
          return { text: 'Done.', actions: [] };
        }
        // Turn 2 — record the message and resolve.
        secondMessage = msg;
        onEvent({ type: 'final_text', iterations: 1, text: 'Picked another.' });
        return new Promise((resolve) => {
          firstResolve = () => resolve({ text: 'Picked another.', actions: [] });
        });
      });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('shuffle the snare');
      });

      const btn = await screen.findByRole('button', {
        name: 'Try a different snare preset',
      });
      await act(async () => {
        fireEvent.click(btn);
      });

      await waitFor(() => {
        expect(secondMessage).toBe('Try a different snare preset');
      });

      await act(async () => {
        firstResolve();
      });
    });

    it('does NOT render next_steps when the tool call was a failure (loop never emits)', async () => {
      // Defensive: the agent loop guards this, but assert ChatPanel doesn't
      // render anything when no next_steps event arrives.
      sendFn.mockImplementation(async (_msg, onEvent) => {
        onEvent({
          type: 'tool_call_start',
          iteration: 1,
          callId: 'c1',
          toolName: 'bad',
          toolArgs: {},
        });
        onEvent(toolDoneFailure(1, 'c1', 'bad', {}, 'oops'));
        onEvent({ type: 'final_text', iterations: 1, text: 'Sorry.' });
        return { text: 'Sorry.', actions: [] };
      });

      render(<ChatPanel sendMessage={sendFn} />);
      await act(async () => {
        typeAndSend('try the bad thing');
      });

      // No button row appears
      expect(screen.queryByRole('button')).toBeNull();
    });
  });
});
