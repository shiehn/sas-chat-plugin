# Chat Interface — North Star

> **Anything a producer can do in Signals & Sorcery with mouse and keyboard, they can do by typing —
> and the screen shows it happening exactly as if they had clicked.**

This is the charter for the chat interface (this plugin's `AgentLoop` plus the shared tool surface it drives). Every
chat-related change is judged against it. It supersedes the 2026-05 "agentic roadmap", whose three phases (ambient
context, task ledger / cross-session memory, propose-options / self-verify) all shipped.

Established 2026-09-26.

---

## 1. Pillars

Each pillar has an invariant that can be tested. §5 turns them into scenarios.

| # | Pillar | Invariant — how we know |
|---|--------|--------------------------|
| **P1** | **Total control** | Every capability a user can reach has an agent path. That includes every generator-plugin panel (bass, arp, pad, ensemble, vocals, texture…) and view navigation (open a panel, reveal a track, Master FX, settings, layout). The coverage ledgers count plugin panels and view state, and nothing is excluded as "UI-only" without saying so. |
| **P2** | **Visual truth** | **Agent action ≡ user click.** After any agent action, from chat, the `sas` CLI or MCP, the UI agrees with the DB/engine: selected scene, tracks, mute/solo, FX, contract. This holds within ~300 ms of the tool *completing*, with no flicker or snap-back, and it runs the same renderer path a click runs. The thing that changed is revealed (scrolled to and highlighted) unless the user is busy elsewhere. |
| **P3** | **Precision** | A direct command on a named entity ("mute the bassline", "hats down 3 dB", "switch to the techno scene") acts in at most one mutating call, resolved through `EntityResolver`. The agent asks only when the reference is genuinely ambiguous. |
| **P4** | **Musical interpretation** | Open-ended direction ("add a beat", "darker", "more like techno", "give it a drop") becomes a plan that fits the context — genre, contract, existing tracks, producer preferences — built from composable primitives. **No taste lives in code**: no fixed role lists, no fixed plugin choice, no per-genre templates in TypeScript. The agent gets that know-how from **agent skills** it loads when needed. |
| **P5** | **Measured** | A standing scenario suite (§5, run by Errantry-PI) scores P2–P4. Each run checks the tool trace, DB state, **on-screen state**, and a musical rubric. Every phase of work moves the scorecard (§6). |

**Non-goals:**
- Replacing the GUI.
- Deterministic "recipe" code paths for matters of taste.
- Hard-coded per-genre templates.
- Promoting tools to the default list without Errantry friction data to justify it.

## 2. Terminology

The word "skill" was overloaded. From now on:

- **Action**: something the LLM can call, i.e. a tool in the `ToolRegistry`. The SDK type `PluginSkill` is an
  action, and `plugin:<pluginId>:<id>` tools are plugin actions.
- **Agent skill**: a *knowledge pack*. It is a markdown `SKILL.md` holding musical know-how, decision heuristics, and
  which actions carry it out. The agent loads it on demand. Skills are knowledge, **not scripts**: the agent still
  chooses roles, plugins and prompts.

## 3. Decisions (2026-09-26)

1. **Agent skills live in a host registry shared by every agent**: the in-app chat, the `sas` CLI and MCP clients all
   use it. It is served through the `ToolRegistry` (`skill_search` / `skill_load`) and built on the existing
   `sas-app/skills/` + `skill-loader.ts`. Plugins contribute their own skills through the SDK (e.g. the bass plugin
   ships `bassline` knowledge next to its `generate_bassline` action).
2. **UI fidelity comes first.** It is a stated MUST, and the headline example (scene focus) is broken today.
3. **The agent controls view state.** A `ui_*` tool category handles view navigation, and every agent mutation
   auto-reveals what it changed. This reverses the earlier rule that UI-only state is excluded.
4. **Ownership:** sas-app work is written as work orders and routed up through sas-mgmt. The chat plugin, SDK and
   plugin fleet are worked by the sas-sdk session.

## 4. Baseline assessment — 2026-09-26 (from reading the code; not yet run)

- **P1 — partial.**
  - About 258 registry tools, about 152 of them hidden behind keyword `tool_search`. The chat agent sees about 72 by
    default.
  - Bass, arp, pad, ensemble, text2voice, synthv, freesound and mix-assets hits expose **no actions**.
  - Texture declares an action with no handler, so it is inert.
  - A plugin action works only if sas-app hand-wires a handler for it (`plugin-skill-handlers.ts` `HANDLERS`).
  - There are no view-state tools.
- **P2 — fails the headline example.**
  - `scene:activated` and the other scene events carry the *engine* item id instead of the DB UUID, so the renderer
    rejects them. The UI snaps back to the old scene, and only a debounced full reload about 500 ms later shows the
    right one.
  - An agent activation skips what a click does: engine track loading, the missing-plugins banner, the pending
    visual, and restarting playback.
  - Async-job tools broadcast when the job *starts*, not when it completes, and drop their domain events.
  - The native MCP server never broadcasts.
  - The `focus-track` / `focus-scene` / `pulse-fx` reveal events have no listeners.
  - No test checks what is on screen.
- **P3 — mostly there.**
  - `EntityResolver` + the `clarification → ask_user` contract are solid.
  - Risk: deferred plugin-action names may not survive the Gemini name shim's round trip.
- **P4 — hard-coded where it matters.**
  - `make_beat` defaults to kicks/bass/keys.
  - `compose_scene` always creates Surge tracks.
  - `revise_*` ignores the plugin that owns the track.
  - No action adds a multi-piece kit to the *current* scene.
  - All the musical know-how lives in a ~17K-char system prompt, and there is no mechanism for knowledge skills.
- **P5 — the harness exists, but it checks the wrong things and currently doesn't run.**
  - Errantry-PI checks events and DB rows only: no on-screen state, no musical rubric.
  - The last trustworthy run was on 2026-05-17 and passed 22 of 113.
  - The July baselines (`latest.json` 2026-07-03: 5 of 120; 2026-07-27: 0 of 80) failed on the environment, with
    about 1 s per test, 0 iterations and 0 tool calls. They measure nothing.
  - Restoring a green, trustworthy Errantry-PI run comes before any score in §6 can be believed.

## 5. North-Star scenario suite

These are the canonical prompts. Each gets seeded with direct tool calls (no LLM in the seed), run through
`/errantry/chat`, and scored against its rubric. Cases that call an LLM run 3× and report a pass rate.

- They are meant to live as specs in `sas-app/errantry-tests-pi/north-star/`.
- A spec is marked `test.fixme` until the capability it needs exists.
- "UI truth" means that `ui_get_view_state`, the DOM probe and the DB agree, sampled over 1.5 s so a snap-back is
  caught.

### P2 — Visual truth

| ID | Seed | Prompt | Pass rubric |
|----|------|--------|-------------|
| NS-01 | 3 scenes (house, techno, ambient); house active | "switch to the techno scene" | DB `active_scene_id` = techno. UI truth: the techno scene is selected, scrolled into view, with no snap-back. The engine plays techno content if it is playing. |
| NS-02 | 1 scene | "create a new scene called Breakdown" | The new scene is in the navigator and selected **after the job completes**. Exactly one full reload, not one at start and one at end. It is revealed. |
| NS-03 | 3 scenes; Intro active | "delete the Intro scene" | Intro is gone from the navigator. The selection moves to a scene that exists. No stale selection. |
| NS-04 | House scene with keys | "add a pad" | After the job completes, the new track row is visible in the panel of the plugin that owns it, and that row is revealed. |
| NS-05 | As NS-01 | NS-01 driven through `sas scene activate` (CLI) and through MCP | The same UI truth as NS-01 on both surfaces. |

### P1 — Total control

| ID | Seed | Prompt | Pass rubric |
|----|------|--------|-------------|
| NS-06 | Any scene | "open the drum panel" | View state: the drum panel is expanded. One `ui_*` call. |
| NS-07 | Scene with a bass track | "show me the bass track" | The owning panel is open and the bass row is revealed. No mutation. |
| NS-08 | Any | "open the master FX" / "open settings" | The drawer or modal is open, according to view state. |
| NS-09 | House scene | "write a bassline with the bass generator" | The new track's `plugin_id` is the bass plugin. It was created through the bass plugin's action, not generic `dsl_generate_midi`. |
| NS-10 | House scene | "add an arpeggio" / "add a pad with the pad plugin" | Each track is owned by the matching plugin (arp / pad). |

### P3 — Precision

| ID | Seed | Prompt | Pass rubric |
|----|------|--------|-------------|
| NS-11 | Scene with a bass track | "mute the bassline" | Bass is muted. **Exactly one** mutating call. No `ask_user`. **No `skill_load`.** |
| NS-12 | Scene with hats | "turn the hats down 3 dB" | The hats' volume changes by −3 dB (±0.5). At most one mutating call. |
| NS-13 | Scene with kick | "solo the kick" | Kick is soloed. UI truth shows the solo. |
| NS-14 | Any | "set the tempo to 124" | BPM is 124, and the transport display shows 124. |
| NS-15 | Two tracks named "pad" | "mute the pad" | An `ask_user` offering both tracks. **No mutation before the user answers.** |

### P4 — Musical interpretation

| ID | Seed | Prompt | Pass rubric |
|----|------|--------|-------------|
| NS-16 | House scene with keys + bass, no drums | "add a beat" | At least 3 new tracks with **distinct** drum roles, each with content, in the **current** scene. Scene count and BPM unchanged. A beat or genre skill is loaded before the first generate call. At most 12 iterations. |
| NS-17 | Empty project | "make me a boom-bap beat" | BPM 80–98. At least 3 drum roles. The boom-bap genre skill is loaded. |
| NS-18 | Scene with a bass track | "give it a darker bassline" | The **same** bass track is revised through the plugin that owns it. Track count and BPM unchanged. The bassline skill is loaded. |
| NS-19 | House scene (124 BPM, full kit) | "make this more like techno" | BPM ends up 125–140. The techno genre skill is loaded. At least one drum track is regenerated, **or** `ask_user` offers options. |
| NS-20 | Full house scene | "give it a drop" | An arrangement skill is loaded. Either a new scene variant is created with a changed energy profile (roles added or removed versus the source), or `ask_user` offers options. |

## 6. Scorecard

Runs are appended here, and each column is a run. `—` means the scenario hasn't been run yet. `fixme` means the
capability it needs doesn't exist yet.

Reference: the last trustworthy Errantry-PI run (2026-05-17, pre-charter suite) passed 22 of 113. The July
baselines failed on the environment, and there is no live run yet for this charter.

| ID | 2026-09-26 (code-read) |
|----|------------------------|
| NS-01 | ✗ expected (scene id mismatch → snap-back) |
| NS-02 | ✗ expected (broadcast fires when the job starts) |
| NS-03 | ✗ expected (the deleted scene stays selected) |
| NS-04 | ✗ expected (no reveal; refresh fires when the job starts) |
| NS-05 | ✗ expected (MCP never broadcasts) |
| NS-06 – NS-08 | fixme (no `ui_*` tools) |
| NS-09 – NS-10 | fixme (no bass / arp / pad actions) |
| NS-11 – NS-14 | — (probably passes) |
| NS-15 | — |
| NS-16 – NS-20 | fixme (no agent skills; composites hard-code their taste) |

## 7. Roadmap (phase order)

Each phase ends with every touched repo's test suite green and the scorecard re-run.

| Phase | Theme | Where the work lives |
|-------|-------|----------------------|
| 0 | This charter, the scenario suite, **getting Errantry-PI to run properly again**, and a live baseline | chat plugin; sas-app (specs) |
| 1 | **Visual truth.** One gateway that executes and then broadcasts. Broadcast when the job completes. Scene events use DB UUIDs. One scene-activation path shared by agent and click. UI-truth tests. | sas-app |
| 2 | **View control + auto-reveal.** Wire up the dead reveal listeners and add a reveal policy. Add `ui_*` tools and `ui_get_view_state`. Ambient context gets an "On screen:" line. SDK: `TrackRow` ids and `onRevealRequest`. | sas-app; SDK; chat plugin |
| 3 | **Agent-skill plumbing.** A shared `AgentSkillRegistry`, `skill_search` / `skill_load`, packaging, and the SDK's `getAgentSkills()`. The chat plugin gets a skill index and a "Suggested skills" ambient line. | sas-app; SDK; chat plugin |
| 4 | **Skill content.** Core skills (generator routing, beat construction, bassline, harmony, melody, arrangement, mixing, sound design, transitions, genre reinterpretation) plus genre packs. The system prompt slims from ~17K to ~9.5K chars and gains a skill protocol. | sas-app/skills; chat plugin |
| 5 | **Composites stop hard-coding taste.** A track realizer that routes to the owning plugin; `add_tracks` for the current scene; no default roles; `revise_*` routes to the owning plugin. | sas-app |
| 6 | **Total coverage.** SDK `invokeSkill()` plus headless panel-core, so plugins dispatch their own actions. Actions and skills for bass, arp, pad, ensemble, vocals, texture… The ledgers count plugin panels. | SDK; plugin fleet; sas-app |
