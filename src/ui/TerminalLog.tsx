/**
 * TerminalLog — scrollable tail-style log of TerminalEntry rows.
 *
 * Visual grammar:
 *   > user prompt                         (bright, prefix in accent)
 *     ⚡ tool_name {params}                (accent glyph)
 *     ↳ result summary                    (muted; red if error)
 *     assistant final text                (inherits theme)
 *     ▸ N tool calls  (click to expand)   (dim one-liner, collapsible)
 *
 * Auto-sticks to bottom only when the user is already scrolled to the
 * bottom — matches tail -f behavior.
 */

import React, { useEffect, useRef } from 'react';
import type { TerminalEntry } from './types';
import { formatParams, formatResult } from './format-result';

const FONT = 'JetBrains Mono, SF Mono, Menlo, Monaco, Consolas, monospace';

const COLOR = {
  prompt: '#6AF2C5',
  user: '#F7FFFB',
  glyph: '#6AF2C5',
  muted: '#AAB8C7',
  error: '#FF5C7A',
  /** Subtle accent for clarification questions — distinct from the
   *  green "user prompt" color so the user notices the model is waiting
   *  on them, but quieter than the error red. */
  question: '#FFD074',
} as const;

export interface TerminalLogProps {
  entries: TerminalEntry[];
  isProcessing: boolean;
  onToggleTurn: (turnId: number) => void;
  /** Invoked when the user clicks a quick-reply button on a pending
   *  clarification. The string is the chosen option text. Optional —
   *  when omitted, buttons render but do nothing (test/SSR contexts). */
  onQuickReply?: (response: string) => void;
  /** Invoked when the user clicks a next-step button on a `next_steps`
   *  row. The string is the chosen step's `description` — ChatPanel
   *  submits it as a new user message. Optional. */
  onNextStep?: (description: string) => void;
}

export const TerminalLog: React.FC<TerminalLogProps> = ({
  entries,
  isProcessing,
  onToggleTurn,
  onQuickReply,
  onNextStep,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  const handleScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasAtBottomRef.current = distance < 40;
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries, isProcessing]);

  const collapsedTurns = new Set<number>();
  for (const e of entries) {
    if (e.kind === 'assistant' && e.collapsed && e.toolCount > 0) {
      collapsedTurns.add(e.turnId);
    }
  }

  // Group tool_output_line entries by their tool's callId so the ToolRow
  // can render them inline between the ⚡ header and the ↳ result. Without
  // this, output lines visually appear AFTER the result (because tool_done
  // replaces tool_pending in-place at the original array slot, while
  // output_line entries are appended later).
  const outputLinesByCallId = new Map<
    string,
    Array<Extract<TerminalEntry, { kind: 'tool_output_line' }>>
  >();
  for (const e of entries) {
    if (e.kind === 'tool_output_line') {
      const list = outputLinesByCallId.get(e.callId) ?? [];
      list.push(e);
      outputLinesByCallId.set(e.callId, list);
    }
  }

  const visibleEntries = entries.filter((e) => {
    // Output lines never render at their natural array position — the
    // owning ToolRow inlines them.
    if (e.kind === 'tool_output_line') return false;
    if (e.kind !== 'tool_pending' && e.kind !== 'tool_done') return true;
    return !collapsedTurns.has(e.turnId);
  });

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      data-testid="terminal-log"
      style={{
        flex: 1,
        overflowY: 'auto',
        fontFamily: FONT,
        fontSize: 13,
        lineHeight: 1.5,
        padding: '8px 10px',
        whiteSpace: 'pre-wrap',
      }}
    >
      {visibleEntries.length === 0 && !isProcessing && <EmptyHint />}
      {visibleEntries.map((entry, i) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          previous={i > 0 ? visibleEntries[i - 1] : null}
          onToggleTurn={onToggleTurn}
          onQuickReply={onQuickReply}
          onNextStep={onNextStep}
          outputLinesByCallId={outputLinesByCallId}
        />
      ))}
      {isProcessing && <ProcessingCursor />}
    </div>
  );
};

// -----------------------------------------------------------------------------
// Entry rendering
// -----------------------------------------------------------------------------

interface EntryRowProps {
  entry: TerminalEntry;
  previous: TerminalEntry | null;
  onToggleTurn: (turnId: number) => void;
  onQuickReply?: (response: string) => void;
  onNextStep?: (description: string) => void;
  outputLinesByCallId: Map<
    string,
    Array<Extract<TerminalEntry, { kind: 'tool_output_line' }>>
  >;
}

