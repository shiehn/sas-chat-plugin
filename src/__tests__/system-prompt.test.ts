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
    // sas-assistant/src/music-engine/constants/instrument-classification.ts).
    // If the source-of-truth list changes, update both this test and
    // the system prompt so they stay in lockstep.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/kicks/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/snares/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/hats/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/vocals/);
  });

  it('defines Plugin and names the three built-in plugins', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Plugin:/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/synth-generator/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/sample-player/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/audio-texture/);
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
});
