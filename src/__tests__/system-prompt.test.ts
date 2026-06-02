/**
 * Regression guard for the chat-plugin's DEFAULT_SYSTEM_PROMPT. Asserts
 * that the canonical S&S domain vocabulary stays present — the agent
 * relies on these definitions to answer "what is X?" questions in a
 * single turn (no tool round-trip, no Gemini training-data guesswork).
 *
 * If you intentionally rewrite a section, update the matchers below in
 * the same change so the contract drifts deliberately rather than
 * silently.
 */

import { describe, it, expect } from '@jest/globals';

import { DEFAULT_SYSTEM_PROMPT } from '../plugin';

describe('DEFAULT_SYSTEM_PROMPT — S&S domain vocabulary', () => {
  it('defines what a Scene is, with the canonical bar lengths', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Scene:/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/2\/4\/8\/16-bar/);
  });

  it('defines Transition as a short bridge between scenes', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Transition:/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/bridge/);
  });

  it('defines both decks (LOOP-A=cue, LOOP-B=performance/main)', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/LOOP-A/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/cue/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/LOOP-B/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/performance/);
    // Channel assignment is part of the deck definition.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/channels 1-2/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/channels 3-4/);
  });

  it('defines Musical context (a.k.a. contract)', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Musical context/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/contract/);
  });

  it('defines Role with the canonical plural-form examples', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Role:/);
    // Canonical roles are plural (see
    // sas-app/src/music-engine/constants/instrument-classification.ts).
    // If the source-of-truth list changes, update both this test and
    // the system prompt so they stay in lockstep.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/kicks/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/snares/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/hats/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/vocals/);
  });

  it('defines Plugin and names the built-in plugins', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Plugin:/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/synth-generator/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/drum-generator/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/instrument-generator/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/loops/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/stems/);
  });

  it('routes sample-based generation vs Surge generation', () => {
    // The agent must know the sample-based skills exist and when to prefer
    // them over the Surge dsl_generate_* tools.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/generate_drums/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/generate_instrument/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/dsl_generate_drums/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/dsl_generate_midi/);
  });

  it('defines Playback mode (performance vs solo)', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Playback mode/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Solo mode/);
  });

  it('points at design docs for implementation-detail questions', () => {
    // Specific doc paths the agent can fs_read_file against.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/docs\/transition-generator\.md/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/CLAUDE\.md/);
    // And the discovery hint so the agent knows it can fetch them.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/fs_read_file/);
  });

  it('teaches the clarification recovery contract (clarification_needed → ask_user)', () => {
    // The agent has historically fumbled ambiguous selectors; the prompt
    // must spell out the contract: when a tool returns clarification_needed,
    // the response carries the candidate list and the agent should pipe it
    // straight into ask_user.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/clarification_needed/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/ask_user/);
    // The candidate-list keys the agent should reach for.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/availableScenes/);
  });

  it('teaches the not_found recovery path (do not retry same wrong selector)', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/track_not_found|scene_not_found|transition_not_found/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/sas_inspect_project/);
  });

  it('promotes db_query as the agent\'s state-question escape hatch', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/db_query/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/db_describe_schema/);
    // The DB-scoping rule (cross-project leakage protection).
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/project_id/);
  });

  it('makes "inspect first on fuzzy reference" explicit in the work loop', () => {
    // The "inspect first" line specifically calls out the
    // entity-by-name pattern that historically failed without inspection.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/sas_inspect_project/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Don't guess/i);
  });

  it('tells the agent the active scene contract is in the auto-injected preamble', () => {
    // The ambient "Current state" block now carries the active scene's
    // key/BPM/chords, so the agent should read it there instead of spending a
    // round-trip on get_musical_context just to learn the key or tempo.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/get_musical_context/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Current state/);
  });

  it('teaches co-creative options (planOnly) and objective self-verification', () => {
    // Propose options only for open-ended/taste requests, via planOnly plan-emitters.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/planOnly/);
    // Self-verify only objective constraints, via render → analyze.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/sas_render_preview/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/sas_analyze_audio/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/objective/i);
  });

  it('teaches working-memory bookkeeping (session ledger + persistent journal)', () => {
    // Session goals survive scene changes via the ledger; durable preferences
    // go to the per-project journal. Both are silent bookkeeping.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/chat_task_ledger/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/sas_project_notes_write/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/sas_project_notes_read/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/survives scene changes/i);
  });

  it('teaches transient-failure retry via the STRUCTURAL retryable signal (no hardcoded phrase list)', () => {
    // The earlier version of this test asserted on hardcoded phrases like
    // "in flight" / "loading" — those were a heuristic the user explicitly
    // rejected. The replacement: the prompt teaches the agent to read the
    // STRUCTURAL `remediation.retryable === true` flag set by tools whose
    // failures are inherently transient.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/remediation\.retryable/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/retry/i);
    // Regression guard: the hardcoded phrase list must NOT come back.
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/"in flight"/);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/"warming up"/);
  });
});
