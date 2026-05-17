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
  /**
   * Routes the user's reply to a pending `ask_user` clarification back to
   * the main-process agent loop. When omitted, the synthetic `ask_user`
   * tool is treated as a normal tool row (no input routing) — useful in
   * tests and out-of-Electron contexts.
   */
  sendClarificationResponse?: (response: string) => Promise<void>;
  initialEntries?: TerminalEntry[];
  registerReset?: (reset: () => void) => void;
  /**
   * Whether the host accordion section is currently expanded. Forwarded
   * to InputBox so the textarea re-focuses on open. Undefined in
   * non-accordion hosts (tests, stories) → legacy mount-only focus.
   */
  isExpanded?: boolean;
}

/** Synthetic tool name the agent loop emits when the model calls ask_user. */
const ASK_USER_TOOL_NAME = 'ask_user';

interface PendingClarification {
  callId: string;
  turnId: number;
  question: string;
  options?: readonly string[];
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
  sendClarificationResponse,
  initialEntries = [],
  registerReset,
  isExpanded,
}) => {
  const [entries, setEntries] = useState<TerminalEntry[]>(initialEntries);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pendingClarification, setPendingClarification] =
    useState<PendingClarification | null>(null);
  const pendingClarificationRef = useRef<PendingClarification | null>(null);
  const turnCounterRef = useRef(0);

  useEffect(() => {
    pendingClarificationRef.current = pendingClarification;
  }, [pendingClarification]);

  useEffect(() => {
    ensureBlinkStyle();
  }, []);

  useEffect(() => {
    if (!registerReset) return;
    registerReset(() => {
      setEntries([]);
      setIsProcessing(false);
      setPendingClarification(null);
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

  const submitClarification = useCallback(
    async (response: string, pending: PendingClarification): Promise<void> => {
      // Optimistically render the user's reply as a "user" row so the
      // visual sequence matches a normal turn, then clear the pending slot
      // immediately so the input box re-disables until the loop resumes
      // and the next event arrives.
      setEntries((prev) => [
        ...prev,
        {
          kind: 'user',
          id: nextId(),
          turnId: pending.turnId,
          text: response,
        },
      ]);
      setPendingClarification(null);
      if (!sendClarificationResponse) {
        // Defensive: caller didn't wire the bridge. Surface a clear error
        // rather than silently dropping the response.
        setEntries((prev) => [
          ...prev,
          {
            kind: 'system_error',
            id: nextId(),
            turnId: pending.turnId,
            text:
              'Clarification bridge unavailable — restart the app or reopen the chat panel.',
          },
        ]);
        return;
      }
      try {
        await sendClarificationResponse(response);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setEntries((prev) => [
          ...prev,
          {
            kind: 'system_error',
            id: nextId(),
            turnId: pending.turnId,
            text: msg,
          },
        ]);
      }
    },
    [sendClarificationResponse]
  );

  const handleSend = useCallback(
    async (text: string): Promise<void> => {
      // Pending clarification takes priority — route the message back into
      // the in-flight loop instead of starting a new turn.
      const pending = pendingClarificationRef.current;
      if (pending) {
        await submitClarification(text, pending);
        return;
      }

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
        // Track the pending-clarification side-effect outside the entries
        // reducer so React's strict-mode double-invoke can't double-fire it.
        if (
          event.type === 'tool_call_start' &&
          event.toolName === ASK_USER_TOOL_NAME
        ) {
          const question =
            typeof event.toolArgs.question === 'string'
              ? event.toolArgs.question
              : '';
          const optionsRaw = event.toolArgs.options;
          const options = Array.isArray(optionsRaw)
            ? optionsRaw.filter((o): o is string => typeof o === 'string')
            : undefined;
          setPendingClarification({
            callId: event.callId,
            turnId,
            question,
            options: options && options.length > 0 ? options : undefined,
          });
        } else if (
          event.type === 'tool_call_done' &&
          event.toolName === ASK_USER_TOOL_NAME
        ) {
          // Loop has resumed — clear any lingering pending state. The
          // optimistic clear in submitClarification usually handles this,
          // but a cancellation path (executor rejected) could land here
          // without a user reply.
          setPendingClarification((prev) =>
            prev && prev.callId === event.callId ? null : prev,
          );
        }
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
        // Belt-and-suspenders: if the loop unwound while a clarification
        // was still showing, drop it so the input box returns to its
        // normal mode.
        setPendingClarification(null);
      }
    },
    [sendMessage, submitClarification]
  );

  const handleQuickReply = useCallback(
    (response: string): void => {
      const pending = pendingClarificationRef.current;
      if (!pending) return;
      void submitClarification(response, pending);
    },
    [submitClarification]
  );

  const handleNextStep = useCallback(
    (description: string): void => {
      // Submit the next-step's description as a new user message. The LLM
      // sees the suggestion it just made in conversation history and picks
      // the matching tool naturally. No-op while a turn is in flight — the
      // AgentLoop would reject a concurrent run() anyway.
      if (isProcessing) return;
      void handleSend(description);
    },
    [isProcessing, handleSend]
  );

  // Input box is disabled during processing UNLESS we're waiting on the
  // user's clarification — that's the one moment mid-turn the user is
  // expected to type.
  const inputDisabled = isProcessing && pendingClarification === null;

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
        onQuickReply={handleQuickReply}
        onNextStep={handleNextStep}
      />
      <InputBox
        onSend={handleSend}
        disabled={inputDisabled}
        isExpanded={isExpanded}
        placeholder={
          pendingClarification
            ? 'answer the question above — Enter to send'
            : undefined
        }
      />
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
    case 'llm_call_start': {
      // One thinking row at a time per turn — if one already exists for this
      // turn, leave it (avoids stacking up rows when start fires multiple
      // times before end).
      const hasThinking = entries.some(
        (e) => e.kind === 'thinking' && e.turnId === turnId
      );
      if (hasThinking) return entries;
      return [
        ...entries,
        { kind: 'thinking', id: nextId(), turnId },
      ];
    }

    case 'llm_call_end':
      return removeThinking(entries, turnId);

    case 'tool_call_start': {
      // Defensive: if llm_call_end was lost mid-flight, the thinking row
      // would otherwise hang around once a tool starts. Strip it now.
      const cleaned = removeThinking(entries, turnId);
      if (event.toolName === ASK_USER_TOOL_NAME) {
        // Synthetic clarification path — render a styled question entry
        // instead of a generic tool row. The args carry { question, options? }.
        const question =
          typeof event.toolArgs.question === 'string'
            ? event.toolArgs.question
            : '';
        const optionsRaw = event.toolArgs.options;
        const options = Array.isArray(optionsRaw)
          ? optionsRaw.filter((o): o is string => typeof o === 'string')
          : undefined;
        return [
          ...cleaned,
          {
            kind: 'clarification_pending',
            id: nextId(),
            turnId,
            callId: event.callId,
            question,
            options: options && options.length > 0 ? options : undefined,
          },
        ];
      }
      return [
        ...cleaned,
        {
          kind: 'tool_pending',
          id: nextId(),
          turnId,
          callId: event.callId,
          tool: event.toolName,
          params: event.toolArgs,
        },
      ];
    }

    case 'tool_progress':
      return [
        ...entries,
        {
          kind: 'tool_output_line',
          id: nextId(),
          turnId,
          callId: event.callId,
          stream: event.stream,
          text: event.line,
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
      if (event.toolName === ASK_USER_TOOL_NAME) {
        // Convert the styled pending entry into a resolved one. On success,
        // stdout carries the user's response. On failure (cancellation or
        // missing transport) emit a system_error so the user sees what
        // happened.
        if (isFailure) {
          return [
            ...entries.filter(
              (e) =>
                !(
                  e.kind === 'clarification_pending' &&
                  e.turnId === turnId &&
                  e.callId === event.callId
                ),
            ),
            {
              kind: 'system_error',
              id: nextId(),
              turnId,
              text: `Clarification cancelled: ${errorText}`,
            },
          ];
        }
        return entries.map((e) =>
          e.kind === 'clarification_pending' &&
          e.turnId === turnId &&
          e.callId === event.callId
            ? {
                kind: 'clarification_resolved',
                id: e.id,
                turnId,
                callId: event.callId,
                question: e.question,
                response: event.result.stdout,
              }
            : e,
        );
      }
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
      const cleaned = removeThinking(entries, turnId);
      const toolCount = cleaned.filter(
        (e) =>
          (e.kind === 'tool_done' || e.kind === 'tool_pending') &&
          e.turnId === turnId
      ).length;
      return [
        ...cleaned,
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

    case 'next_steps':
      // Append a row of clickable follow-up affordances. The row persists
      // across turn collapse — see the visibleEntries filter in TerminalLog.
      return [
        ...entries,
        {
          kind: 'next_steps',
          id: nextId(),
          turnId,
          callId: event.callId,
          steps: event.steps,
        },
      ];

    case 'workflow_progress': {
      // Update-in-place by callId — items[] is a full snapshot every emit,
      // so we just replace it. If no row exists yet (first emit), append a
      // new one. Late events whose callId never matched a tool_call_start
      // still create a fallback row so we don't drop the signal.
      const idx = entries.findIndex(
        (e) =>
          e.kind === 'workflow_progress' &&
          e.turnId === turnId &&
          e.callId === event.callId,
      );
      if (idx >= 0) {
        return entries.map((e, i) =>
          i === idx && e.kind === 'workflow_progress'
            ? { ...e, items: event.items, label: event.label ?? e.label }
            : e,
        );
      }
      return [
        ...entries,
        {
          kind: 'workflow_progress',
          id: nextId(),
          turnId,
          callId: event.callId,
          label: event.label,
          items: event.items,
        },
      ];
    }

    case 'iteration_limit':
      return removeThinking(entries, turnId).map((e) =>
        e.kind === 'assistant' && e.turnId === turnId
          ? { ...e, iterationLimitHit: true }
          : e
      );
  }
}

function removeThinking(entries: TerminalEntry[], turnId: number): TerminalEntry[] {
  return entries.filter((e) => !(e.kind === 'thinking' && e.turnId === turnId));
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
