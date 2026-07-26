/**
 * Stop-button affordance on ChatPanel.
 *
 * Contract: the button exists ONLY while a turn is processing AND the host
 * provided an onStop callback (older preloads without the stop channel get
 * no dead button). Clicking calls onStop once and flips to a disabled
 * "stopping…" state until the turn unwinds.
 */

import React from 'react';
import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatPanel, type ChatPanelResponse } from '../ChatPanel';

function deferred(): {
  promise: Promise<ChatPanelResponse>;
  resolve: (r: ChatPanelResponse) => void;
} {
  let resolve!: (r: ChatPanelResponse) => void;
  const promise = new Promise<ChatPanelResponse>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function typeAndSend(text: string): void {
  fireEvent.change(screen.getByLabelText('Chat input'), { target: { value: text } });
  fireEvent.keyDown(screen.getByLabelText('Chat input'), { key: 'Enter' });
}

describe('ChatPanel stop button', () => {
  it('is absent while idle and absent when onStop is not provided', () => {
    const { rerender } = render(
      <ChatPanel sendMessage={async () => ({ text: 'ok', actions: [] })} onStop={() => undefined} />,
    );
    expect(screen.queryByTestId('chat-stop-button')).toBeNull();

    // Processing but NO onStop → still absent (no dead affordance).
    const d = deferred();
    rerender(<ChatPanel sendMessage={() => d.promise} />);
    typeAndSend('go');
    expect(screen.queryByTestId('chat-stop-button')).toBeNull();
    act(() => d.resolve({ text: 'done', actions: [] }));
  });

  it('appears while processing, calls onStop once, and shows stopping…', async () => {
    const d = deferred();
    const onStop = jest.fn();
    render(<ChatPanel sendMessage={() => d.promise} onStop={onStop} />);

    typeAndSend('long task');
    const button = await screen.findByTestId('chat-stop-button');
    expect(button.textContent).toContain('stop');

    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(button.textContent).toContain('stopping…');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // Double-click can't re-fire while stopping.
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledTimes(1);

    // Turn unwinds (loop returned its aborted final text) → button gone.
    act(() => d.resolve({ text: '⏹ Stopped.', actions: [] }));
    await waitFor(() => expect(screen.queryByTestId('chat-stop-button')).toBeNull());
  });

  it('resets the stopping state for the next turn', async () => {
    const first = deferred();
    const second = deferred();
    let call = 0;
    const onStop = jest.fn();
    render(
      <ChatPanel
        sendMessage={() => {
          call += 1;
          return call === 1 ? first.promise : second.promise;
        }}
        onStop={onStop}
      />,
    );

    typeAndSend('turn one');
    fireEvent.click(await screen.findByTestId('chat-stop-button'));
    act(() => first.resolve({ text: '⏹ Stopped.', actions: [] }));
    await waitFor(() => expect(screen.queryByTestId('chat-stop-button')).toBeNull());

    typeAndSend('turn two');
    const button = await screen.findByTestId('chat-stop-button');
    expect(button.textContent).toContain('■ stop');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    act(() => second.resolve({ text: 'done', actions: [] }));
  });
});
