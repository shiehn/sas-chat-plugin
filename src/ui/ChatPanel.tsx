/**
 * ChatPanel — top-level terminal-style chat UI.
 *
 * Owns the running TerminalEntry[] log. Subscribes to ChatAgentEvents while
 * a turn is in flight and appends/updates entries line-by-line. Once the
 * final assistant text lands, all tool entries for that turn collapse to a
 * one-line summary that the user can click to re-expand.
 *
 * Props:
 *   - sendMessage: async fn that handles a user message. Receives an
 *     onEvent callback; call it synchronously as the agent loop makes
 *     progress. Returns the final AgentResponse.
 *   - registerReset: optional hook the host can use to clear the log
 *     when the scene changes (chat is scene-scoped).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { InputBox } from './InputBox';
import { TerminalLog } from './TerminalLog';
import type { TerminalEntry } from './types';
import type { AgentLoopEvent } from '../agent-loop';

/** Final response shape returned by the renderer-side bridge. */
export interface ChatPanelResponse {
  text: string;
  actions: AgentLoopEvent[];
}

export interface ChatPanelProps {
  sendMessage: (
    message: string,
    onEvent: (event: AgentLoopEvent) => void
  ) => Promise<ChatPanelResponse>;
  initialEntries?: TerminalEntry[];
  registerReset?: (reset: () => void) => void;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `e${idCounter}-${Date.now()}`;
}

const BLINK_STYLE_ID = 'sas-chat-blink-style';

function ensureBlinkStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(BLINK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = BLINK_STYLE_ID;
  style.textContent = `
    @keyframes sas-chat-blink {
      0%, 49% { opacity: 0.85; }
      50%, 100% { opacity: 0.15; }
    }
    .sas-chat-blink {
      animation: sas-chat-blink 1s steps(2, start) infinite;
    }
  `;
  document.head.appendChild(style);
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  sendMessage,
  initialEntries = [],
  registerReset,
}) => {
  const [entries, setEntries] = useState<TerminalEntry[]>(initialEntries);
  const [isProcessing, setIsProcessing] = useState(false);
  const turnCounterRef = useRef(0);

  useEffect(() => {
    ensureBlinkStyle();
  }, []);

  useEffect(() => {
    if (!registerReset) return;
    registerReset(() => {
      setEntries([]);
      setIsProcessing(false);
    });
  }, [registerReset]);

  const handleToggleTurn = useCallback((turnId: number): void => {
    setEntries((prev) =>
      prev.map((e) =>
        e.kind === 'assistant' && e.turnId === turnId
          ? { ...e, collapsed: !e.collapsed }
          : e
      )
    );
  }, []);

  const handleSend = useCallback(
    async (text: string): Promise<void> => {
      turnCounterRef.current += 1;
      const turnId = turnCounterRef.current;
      const userEntry: TerminalEntry = {
        kind: 'user',
        id: nextId(),
        turnId,
        text,
      };
      setEntries((prev) => [...prev, userEntry]);
      setIsProcessing(true);

      const onEvent = (event: AgentLoopEvent): void => {
        setEntries((prev) => applyEvent(prev, event, turnId));
      };

      try {
        await sendMessage(text, onEvent);
        // Final text already appended by the `final_text` event.
        // Collapse this turn's tool entries now that the turn is done.
        setEntries((prev) => collapseTurn(prev, turnId));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errorEntry: TerminalEntry = {
          kind: 'system_error',
          id: nextId(),
          turnId,
          text: msg,
        };
        setEntries((prev) => [...prev, errorEntry]);
      } finally {
        setIsProcessing(false);
      }
    },
    [sendMessage]
  );

  return (
    <div
      data-testid="chat-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 300,
        background: 'transparent',
      }}
    >
      <TerminalLog
        entries={entries}
        isProcessing={isProcessing}
        onToggleTurn={handleToggleTurn}
      />
      <InputBox onSend={handleSend} disabled={isProcessing} />
    </div>
  );
};

// -----------------------------------------------------------------------------
// State transitions
// -----------------------------------------------------------------------------

function applyEvent(
  entries: TerminalEntry[],
  event: AgentLoopEvent,
  turnId: number
): TerminalEntry[] {
  switch (event.type) {
    case 'tool_call_start':
      return [
        ...entries,
        {
          kind: 'tool_pending',
          id: nextId(),
          turnId,
          callId: event.callId,
          tool: event.toolName,
          params: event.toolArgs,
        },
      ];

    case 'tool_call_done': {
      // The agent loop returns a structured `ToolExecutionResult` for both
      // success and failure (it only feeds back synthetic failures when the
      // subprocess truly couldn't run). We map success → `result` (the
      // captured stdout) and non-success → `error` (stderr). The terminal
      // entry shape predates this and uses both fields side-by-side.
      const isFailure = !event.result.success;
      const errorText =
        event.result.stderr.length > 0
          ? event.result.stderr
          : event.result.stdout.length > 0
            ? event.result.stdout
            : `Tool exited with code ${event.result.exitCode}`;
      return entries.map((e) =>
        e.kind === 'tool_pending' &&
        e.turnId === turnId &&
        e.callId === event.callId
          ? {
              kind: 'tool_done',
              id: e.id,
              turnId,
              callId: event.callId,
              tool: event.toolName,
              params: event.toolArgs,
              result: isFailure ? undefined : event.result.stdout,
              error: isFailure ? errorText : undefined,
            }
          : e
      );
    }

    case 'final_text': {
      const toolCount = entries.filter(
        (e) =>
          (e.kind === 'tool_done' || e.kind === 'tool_pending') &&
          e.turnId === turnId
      ).length;
      return [
        ...entries,
        {
          kind: 'assistant',
          id: nextId(),
          turnId,
          text: event.text,
          toolCount,
          collapsed: false,
        },
      ];
    }

    case 'iteration_limit':
      return entries.map((e) =>
        e.kind === 'assistant' && e.turnId === turnId
          ? { ...e, iterationLimitHit: true }
          : e
      );
  }
}

function collapseTurn(entries: TerminalEntry[], turnId: number): TerminalEntry[] {
  const hadError = entries.some(
    (e) => e.kind === 'tool_done' && e.turnId === turnId && e.error !== undefined
  );
  // Turns with errors stay expanded so the user can see what went wrong.
  if (hadError) return entries;
  return entries.map((e) =>
    e.kind === 'assistant' && e.turnId === turnId && e.toolCount > 0
      ? { ...e, collapsed: true }
      : e
  );
}
