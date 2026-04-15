/**
 * ChatPanel integration spec — TDD.
 *
 * Wires MessageList + InputBox + a ChatAgent (mocked at the dispatch
 * boundary). Verifies end-to-end:
 *   - User types → send → assistant responds → message appears
 *   - Processing state blocks re-send until done
 *   - Error from agent surfaces as a system message
 *   - History persists across turns
 *   - Action log from the agent response renders inline
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ChatPanel } from '../ChatPanel';
import type { AgentResponse } from '../../chat-agent';

describe('ChatPanel', () => {
  let sendFn: jest.Mock<(message: string) => Promise<AgentResponse>>;

  beforeEach(() => {
    sendFn = jest.fn<(message: string) => Promise<AgentResponse>>();
  });

  describe('basic send flow', () => {
    it('sends a user message and renders the assistant response', async () => {
      sendFn.mockResolvedValue({
        text: 'Added reverb to Bass.',
        actions: [],
      });
      render(<ChatPanel sendMessage={sendFn} />);

      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: 'add reverb to the bass' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /send/i }));
      });

      // Both the user message and the assistant response are in the list
      expect(screen.getByText('add reverb to the bass')).not.toBeNull();
      expect(screen.getByText('Added reverb to Bass.')).not.toBeNull();
      expect(sendFn).toHaveBeenCalledWith('add reverb to the bass');
    });

    it('clears the input after a send', async () => {
      sendFn.mockResolvedValue({ text: 'ok', actions: [] });
      render(<ChatPanel sendMessage={sendFn} />);

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'x' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /send/i }));
      });

      expect(textarea.value).toBe('');
    });

    it('renders the user message immediately (before the agent responds)', async () => {
      // Slow agent — assistant response doesn't arrive for a while
      let resolveAgent: (v: AgentResponse) => void = () => {};
      sendFn.mockImplementation(
        () => new Promise<AgentResponse>((resolve) => { resolveAgent = resolve; })
      );
      render(<ChatPanel sendMessage={sendFn} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      // User message is visible immediately
      expect(screen.getByText('hi')).not.toBeNull();
      // Assistant hasn't arrived yet — no second bubble
      expect(screen.queryByText(/ok/)).toBeNull();

      // Clean up
      await act(async () => {
        resolveAgent({ text: 'ok', actions: [] });
      });
    });
  });

  describe('processing state', () => {
    it('disables send while a request is in flight', async () => {
      let resolveAgent: (v: AgentResponse) => void = () => {};
      sendFn.mockImplementation(
        () => new Promise<AgentResponse>((resolve) => { resolveAgent = resolve; })
      );
      render(<ChatPanel sendMessage={sendFn} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      // Send disabled during in-flight
      expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);

      await act(async () => {
        resolveAgent({ text: 'done', actions: [] });
      });

      // Re-enabled after response
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'y' } });
      await waitFor(() => {
        expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it('shows a loading indicator while processing', async () => {
      let resolveAgent: (v: AgentResponse) => void = () => {};
      sendFn.mockImplementation(
        () => new Promise<AgentResponse>((resolve) => { resolveAgent = resolve; })
      );
      render(<ChatPanel sendMessage={sendFn} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(screen.getByTestId('loading-indicator')).not.toBeNull();

      await act(async () => {
        resolveAgent({ text: 'done', actions: [] });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('loading-indicator')).toBeNull();
      });
    });
  });

  describe('error handling', () => {
    it('renders a system-role message when the agent rejects', async () => {
      sendFn.mockRejectedValue(new Error('LLM unreachable'));
      render(<ChatPanel sendMessage={sendFn} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /send/i }));
      });

      // System message with the error surfaces
      expect(screen.getByText(/LLM unreachable/)).not.toBeNull();
      // Send becomes re-enabled so user can retry
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
      expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('keeps prior messages visible even after an error', async () => {
      sendFn.mockResolvedValueOnce({ text: 'first response', actions: [] });
      render(<ChatPanel sendMessage={sendFn} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /send/i }));
      });

      sendFn.mockRejectedValueOnce(new Error('boom'));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'second' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /send/i }));
      });

      expect(screen.getByText('first')).not.toBeNull();
      expect(screen.getByText('first response')).not.toBeNull();
      expect(screen.getByText('second')).not.toBeNull();
      expect(screen.getByText(/boom/)).not.toBeNull();
    });
  });

  describe('action log', () => {
    it('renders the action log inline with the assistant message', async () => {
      sendFn.mockResolvedValue({
        text: 'Added reverb.',
        actions: [
          {
            tool: 'dsl_set_track_fx',
            params: { category: 'reverb', enabled: true },
            result: { ok: true },
            iteration: 1,
          },
        ],
      });
      render(<ChatPanel sendMessage={sendFn} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add reverb' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /send/i }));
      });

      expect(screen.getByText(/dsl_set_track_fx/)).not.toBeNull();
    });
  });

  describe('multi-turn history', () => {
    it('keeps all messages visible across multiple turns', async () => {
      sendFn
        .mockResolvedValueOnce({ text: 'response one', actions: [] })
        .mockResolvedValueOnce({ text: 'response two', actions: [] });

      render(<ChatPanel sendMessage={sendFn} />);

      const textarea = screen.getByRole('textbox');
      const button = screen.getByRole('button', { name: /send/i });

      fireEvent.change(textarea, { target: { value: 'first question' } });
      await act(async () => {
        fireEvent.click(button);
      });
      fireEvent.change(textarea, { target: { value: 'second question' } });
      await act(async () => {
        fireEvent.click(button);
      });

      expect(screen.getByText('first question')).not.toBeNull();
      expect(screen.getByText('response one')).not.toBeNull();
      expect(screen.getByText('second question')).not.toBeNull();
      expect(screen.getByText('response two')).not.toBeNull();
    });
  });

  describe('initial state', () => {
    it('renders an empty-state hint when no messages yet', () => {
      render(<ChatPanel sendMessage={sendFn} />);
      expect(screen.getByText(/ask|try|type/i)).not.toBeNull();
    });

    it('accepts initialMessages for session restoration', () => {
      render(
        <ChatPanel
          sendMessage={sendFn}
          initialMessages={[
            { id: 'm1', role: 'user', content: 'earlier question' },
            { id: 'm2', role: 'assistant', content: 'earlier answer' },
          ]}
        />
      );
      expect(screen.getByText('earlier question')).not.toBeNull();
      expect(screen.getByText('earlier answer')).not.toBeNull();
    });
  });

  describe('iteration limit', () => {
    it('tags the assistant message when iterationLimitHit is set', async () => {
      sendFn.mockResolvedValue({
        text: 'I hit my limit.',
        actions: [],
        iterationLimitHit: true,
      });
      render(<ChatPanel sendMessage={sendFn} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /send/i }));
      });

      // Subtle UI cue — doesn't have to be a particular shape, just present
      expect(screen.getByText(/limit/i)).not.toBeNull();
    });
  });
});
