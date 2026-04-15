/**
 * ActionLog — collapsible per-turn tool-call log.
 *
 * Renders the `actions: ChatActionEntry[]` produced by a ChatAgent turn.
 * Each entry is a <button> (keyboard-reachable) that toggles a details
 * block showing params + result OR error.
 */

import React, { useState } from 'react';
import type { ChatActionEntry } from './types';

export interface ActionLogProps {
  actions: ChatActionEntry[];
}

interface ActionRowProps {
  action: ChatActionEntry;
}

const ActionRow: React.FC<ActionRowProps> = ({ action }) => {
  const [expanded, setExpanded] = useState(false);
  const hasError = action.error !== undefined;

  return (
    <div
      style={{
        fontSize: 12,
        padding: '4px 8px',
        borderLeft: `2px solid ${hasError ? '#c44' : '#4a4'}`,
        margin: '2px 0',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontSize: 12,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: 'inherit',
          textAlign: 'left',
          width: '100%',
        }}
      >
        <span data-status={hasError ? 'error' : 'success'} aria-hidden>
          {hasError ? '✗' : '✓'}
        </span>
        <span>{action.tool}</span>
      </button>
      {expanded && (
        <div
          style={{
            marginTop: 4,
            fontFamily: 'monospace',
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            opacity: 0.8,
            paddingLeft: 14,
          }}
        >
          <div>
            <strong>params:</strong> {JSON.stringify(action.params)}
          </div>
          {hasError ? (
            <div style={{ color: '#c44' }}>
              <strong>error:</strong> {action.error}
            </div>
          ) : (
            <div>
              <strong>result:</strong> {JSON.stringify(action.result)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const ActionLog: React.FC<ActionLogProps> = ({ actions }) => {
  if (actions.length === 0) return null;
  return (
    <div data-testid="action-log" style={{ marginTop: 8 }}>
      {actions.map((a, i) => (
        <ActionRow key={i} action={a} />
      ))}
    </div>
  );
};
