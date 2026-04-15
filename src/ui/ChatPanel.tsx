/**
 * ChatPanel — top-level integration component for the chat panel plugin.
 *
 * Props:
 *   - sendMessage: async fn that takes a user message and returns an
 *     AgentResponse. In production this is wired to the ChatAgent from
 *     ../chat-agent.ts; in tests it's a mock.
 *   - initialMessages: optional persisted chat history (scene-scoped).
 *
 * State:
 *   - messages: the full conversation visible in the UI (user + assistant
 *     + system error messages).
 *   - isProcessing: true while a send is in flight — disables the input
 *     and shows a loading indicator.
 */

import React, { useCallback, useState } from 'react';
import { MessageList } from './MessageList';
import { InputBox } from './InputBox';
import type { ChatUIMessage } from './types';
import type { AgentResponse } from '../chat-agent';

export interface ChatPanelProps {
  sendMessage: (message: string) => Promise<AgentResponse>;
  initialMessages?: ChatUIMessage[];
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `m${idCounter}-${Date.now()}`;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  sendMessage,
  initialMessages = [],
}) => {
  const [messages, setMessages] = useState<ChatUIMessage[]>(initialMessages);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSend = useCallback(
    async (text: string): Promise<void> => {
      const userMsg: ChatUIMessage = {
        id: nextId(),
        role: 'user',
        content: text,
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsProcessing(true);

      try {
        const response = await sendMessage(text);
        const assistantMsg: ChatUIMessage = {
          id: nextId(),
          role: 'assistant',
          content: response.text,
          actions: response.actions,
          iterationLimitHit: response.iterationLimitHit,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch (err) {
        const errorMsg: ChatUIMessage = {
          id: nextId(),
          role: 'system',
          content: err instanceof Error ? err.message : String(err),
        };
        setMessages((prev) => [...prev, errorMsg]);
      } finally {
        setIsProcessing(false);
      }
    },
    [sendMessage]
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 300,
      }}
    >
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <MessageList messages={messages} isProcessing={isProcessing} />
      </div>
      <InputBox onSend={handleSend} disabled={isProcessing} />
    </div>
  );
};