const EntryRow: React.FC<EntryRowProps> = ({
  entry,
  previous,
  onToggleTurn,
  onQuickReply,
  onNextStep,
  outputLinesByCallId,
}) => {
  const spacing = needsTopSpacing(entry, previous) ? 8 : 0;

  switch (entry.kind) {
    case 'user':
      return (
        <div data-role="user" style={{ marginTop: spacing }}>
          <span style={{ color: COLOR.prompt }}>{'> '}</span>
          <span style={{ color: COLOR.user }}>{entry.text}</span>
        </div>
      );

    case 'thinking':
      return (
        <div
          data-role="thinking"
          aria-live="polite"
          style={{ marginTop: spacing, color: COLOR.muted, opacity: 0.55 }}
        >
          <span className="sas-chat-blink">{'  ~ thinking ~'}</span>
        </div>
      );

    case 'tool_pending':
      return (
        <ToolRow
          entry={{
            ...entry,
            kind: 'tool_done',
            result: undefined,
            error: undefined,
          }}
          pending
          spacing={spacing}
          progressLines={outputLinesByCallId.get(entry.callId) ?? []}
        />
      );

    case 'tool_output_line':
      // Defensive — should be filtered out before reaching here. If a
      // future refactor stops filtering, render as a fallback so we don't
      // silently lose data.
      return (
        <div
          data-role="tool-output"
          data-stream={entry.stream}
          style={{
            marginTop: spacing,
            color: entry.stream === 'stderr' ? COLOR.error : COLOR.muted,
            opacity: 0.7,
          }}
        >
          {'    ┊ '}
          {entry.text}
        </div>
      );

    case 'tool_done':
      return (
        <ToolRow
          entry={entry}
          pending={false}
          spacing={spacing}
          progressLines={outputLinesByCallId.get(entry.callId) ?? []}
        />
      );

    case 'assistant':
      if (entry.collapsed && entry.toolCount > 0) {
        return (
          <div style={{ marginTop: spacing }}>
            <CollapsedToolSummary
              turnId={entry.turnId}
              count={entry.toolCount}
              onToggle={onToggleTurn}
            />
            <AssistantText entry={entry} />
          </div>
        );
      }
      return (
        <div style={{ marginTop: spacing }}>
          <AssistantText entry={entry} />
        </div>
      );

    case 'system_error':
      return (
        <div
          data-role="system"
          style={{ marginTop: spacing, color: COLOR.error }}
        >
          {'! '}
          {entry.text}
        </div>
      );

    case 'clarification_pending':
      return (
        <ClarificationPendingRow
          entry={entry}
          spacing={spacing}
          onQuickReply={onQuickReply}
        />
      );

    case 'clarification_resolved':
      return (
        <div data-role="clarification-resolved" style={{ marginTop: spacing }}>
          <div>
            <span style={{ color: COLOR.question }}>{'  ? '}</span>
            <span style={{ color: COLOR.user }}>{entry.question}</span>
          </div>
          <div>
            <span style={{ color: COLOR.muted }}>{'  ↳ '}</span>
            <span style={{ color: COLOR.muted }}>{entry.response}</span>
          </div>
        </div>
      );

    case 'next_steps':
      return (
        <NextStepsRow entry={entry} spacing={spacing} onNextStep={onNextStep} />
      );
  }
};

interface NextStepsRowProps {
  entry: Extract<TerminalEntry, { kind: 'next_steps' }>;
  spacing: number;
  onNextStep?: (description: string) => void;
}

const NextStepsRow: React.FC<NextStepsRowProps> = ({
  entry,
  spacing,
  onNextStep,
}) => {
  if (entry.steps.length === 0) return null;
  return (
    <div
      data-role="next-steps"
      data-call-id={entry.callId}
      style={{ marginTop: spacing, paddingLeft: 24 }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
        }}
      >
        {entry.steps.map((step, i) => {
          // Secondary steps render dimmer, matching the CLI's `priority`
          // rendering hint (see tool-result.ts NextStep.priority).
          const isPrimary = (step.priority ?? 'primary') === 'primary';
          return (
            <button
              key={`${step.description}-${i}`}
              type="button"
              data-priority={isPrimary ? 'primary' : 'secondary'}
              onClick={() => onNextStep?.(step.description)}
              style={{
                background: 'transparent',
                color: COLOR.prompt,
                border: `1px solid ${COLOR.prompt}${isPrimary ? '88' : '44'}`,
                borderRadius: 4,
                padding: '2px 8px',
                cursor: onNextStep ? 'pointer' : 'default',
                fontFamily: FONT,
                fontSize: 12,
                opacity: onNextStep ? (isPrimary ? 1 : 0.65) : 0.4,
              }}
            >
              {step.description}
            </button>
          );
        })}
      </div>
    </div>
  );
};

interface ClarificationPendingRowProps {
  entry: Extract<TerminalEntry, { kind: 'clarification_pending' }>;
  spacing: number;
  onQuickReply?: (response: string) => void;
}

