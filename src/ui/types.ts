/**
 * UI-layer types for the chat panel's terminal log.
 *
 * The UI is a tail-style log: each TerminalEntry is one "line block" in the
 * scrollback. Entries arrive as ChatAgentEvents stream in during a turn.
 * A `turnId` groups tool entries so they can be collapsed into a one-line
 * summary once the assistant's final text lands.
 */

import type { AgentNextStep, WorkflowProgressItem } from '../agent-loop';

export type TerminalEntry =
  | { kind: 'user'; id: string; turnId: number; text: string }
  | {
      kind: 'thinking';
      id: string;
      turnId: number;
    }
  | {
      kind: 'tool_pending';
      id: string;
      turnId: number;
      callId: string;
      tool: string;
      params: Record<string, unknown>;
    }
  | {
      kind: 'tool_output_line';
      id: string;
      turnId: number;
      callId: string;
      stream: 'stdout' | 'stderr';
      text: string;
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
  /** Model is asking the user a clarifying question via the `ask_user`
   *  synthetic tool. While a clarification is pending the input box stays
   *  enabled and routes to `sendClarificationResponse` instead of starting
   *  a new turn. Resolves to `clarification_resolved` when the user replies.
   */
  | {
      kind: 'clarification_pending';
      id: string;
      turnId: number;
      callId: string;
      question: string;
      options?: readonly string[];
    }
  | {
      kind: 'clarification_resolved';
      id: string;
      turnId: number;
      callId: string;
      question: string;
      response: string;
    }
  /** Follow-up affordances surfaced by a successful tool call. Rendered as
   *  a row of clickable buttons; the click submits the step's `description`
   *  as a new user message so the LLM picks the matching tool on the next
   *  turn. Stays visible after the turn collapses — it's an action
   *  affordance, not a debug detail. */
  | {
      kind: 'next_steps';
      id: string;
      turnId: number;
      callId: string;
      steps: AgentNextStep[];
    }
  /** Incremental sub-task status for a long-running tool. Inlined inside
   *  the owning ⚡ ToolRow keyed by `callId`. Mutated in place — one row
   *  per callId, items list replaces fully on each emission. Hidden when
   *  the turn collapses (scratch state, not an action affordance). */
  | {
      kind: 'workflow_progress';
      id: string;
      turnId: number;
      callId: string;
      label?: string;
      items: WorkflowProgressItem[];
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
