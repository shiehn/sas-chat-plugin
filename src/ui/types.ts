/**
 * UI-layer types for the chat panel's terminal log.
 *
 * The UI is a tail-style log: each TerminalEntry is one "line block" in the
 * scrollback. Entries arrive as ChatAgentEvents stream in during a turn.
 * A `turnId` groups tool entries so they can be collapsed into a one-line
 * summary once the assistant's final text lands.
 */

export type TerminalEntry =
  | { kind: 'user'; id: string; turnId: number; text: string }
  | {
      kind: 'tool_pending';
      id: string;
      turnId: number;
      callId: string;
      tool: string;
      params: Record<string, unknown>;
    }
  | {
      kind: 'tool_done';
      id: string;
      turnId: number;
      callId: string;
      tool: string;
      params: Record<string, unknown>;
      result?: unknown;
      error?: string;
    }
  | {
      kind: 'assistant';
      id: string;
      turnId: number;
      text: string;
      iterationLimitHit?: boolean;
      toolCount: number;
      collapsed: boolean;
    }
  | { kind: 'system_error'; id: string; turnId: number; text: string };
