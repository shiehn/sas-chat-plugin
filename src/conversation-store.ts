/**
 * ConversationStore — per-project persistence for the chat conversation.
 *
 * Backed by `host.setProjectData` (project-scoped plugin_data), so the
 * storage namespace itself is per-project: after a project switch,
 * `load()` reads the NEW project's conversation (or null). The stamped
 * `projectId` is a belt-and-braces check so a stale in-memory history can
 * never be written into another project's namespace.
 *
 * Size discipline: payloads have a soft cap (`CONVERSATION_SIZE_CAP_BYTES`).
 * `save()` still writes oversized payloads (losing the tail of a session is
 * worse than a fat row) but reports `overCap: true` so the caller can
 * request a compaction pass on the agent loop.
 */

import type { LLMContent, PluginHost } from '@signalsandsorcery/plugin-sdk';

export const CONVERSATION_KEY = 'chat.conversation.v1';
export const CONVERSATION_SIZE_CAP_BYTES = 256 * 1024;

export interface StoredConversationV1 {
  version: 1;
  /** Project the conversation belongs to (defensive stamp; storage is per-project anyway). */
  projectId: string;
  /** Epoch ms of the save. */
  savedAt: number;
  /** Model the conversation was driven by (informational; future model-switch handling). */
  model: string;
  contents: LLMContent[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Minimal structural validation — never trust persisted state. */
function isValidStoredConversation(v: unknown): v is StoredConversationV1 {
  if (!isRecord(v)) return false;
  if (v.version !== 1) return false;
  if (typeof v.projectId !== 'string') return false;
  if (typeof v.model !== 'string') return false;
  if (!Array.isArray(v.contents)) return false;
  for (const entry of v.contents) {
    if (!isRecord(entry)) return false;
    if (entry.role !== 'user' && entry.role !== 'model') return false;
    if (!Array.isArray(entry.parts)) return false;
  }
  return true;
}

export interface SaveResult {
  bytes: number;
  overCap: boolean;
}

export class ConversationStore {
  private readonly host: PluginHost;

  constructor(host: PluginHost) {
    this.host = host;
  }

  /** Load the current project's persisted conversation; null when absent or malformed. */
  async load(): Promise<StoredConversationV1 | null> {
    try {
      const raw = await this.host.getProjectData<unknown>(CONVERSATION_KEY);
      return isValidStoredConversation(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  /** Persist a snapshot. Best-effort — throws are swallowed by callers. */
  async save(snapshot: {
    projectId: string;
    model: string;
    contents: LLMContent[];
  }): Promise<SaveResult> {
    const payload: StoredConversationV1 = {
      version: 1,
      projectId: snapshot.projectId,
      savedAt: Date.now(),
      model: snapshot.model,
      contents: snapshot.contents,
    };
    const bytes = JSON.stringify(payload).length;
    await this.host.setProjectData(CONVERSATION_KEY, payload);
    return { bytes, overCap: bytes > CONVERSATION_SIZE_CAP_BYTES };
  }

  /** Delete the persisted conversation (user "clear", Errantry reset). */
  async clear(): Promise<void> {
    try {
      await this.host.setProjectData(CONVERSATION_KEY, null);
    } catch {
      // best-effort
    }
  }
}
