/**
 * MessageItem — one chat message (user / assistant / system).
 *
 * Thin, semantic wrapper. Styling is deliberately minimal inline; the host
 * app can re-skin via CSS targeting the `data-role` attribute.
 */

import React from 'react';
import type { ChatUIRole } from './types';

export interface MessageItemProps {
  role: ChatUIRole;
  content: string;
  timestamp?: string;
  children?: React.ReactNode; // Allow embedding action log etc. inline
}

export const MessageItem: React.FC<MessageItemProps> = ({ role, content, timestamp, children }) => {
  return (
    <div
      role="listitem"
      data-role={role}
      aria-label={`${role} message`}
      style={{
        padding: '8px 12px',
        margin: '4px 0',
        borderRadius: 6,
        // Escape hatches for host CSS; see data-role for the actual selector
      }}
    >
      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>
        {content}
      </div>
      {timestamp && (
        <div
          data-testid="timestamp"
          style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}
        >
          {timestamp}
        </div>
      )}
      {children}
    </div>
  );
};
