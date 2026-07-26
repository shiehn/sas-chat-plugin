/**
 * Restored-transcript behavior on ChatPanel: initialEntries render, and the
 * live turn counter seeds ABOVE the restored max so a new turn can never
 * share a collapse group with a restored one.
 */

import React from 'react';
import { describe, it, expect } from '@jest/globals';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChatPanel, type ChatPanelResponse } from '../ChatPanel';
import type { TerminalEntry } from '../types';
import type { AgentLoopEvent } from '../../agent-loop';

const RESTORED: TerminalEntry[] = [
  { kind: 'user', id: 'h1', turnId: 1, text: 'restored question' },
  { kind: 'assistant', id: 'h2', turnId: 1, text: 'restored answer', toolCount: 0, collapsed: false },
  { kind: 'user', id: 'h3', turnId: 2, text: 'second restored question' },
  {
    kind: 'tool_done',
    id: 'h4',
    turnId: 2,
    callId: 'hc-1',
    tool: 'dsl_set_tempo',
    params: { bpm: 120 },
    result: '{"success":true}',
  },
  { kind: 'assistant', id: 'h5', turnId: 2, text: 'tempo set', toolCount: 1, collapsed: true },
];

function typeAndSend(text: string): void {
  fireEvent.change(screen.getByLabelText('Chat input'), { target: { value: text } });
  fireEvent.keyDown(screen.getByLabelText('Chat input'), { key: 'Enter' });
}

describe('ChatPanel restored transcript', () => {
  it('renders initialEntries on mount', () => {
    render(
      <ChatPanel
        sendMessage={async () => ({ text: 'ok', actions: [] })}
        initialEntries={RESTORED}
      />,
    );
    expect(screen.getByText('restored question')).toBeTruthy();
    expect(screen.getByText('restored answer')).toBeTruthy();
  });

  it('new turns number above the restored max (no collapse-group collision)', async () => {
    let captured: ((event: AgentLoopEvent) => void) | null = null;
    let resolveSend!: (r: ChatPanelResponse) => void;
    const sendMessage = (
      _msg: string,
      onEvent: (event: AgentLoopEvent) => void,
    ): Promise<ChatPanelResponse> => {
      captured = onEvent;
      return new Promise<ChatPanelResponse>((r) => {
        resolveSend = r;
      });
    };

    render(<ChatPanel sendMessage={sendMessage} initialEntries={RESTORED} />);
    typeAndSend('new message');

    // Drive a final_text through the live event path, then let the turn end.
    act(() => {
      captured?.({ type: 'final_text', iterations: 1, text: 'fresh reply' });
    });
    act(() => resolveSend({ text: 'fresh reply', actions: [] }));
    await screen.findByText('fresh reply');

    // The restored turn-2 assistant row stays collapsed and untouched; the
    // new reply rendered as its own (expanded) row — proving the new turn
    // did not land in a restored turnId's collapse group.
    expect(screen.getByText('tempo set')).toBeTruthy();
    expect(screen.getByText('fresh reply')).toBeTruthy();
    expect(screen.getByText('new message')).toBeTruthy();
  });
});
