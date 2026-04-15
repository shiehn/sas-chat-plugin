/**
 * MessageList — ordered list of MessageItem entries.
 *
 * Renders empty-state hint when no messages. Inlines ActionLog for each
 * assistant message that has actions. Appends a loading indicator when
 * isProcessing=true.
 */

import React from 'react';
import { MessageItem } from './MessageItem';
import { ActionLog } from './ActionLog';
import type { ChatUIMessage } from './types';

export interface MessageListProps {
  messages: ChatUIMessage[];
  isProcessing?: boolean;
}

const EmptyHint: React.FC = () => (
  <div
    style={{
      padding: 24,
      textAlign: 'center',
      fontSize: 13,
      opacity: 0.6,
    }}
  >
    Ask me to add a track, tweak effects, or regenerate MIDI. Try
    &quot;add reverb to the bass&quot;, &quot;make the drums punchier&quot;, or
    &quot;simplify the lead&quot;.
  </div>
);

const LoadingIndicator: React.FC = () => (
  <div
    data-testid="loading-indicator"
    role="status"
    aria-live="polite"
    style={{
      padding: '8px 12px',
      fontSize: 12,
      opacity: 0.6,
      fontStyle: 'italic',
    }}
  >
    Thinking…
  </div>
);

export const MessageList: React.FC<MessageListProps> = ({ messages, isProcessing }) => {
  return (
    <div
      role="list"
      aria-label="chat messages"
      style={{
        overflowY: 'auto',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {messages.length === 0 ? (
        <EmptyHint />
      ) : (
        messages.map((m) => (
          <MessageItem
            key={m.id}
            role={m.role}
            content={m.content}
            timestamp={m.timestamp}
          >
            {m.role === 'assistant' && m.actions && m.actions.length > 0 ? (
              <ActionLog actions={m.actions} />
            ) : null}
          </MessageItem>
        ))
      )}
      {isProcessing && <LoadingIndicator />}
    </div>
  );
};
