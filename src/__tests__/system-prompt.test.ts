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

  it('defines Transition with the transition-as-scene model (not the deleted legacy pipeline)', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Transition:/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/bridge/);
    // Migration 073 model: a transition IS a scene, authored in the target key.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/scene_type='transition'/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/TARGET scene's key/);
    // Regression guard: the legacy "short bridge (1-4 bars) ... rendered WAV"
    // description must not come back — that pipeline was deleted.
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/1-4 bars/);
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
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/CLAUDE\.md/);
    // And the discovery hint so the agent knows it can fetch them.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/fs_read_file/);
    // docs/transition-generator.md described the DELETED six-stage pipeline —
    // the pointer must stay gone or the agent cites a dead architecture.
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/transition-generator\.md/);
  });

  it('carries the capability quick-index with real registered tool names', () => {
    // Names verified against src/main/tools registration at edit time; the
    // sas-app-side guard (chat-promoted-tools-exist.test.ts) checks the
    // PROMOTED list, this checks the prompt vocabulary.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/dsl_sound_history/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/dsl_sound_restore/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/scene_set_bars/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/performance_stack_add_node/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/recording_start/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/sas_split_stems/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/ableton_export_scene/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/compose_contract/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/add_instrument/);
  });

  it('routes song-timeline asks to the arrangement tools, not the LOOP-B queue', () => {
    // Local Arranger (S-060/S-061): project-scoped + deferred, so tool_search
    // reaches them — the prompt names them so "put the chorus twice after the
    // verse" doesn't land on performance_stack_* (also "per-slot repeats").
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Arrangement:/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/NOT the LOOP-B queue/);
    for (const name of [
      'arrangement_get',
      'arrangement_insert_instance',
      'arrangement_duplicate_instance',
      'arrangement_set_layer',
      'arrangement_start',
      'arrangement_play',
      'arrangement_undo',
    ]) {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(name);
    }
    // Separate undo history — the agent must not reach for history undo.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/arrangement_undo` \(its own history/);
    // P2: own-only undo — "undo what I did on my phone" must use fromOtherDevice.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/it undoes only THIS desktop's own edits/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/To undo a change made on the phone \/ the web, pass fromOtherDevice: true/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/`arrangement_sync_status` lastRemote names that batch/);
    // S-082: the edit tools resolve names, so no mandatory arrangement_get
    // id-lookup hop before every edit.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/They take NAMES directly/);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/arrangement_get` FIRST/);
  });

  it('routes arrangement row mute / solo / restore and the loop to the arranger tools', () => {
    // Song-wide row M / S are the arranger's own, per view (S-210: Compose's
    // mutes / solos never reach it); one instance's layer stays set_layer. Looping is ON over the whole song by
    // default; a pending play starts by itself.
    for (const name of [
      'arrangement_set_track_mute',
      'arrangement_set_track_solo',
      'arrangement_restore_track',
      'arrangement_get_loop',
      'arrangement_set_loop',
    ]) {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(name);
    }
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/NOT the composer's `dsl_track_mute` \/ `dsl_track_solo`/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/silentRows/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Playback LOOPS the whole arrangement by default/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/pending: true — it is preparing and starts by itself; don't call play again/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/deferred_until_stop: tell the user it opens once playback stops/);
    // S-192: the composition's stops never stop a playing arrangement —
    // deck_stop is on the default surface, arrangement_stop is deferred.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(
      /stop it with `arrangement_stop` \(the composition's `deck_stop` \/ `dsl_stop` never stop the arrangement\)/,
    );
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/`arrangement_status` playPending/);
  });

  it('routes song export to arrangement_export, not the scene or cloud export paths', () => {
    // S-062: the legacy LOOP-B export_arrangement is retired; arrangement_export
    // is an async job (Mix / Master preset / stems / editable stems / Ableton).
    expect(DEFAULT_SYSTEM_PROMPT).toContain('arrangement_export');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('arrangement_export_cancel');
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/arrangement_export` \(a job — wait with `wait_for_job`/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/NOT `export_audio` \/ `ableton_export_\*`/);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/\bexport_arrangement\b/);
  });

  it('routes arrangement sync / import / share to the local arrangement_* tools, not the cloud arranger_*', () => {
    // S-065: sync of the project's LOCAL arrangement; proposals are never
    // auto-applied. S-105 (D-051): importing one REPLACES the project's
    // arrangement as one undoable step (no new local arrangement any more).
    for (const name of [
      'arrangement_sync_status',
      'arrangement_sync',
      'arrangement_import_proposal',
      'arrangement_share',
    ]) {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(name);
    }
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/arrangement_share` \(action get\|create\|rotate\|revoke/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/NOT the cloud `arranger_\*` draft tools/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(
      /arrangement_import_proposal` \(a draftId from the sync status → it REPLACES the project's arrangement as ONE undoable step: `arrangement_undo` brings the previous version back; the variant library is kept\)/,
    );
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/a NEW local arrangement/);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/the original is untouched/);
    // S-200: web insertability depends on the background scene preparation —
    // webPrep (sync_status / sync) answers "why can't I insert X on the web".
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/"why can't I insert the Verse on the web"/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/`webPrep` = the background preparation that renders every scene so it is insertable on the web/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/prepareAllScenes \/ pausePreparation/);
    // S-210 (D-090) superseded S-198: mute / solo are per view — Compose's
    // mutes (track or bus) no longer silence an arrangement row.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/only the arranger's own M \/ S silence a row here; each entry says why: row-muted or other-row-soloed/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Mute \/ solo are PER VIEW/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Compose's mutes \/ solos \/ bus mutes never touch it/);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/composer mute[^.;]*silences a row here/);
  });

  it('teaches one arrangement per project (D-051): no lifecycle tools, no arrangementId', () => {
    // S-105 removed arrangement_list / _create / _rename / _delete / _select;
    // every arrangement tool acts on the project's arrangement and ignores
    // arrangementId. A missing arrangement is seeded by arrangement_start.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/A project has exactly ONE arrangement, bound to its composition/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/every arrangement tool acts on it without an arrangement id/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/if the project has none yet, `arrangement_start` seeds it/);
    // \b after the verb keeps the live arrangement_delete_instance /
    // arrangement_delete_region from matching the removed arrangement_delete.
    for (const removed of ['list', 'create', 'rename', 'delete', 'select']) {
      expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(new RegExp(`\\barrangement_${removed}\\b`));
    }
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/arrangementId/);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/\barrangements\b/);
    // S-108 instance labels: "Chorus" once, "Chorus (1)" / "Chorus (2)" repeated.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/"Chorus \(1\)" \/ "Chorus \(2\)" when it repeats/);
  });

  it('routes per-instance treatments to arrangement_place/remove_treatment, user-requested only', () => {
    // S-094: the editor's treatment palette (types from the contract's
    // TREATMENT_SPECS — the tool description enumerates them, the prompt
    // names families only). Nothing is automatic.
    expect(DEFAULT_SYSTEM_PROMPT).toContain('arrangement_place_treatment');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('arrangement_remove_treatment');
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/a riser resolves at the END of its bar/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Place ONLY what the user asks for/);
  });

  it('routes copy / paste / duplicate / clear to the arrangement clipboard tools', () => {
    // S-097: the editor's session clipboard (⌘C / ⌘V / ⌘D / Delete).
    for (const name of [
      'arrangement_copy',
      'arrangement_paste',
      'arrangement_duplicate`',
      'arrangement_delete_region',
    ]) {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(name);
    }
    // delete_region silences bars — it never removes time.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/those bars go SILENT, the song doesn't get shorter/);
  });

  it('teaches clips (split / join / the clip selector) and whole-section fades', () => {
    // S-118 (D-054, D-055 "Split at sections"): every section boundary is a
    // clip edge and a pasted / duplicated piece is its own clip, so "delete
    // the second copy of the kick" is one clip, not the whole run.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/every section boundary is a clip edge, and a pasted or duplicated piece is its own clip/);
    expect(DEFAULT_SYSTEM_PROMPT).toContain('arrangement_split');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('arrangement_join');
    // Split refuses a section start; join never removes a section edge.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/a section start is already an edge, so it is refused/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/it can't join across a section start/);
    // The clip selector on copy / delete_region / duplicate, vs run.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(
      /`arrangement_copy` \/ `arrangement_delete_region` \/ `arrangement_duplicate` take `clip` \{track, instance\? \| bar\?\} = the clip under that bar/,
    );
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/"delete the second copy of the kick" → `arrangement_delete_region` \{clip: \{track: "kick", bar: 17\}\}/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/vs `run` = the layer's whole continuous stretch across sections/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/`arrangement_get` lists each layer's splits/);
    // S-101: fade a whole section; 0 removes; one layer stays set_layer's job.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/`arrangement_fade_section` \(`instance` by name, `edge` in\|out, `bars` or `beats` — 0 removes the fades\)/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/starts at the section's first bar \(in\) or ends at its last \(out\)/);
  });

  it('teaches arrangement_set_layer fade shapes and the gain envelope (the wave edit view)', () => {
    // S-104 (D-050 "fades + gain only"): fadeInCurve / fadeOutCurve take the
    // four shapes, and a shape sent alone re-shapes the existing fade.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(
      /`arrangement_set_layer` for one layer in one instance \(play off, fromBar\/toBar, fades, gainDb; fade shapes `fadeInCurve` \/ `fadeOutCurve` equalPower \(the default\) \| linear \| exponential \| sCurve/,
    );
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/a shape alone re-shapes the existing fade/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/"make the pad's fade-out an S-curve" → fadeOutCurve: "sCurve", no fadeOutBeats/);
    // gainEnvelope: quarter-note beats from the instance's start, linear in dB,
    // held past the ends, so a dip needs 0 dB anchors on both sides.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/a gain envelope `gainEnvelope` \[\{beat, db\}\]/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/beats are quarter notes from the instance's start, linear in dB between points and held past the ends/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/so a dip needs 0 dB points around it/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/±24 dB on top of gainDb, \[\] clears/);
    expect(DEFAULT_SYSTEM_PROMPT).toContain(
      '"duck the bass by 6 dB in bars 3-4 of the chorus" (4/4) → [{beat: 7, db: 0}, {beat: 8, db: -6}, {beat: 16, db: -6}, {beat: 17, db: 0}]',
    );
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/`arrangement_get` shows both\)/);
    // Whole-section fades stay equal-power on arrangement_fade_section; shapes
    // are a per-layer edit only.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/One layer's fades stay with `arrangement_set_layer`/);
  });

  it('names only registered arrangement_* tools', () => {
    // Mirror of sas-app's registered arrangement_* tool names (src/main/tools,
    // as of S-118, + the row mute / solo / restore and loop tools). A name the
    // prompt invents sends the agent to a tool_search dead end; add to this
    // list only after the tool ships.
    const registered = new Set([
      'arrangement_start', 'arrangement_play', 'arrangement_stop', 'arrangement_status', 'arrangement_seek',
      'arrangement_loop_instance', 'arrangement_get', 'arrangement_insert_instance', 'arrangement_move_instance',
      'arrangement_duplicate_instance', 'arrangement_delete_instance', 'arrangement_resize_instance',
      'arrangement_set_layer', 'arrangement_fade_section', 'arrangement_place_treatment',
      'arrangement_remove_treatment', 'arrangement_copy', 'arrangement_paste', 'arrangement_delete_region',
      'arrangement_duplicate', 'arrangement_split', 'arrangement_join', 'arrangement_undo', 'arrangement_redo',
      'arrangement_export', 'arrangement_export_cancel', 'arrangement_sync_status', 'arrangement_sync',
      'arrangement_import_proposal', 'arrangement_share', 'arrangement_set_track_mute',
      'arrangement_set_track_solo', 'arrangement_restore_track', 'arrangement_get_loop', 'arrangement_set_loop',
    ]);
    const named = DEFAULT_SYSTEM_PROMPT.match(/\barrangement_[a-z_]+/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !registered.has(n))).toEqual([]);
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