const ClarificationPendingRow: React.FC<ClarificationPendingRowProps> = ({
  entry,
  spacing,
  onQuickReply,
}) => {
  return (
    <div
      data-role="clarification-pending"
      data-call-id={entry.callId}
      aria-live="polite"
      style={{ marginTop: spacing }}
    >
      <div>
        <span style={{ color: COLOR.question }}>{'  ? '}</span>
        <span style={{ color: COLOR.user }}>{entry.question}</span>
      </div>
      {entry.options && entry.options.length > 0 && (
        <div
          style={{
            marginTop: 4,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            paddingLeft: 24,
          }}
        >
          {entry.options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => onQuickReply?.(opt)}
              style={{
                background: 'transparent',
                color: COLOR.question,
                border: `1px solid ${COLOR.question}55`,
                borderRadius: 4,
                padding: '2px 8px',
                cursor: onQuickReply ? 'pointer' : 'default',
                fontFamily: FONT,
                fontSize: 12,
                opacity: onQuickReply ? 1 : 0.6,
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

interface ToolRowProps {
  entry: Extract<TerminalEntry, { kind: 'tool_done' }>;
  pending: boolean;
  spacing: number;
  progressLines: Array<Extract<TerminalEntry, { kind: 'tool_output_line' }>>;
}

const ToolRow: React.FC<ToolRowProps> = ({
  entry,
  pending,
  spacing,
  progressLines,
}) => {
  const paramStr = formatParams(entry.params);
  const isError = entry.error !== undefined;
  const resultText = pending
    ? null
    : isError
    ? entry.error
    : formatResult(entry.result);
  return (
    <div data-role="tool" style={{ marginTop: spacing }}>
      <div>
        <span style={{ color: COLOR.glyph }}>{'  ⚡ '}</span>
        <span style={{ color: COLOR.user }}>{entry.tool}</span>
        {paramStr && (
          <span style={{ color: COLOR.muted }}>{' ' + paramStr}</span>
        )}
      </div>
      {progressLines.map((line) => (
        <div
          key={line.id}
          data-role="tool-output"
          data-stream={line.stream}
          style={{
            color: line.stream === 'stderr' ? COLOR.error : COLOR.muted,
            opacity: 0.7,
          }}
        >
          {'    ┊ '}
          {line.text}
        </div>
      ))}
      {pending && (
        <div data-role="tool-running" style={{ color: COLOR.muted, opacity: 0.55 }}>
          <span className="sas-chat-blink">{'    ⊙ running...'}</span>
        </div>
      )}
      {!pending && (
        <div>
          <span style={{ color: isError ? COLOR.error : COLOR.muted }}>
            {'  ↳ '}
            {resultText}
          </span>
        </div>
      )}
    </div>
  );
};

const AssistantText: React.FC<{
  entry: Extract<TerminalEntry, { kind: 'assistant' }>;
}> = ({ entry }) => {
  return (
    <div data-role="assistant">
      {entry.iterationLimitHit && (
        <div style={{ color: COLOR.error, marginBottom: 4 }}>
          ! iteration limit reached
        </div>
      )}
      <div>{entry.text}</div>
    </div>
  );
};

const CollapsedToolSummary: React.FC<{
  turnId: number;
  count: number;
  onToggle: (turnId: number) => void;
}> = ({ turnId, count, onToggle }) => {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onToggle(turnId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle(turnId);
        }
      }}
      style={{
        color: COLOR.muted,
        opacity: 0.55,
        cursor: 'pointer',
        userSelect: 'none',
        marginBottom: 4,
      }}
    >
      {'  ▸ '}
      {count} tool call{count === 1 ? '' : 's'} (click to expand)
    </div>
  );
};

const EmptyHint: React.FC = () => (
  <div style={{ color: COLOR.muted, opacity: 0.5 }}>
    {'> '}
    <span style={{ opacity: 0.6 }}>try: "list the tracks" or "add reverb to the bass"</span>
  </div>
);

const ProcessingCursor: React.FC = () => (
  <div aria-live="polite" style={{ color: COLOR.muted, opacity: 0.7 }}>
    <span className="sas-chat-blink">{'  ▍'}</span>
  </div>
);

function needsTopSpacing(entry: TerminalEntry, previous: TerminalEntry | null): boolean {
  if (!previous) return 0 !== 0; // no spacing at start
  if (entry.kind === 'user') return true;
  if (entry.kind === 'assistant') return true;
  if (entry.kind === 'system_error') return true;
  if (entry.kind === 'clarification_pending') return true;
  if (entry.kind === 'clarification_resolved') return true;
  if (entry.kind === 'next_steps') return true;
  // thinking + tool_output_line attach tightly to whatever came before.
  return false;
}
