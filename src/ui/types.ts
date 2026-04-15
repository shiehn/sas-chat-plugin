/**
 * UI-layer types for the chat panel.
 *
 * Kept separate from ../chat-agent types so the UI can render a broader
 * surface (system messages, timestamps, per-message action logs) without
 * coupling to the agent's wire protocol.
 */

export type ChatUIRole = 'user' | 'assistant' | 'system';

export interface ChatActionEntry {
  tool: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface ChatUIMessage {
  id: string;
  role: ChatUIRole;
  content: string;
  /** Optional timestamp string (e.g. "14:23"). */
  timestamp?: string;
  /** Tool calls produced on this turn — only meaningful for assistant messages. */
  actions?: ChatActionEntry[];
  /** UI cue: agent hit its iteration cap during this turn. */
  iterationLimitHit?: boolean;
}
