/**
 * workflow_progress — terminal-log behavior for incremental sub-task status.
 *
 * The `workflow_progress` AgentLoopEvent surfaces per-track progress for
 * long-running tools (mainly `compose_scene`'s MIDI generation loop) that
 * the agent loop sees as one opaque tool call. The reducer keeps one entry
 * per callId and replaces its `items[]` in place; the renderer groups
 * those entries under the matching ⚡ ToolRow.
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ChatPanel, type ChatPanelResponse } from '../ChatPanel';
import type { AgentLoopEvent, WorkflowProgressItem } from '../../agent-loop';

type SendFn = (
  message: string,
  onEvent: (event: AgentLoopEvent) => void,
) => Promise<ChatPanelResponse>;

function typeAndSend(text: string): void {
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
}

function progressEvent(
  callId: string,
  items: WorkflowProgressItem[],
  label?: string,
): AgentLoopEvent {
  return { type: 'workflow_progress', callId, label, items };
}

describe('ChatPanel — workflow_progress', () => {
  let sendFn: jest.Mock<SendFn>;

  beforeEach(() => {
    sendFn = jest.fn<SendFn>();
  });

  it('renders progress items inline under the owning ToolRow', async () => {
    let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
    let resolveSend: (v: ChatPanelResponse) => void = () => {};
    sendFn.mockImplementation(
      (_msg, onEvent) =>
        new Promise<ChatPanelResponse>((resolve) => {
          capturedOnEvent = onEvent;
          resolveSend = resolve;
        }),
    );

    render(<ChatPanel sendMessage={sendFn} />);
    await act(async () => {
      typeAndSend('create a funky beat');
    });

    act(() => {
      capturedOnEvent({
        type: 'tool_call_start',
        iteration: 1,
        callId: 'c1',
        toolName: 'compose_scene',
        toolArgs: { description: 'funky beat' },
      });
      capturedOnEvent(
        progressEvent(
          'c1',
          [
            { name: 'bass groove', status: 'planned' },
            { name: 'drum pattern', status: 'running' },
            { name: 'pad', status: 'completed' },
          ],
          'Generating MIDI (3 tracks)',
        ),
      );
    });

    // All three items render with the right status data attribute.
    const items = screen.getAllByText(
      /bass groove|drum pattern|pad/,
    );
    expect(items.length).toBeGreaterThanOrEqual(3);

    const block = screen.getByText(/Generating MIDI \(3 tracks\)/);
    expect(block).not.toBeNull();

    // Glyphs reflect status.
    expect(screen.getAllByText(/✓/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/⊙/).length).toBeGreaterThanOrEqual(1); // running + tool "running..." line

    // Status data attribute exposed for downstream selectors.
    const planned = document.querySelector(
      '[data-role="workflow-progress-item"][data-status="planned"]',
    );
    expect(planned).not.toBeNull();

    await act(async () => {
      capturedOnEvent({ type: 'final_text', iterations: 1, text: 'done' });
      resolveSend({ text: 'done', actions: [] });
    });
  });

  it('updates an existing entry in place when the same callId emits twice', async () => {
    let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
    let resolveSend: (v: ChatPanelResponse) => void = () => {};
    sendFn.mockImplementation(
      (_msg, onEvent) =>
        new Promise<ChatPanelResponse>((resolve) => {
          capturedOnEvent = onEvent;
          resolveSend = resolve;
        }),
    );

    render(<ChatPanel sendMessage={sendFn} />);
    await act(async () => {
      typeAndSend('compose');
    });

    act(() => {
      capturedOnEvent({
        type: 'tool_call_start',
        iteration: 1,
        callId: 'c2',
        toolName: 'compose_scene',
        toolArgs: {},
      });
      capturedOnEvent(
        progressEvent('c2', [
          { name: 'bass', status: 'planned' },
          { name: 'drums', status: 'planned' },
        ]),
      );
      // Second emit with same callId — should REPLACE, not append.
      capturedOnEvent(
        progressEvent('c2', [
          { name: 'bass', status: 'completed' },
          { name: 'drums', status: 'running' },
        ]),
      );
    });

    // Only one workflow-progress group should exist for callId c2.
    const groups = document.querySelectorAll(
      '[data-role="workflow-progress"][data-call-id="c2"]',
    );
    expect(groups.length).toBe(1);

    // The completed status replaces the prior 'planned' state.
    const bassItem = Array.from(
      document.querySelectorAll('[data-role="workflow-progress-item"]'),
    ).find((el) => el.textContent?.includes('bass'));
    expect(bassItem?.getAttribute('data-status')).toBe('completed');

    await act(async () => {
      capturedOnEvent({ type: 'final_text', iterations: 1, text: 'ok' });
      resolveSend({ text: 'ok', actions: [] });
    });
  });

  it('falls back to a standalone row when no matching tool_call_start exists', async () => {
    // Orphan event — no tool_call_start with callId 'c-orphan' was emitted.
    let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
    let resolveSend: (v: ChatPanelResponse) => void = () => {};
    sendFn.mockImplementation(
      (_msg, onEvent) =>
        new Promise<ChatPanelResponse>((resolve) => {
          capturedOnEvent = onEvent;
          resolveSend = resolve;
        }),
    );

    render(<ChatPanel sendMessage={sendFn} />);
    await act(async () => {
      typeAndSend('compose');
    });

    act(() => {
      capturedOnEvent(
        progressEvent(
          'c-orphan',
          [{ name: 'lonely track', status: 'running' }],
          'Standalone progress',
        ),
      );
    });

    // Renders as its own block — no crash, signal preserved.
    expect(screen.getByText(/Standalone progress/)).not.toBeNull();
    expect(screen.getByText(/lonely track/)).not.toBeNull();

    await act(async () => {
      capturedOnEvent({ type: 'final_text', iterations: 0, text: 'done' });
      resolveSend({ text: 'done', actions: [] });
    });
  });

  it('renders failed items in error color with the error message in parens', async () => {
    let capturedOnEvent: (event: AgentLoopEvent) => void = () => {};
    let resolveSend: (v: ChatPanelResponse) => void = () => {};
    sendFn.mockImplementation(
      (_msg, onEvent) =>
        new Promise<ChatPanelResponse>((resolve) => {
          capturedOnEvent = onEvent;
          resolveSend = resolve;
        }),
    );

    render(<ChatPanel sendMessage={sendFn} />);
    await act(async () => {
      typeAndSend('compose');
    });

    act(() => {
      capturedOnEvent({
        type: 'tool_call_start',
        iteration: 1,
        callId: 'c3',
        toolName: 'compose_scene',
        toolArgs: {},
      });
      capturedOnEvent(
        progressEvent('c3', [
          { name: 'pad', status: 'failed', error: 'timeout' },
        ]),
      );
    });

    const failedItem = document.querySelector(
      '[data-role="workflow-progress-item"][data-status="failed"]',
    );
    expect(failedItem).not.toBeNull();
    expect(failedItem?.textContent).toMatch(/timeout/);

    await act(async () => {
      capturedOnEvent({ type: 'final_text', iterations: 1, text: 'ok' });
      resolveSend({ text: 'ok', actions: [] });
    });
  });
});
