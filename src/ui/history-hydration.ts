/**
 * history-hydration — map a persisted conversation (LLMContent[]) back into
 * TerminalEntry[] so the chat panel shows the restored transcript on app
 * restart instead of a blank scrollback.
 *
 * WHY: conversations persist per-project (ConversationStore) and reseed the
 * AgentLoop, but the panel used to mount empty — the agent silently
 * remembered a history the user couldn't see or audit. Rendering the
 * restored transcript makes the shared context visible.
 *
 * Pure function, defensive throughout: persisted state is untrusted (schema
 * drift, partial writes), and a malformed entry must degrade to "skip that
 * entry", never to a broken panel.
 *
 * Mapping rules:
 *  - user turn with text (no functionResponse parts) → `user` row. Turn
 *    counter increments here — mirrors how live turns are numbered.
 *  - model text parts → `assistant` row for the turn. Restored turns with
 *    tools collapse by default (same tidy state a finished live turn ends in).
 *  - model functionCall + the NEXT user turn's functionResponse pair up
 *    positionally → `tool_done` rows (ask_user pairs → `clarification_resolved`).
 *    A functionCall with no recorded response (crash mid-turn) renders as a
 *    tool_done with an explanatory error.
 *  - Compaction summaries ("[Conversation summary — …]") and stop-acks
 *    ("(Stopped by user.)") are ordinary turns in the provider history and
 *    render as-is — transparent beats clever.
 */

import type { LLMContent, LLMPart } from '@signalsandsorcery/plugin-sdk';
import type { TerminalEntry } from './types';

/** Synthetic tool name — keep in sync with constants.ts (not imported to keep
 *  this module dependency-free for the renderer bundle). */
const ASK_USER = 'ask_user';

interface FunctionCallPart {
  name: string;
  args: Record<string, unknown>;
}

interface FunctionResponsePayload {
  success?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function textOf(parts: LLMPart[]): string {
  return parts
    .map((p) => (typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .filter((t) => t.length > 0)
    .join('\n')
    .trim();
}

function functionCallsOf(parts: LLMPart[]): FunctionCallPart[] {
  const out: FunctionCallPart[] = [];
  for (const p of parts) {
    const fc = (p as { functionCall?: unknown }).functionCall;
    if (isRecord(fc) && typeof fc.name === 'string') {
      out.push({ name: fc.name, args: isRecord(fc.args) ? fc.args : {} });
    }
  }
  return out;
}

function functionResponsesOf(parts: LLMPart[]): Array<{ name: string; response: FunctionResponsePayload }> {
  const out: Array<{ name: string; response: FunctionResponsePayload }> = [];
  for (const p of parts) {
    const fr = (p as { functionResponse?: unknown }).functionResponse;
    if (isRecord(fr) && typeof fr.name === 'string') {
      out.push({ name: fr.name, response: isRecord(fr.response) ? fr.response : {} });
    }
  }
  return out;
}

function hasFunctionResponse(parts: LLMPart[]): boolean {
  return parts.some((p) => (p as { functionResponse?: unknown }).functionResponse !== undefined);
}

let hydrateIdCounter = 0;
function nextHydrateId(): string {
  hydrateIdCounter += 1;
  return `h${hydrateIdCounter}`;
}

export interface HydrationResult {
  entries: TerminalEntry[];
  /** Highest turnId used — the panel seeds its live turn counter above this
   *  so restored and new turns never share a collapse group. */
  maxTurnId: number;
}

export function historyToEntries(contents: LLMContent[]): HydrationResult {
  const entries: TerminalEntry[] = [];
  let turnId = 0;
  // A single user turn spans MULTIPLE model turns (fc → fr → fc → fr → text);
  // the assistant row's toolCount must reflect the whole turn's tool rows so
  // the collapsed "⚡ N tools" summary is truthful.
  const toolsInTurn = new Map<number, number>();
  if (!Array.isArray(contents)) return { entries, maxTurnId: 0 };

  for (let i = 0; i < contents.length; i++) {
    const entry = contents[i];
    if (!isRecord(entry) || !Array.isArray((entry as { parts?: unknown }).parts)) continue;
    const parts = entry.parts as LLMPart[];

    if (entry.role === 'user') {
      // functionResponse turns are consumed by the PRECEDING model turn's
      // functionCall pairing below — never rendered standalone.
      if (hasFunctionResponse(parts)) continue;
      const text = textOf(parts);
      if (!text) continue;
      turnId += 1;
      entries.push({ kind: 'user', id: nextHydrateId(), turnId, text });
      continue;
    }

    if (entry.role !== 'model') continue;
    // A model turn before any user turn (compaction ack after a summary that
    // was skipped as empty, defensive) still needs a valid group.
    if (turnId === 0) turnId = 1;

    const calls = functionCallsOf(parts);
    const next = contents[i + 1];
    const responses =
      calls.length > 0 && isRecord(next) && next.role === 'user' && Array.isArray(next.parts)
        ? functionResponsesOf(next.parts as LLMPart[])
        : [];

    for (let c = 0; c < calls.length; c++) {
      const call = calls[c];
      // Positional pairing — the loop records responses in call order.
      const response = responses[c]?.response ?? null;
      const success = response?.success === true;
      const stdout = typeof response?.stdout === 'string' ? response.stdout : '';
      const stderr = typeof response?.stderr === 'string' ? response.stderr : '';
      const callId = `hc-${nextHydrateId()}`;

      if (call.name === ASK_USER) {
        const question = typeof call.args.question === 'string' ? call.args.question : '';
        entries.push({
          kind: 'clarification_resolved',
          id: nextHydrateId(),
          turnId,
          callId,
          question,
          response: success ? stdout : `(no answer: ${stderr || 'cancelled'})`,
        });
        continue;
      }

      toolsInTurn.set(turnId, (toolsInTurn.get(turnId) ?? 0) + 1);
      entries.push({
        kind: 'tool_done',
        id: nextHydrateId(),
        turnId,
        callId,
        tool: call.name,
        params: call.args,
        result: response === null ? undefined : success ? stdout : undefined,
        error:
          response === null
            ? 'No result was recorded for this call (the session ended mid-turn).'
            : success
              ? undefined
              : stderr || stdout || 'failed',
      });
    }

    const text = textOf(parts);
    if (text) {
      const turnTools = toolsInTurn.get(turnId) ?? 0;
      entries.push({
        kind: 'assistant',
        id: nextHydrateId(),
        turnId,
        text,
        toolCount: turnTools,
        // Restored turns land in the same tidy state a finished live turn
        // ends in: tool rows collapsed behind the assistant summary.
        collapsed: turnTools > 0,
      });
    }
  }

  return { entries, maxTurnId: turnId };
}
