# WO-NS1 (sas-app): Visual truth — an agent action behaves exactly like a user click

**From:** sas-sdk (chat plugin) · **Route:** via sas-mgmt → sas-app · **Charter:** `sas-chat-plugin/docs/NORTH-STAR.md` P2
**Priority:** P1. Steve picked this as the first workstream (2026-09-26).
**Scenarios this moves:** NS-01..NS-05.

## Requirement (Steve)

> "The chat interface should be able to control 100% of signals and sorcery app via text/prompt. And when it does the
> UI state MUST reflect that. For example if we switch the scene in focus the appropriate scene should be visually
> loaded and in focus, not just internally."

## What's broken (from reading the code; verify before changing anything)

1. **Wrong scene id in events.** `scene_activate` emits `scene:activated { sceneId: sceneCheck.sceneId }`
   (`src/main/tools/scene-operations.ts:~692`). That id is the **engine item id**. `findSceneBySelector`
   (`tools/lib/prerequisites.ts:~636-659`) returns `sceneId` = engine id, while `sceneName` and `dbSceneId` hold the
   DB UUID.
   - In the renderer, `UIOrchestrator` → `handleSceneActivated` calls `setDeckScene('left', <engine id>)`.
     `LoopWorkstation` `effectiveSceneId` (~:717-725) rejects it, and the follow-effect (~:696-711) snaps back to the
     stale scene and sends `deck:setActiveScene(OLD)`.
   - The right scene appears only ~500 ms later, via the debounced catch-all `reloadTracks()` (~:1378).
   - Visible result: new → old → new. If the deck is playing, the old scene may briefly be re-activated, which could be
     audible.
   - The same bug affects `scene:created` (scene-operations ~:198, `compose-scene.ts:~200`), `scene:deleted` (~:849;
     a deleted scene stays selected), compose-contract (~:307/444), `deck:scene-loaded` (`deck-load-tools.ts:~99`) and
     `play_scene` (`play-scene.ts:~220`).
2. **The agent path skips what a click does.** `handleSceneSwitch` (`LoopWorkstation.tsx:~2958-3136`) handles:
   `loadSynthTracksToEngine` / `audioTrack.loadToEngine`, the missing-plugins banner, the pending-scene visual, and
   restarting playback.
3. **Async-job tools** (`src/main/services/async-job-helper.ts:218-293`):
   - They never forward `outcome.data.events` to the `DomainEventBus`, even though `tool-registry.ts:~278` says they
     do.
   - The catch-all broadcast fires when the job *starts*, so the UI reloads before the work exists.
   - About 25 tools are affected: scene_create, compose_scene, add_instrument, MIDI generation, FX chains, make_beat…
   - Three tools work around this by emitting events manually: `arranger-tools.ts:681`,
     `audio-texture-tools.ts:263`, `ableton-export-tools.ts:29`.
4. **Native MCP** (`src/main/mcp-server.ts:~336`) calls `registry.execute` and never broadcasts.
5. **HTTP/CLI mutations** (`api-server.ts:~354`) call `this.mutationBroadcaster` directly instead of
   `broadcastMutation()`. As a result `mutationSeq` doesn't bump and the chat plugin's ambient cache goes stale.
6. **Arranger `tools:execute` IPC** (`ipc-handlers/tools-mcp.ts`) passes no provenance, so it defaults to `'system'`.
   Auto-reveal (WO-NS2) would then fire on the user's own actions.
7. **Tests.** `tests/e2e-electron/cli-ui-parity/` can't pass:
   - they read `sceneId` from the async `scene_create` result, which holds only a jobId;
   - they compare the engine id with the DOM's UUID `data-scene-id`;
   - they still say "REAPER".

## Design (proposed; sas-app owns the final call)

- **1a. Gateway.** Add `executeToolWithBroadcast(name, params, opts)` in `services/mutation-broadcaster.ts`. It calls
  `registry.execute`, then `broadcastMutation`. It skips the broadcast for `readOnly` tools and for async-start
  responses.
  - Use it from all four entry points: `api-server.ts:~340` (keep its SSE `mutation` event),
    `host-services.ts:~554`, `tools-mcp.ts:~173` (stamp `provenance:'user'` there) and `mcp-server.ts:~336`.
  - Move the bus → renderer `domain:event` relay out of `api-server.ts:~117` into `index.ts`, so it survives an API
    bind failure.
- **1b. Job completion.** In `startAsyncJob`:
  - Capture provenance synchronously, before `enqueueWorkflow`.
  - On `outcome.ok`, stamp each event in `outcome.data.events` with `{provenance, jobId}`, call
    `DomainEventBus.emitAll`, then `broadcastMutation('tool-executed', {action, jobId, phase:'completed', result})`.
  - Broadcast nothing on failure.
  - Delete the three manual emits.
  - Add the completion-time `emits` contract check.
- **1c. UUID everywhere.** Scene event payloads carry `sceneId` = `loop_sections.id`, plus an optional
  `engineSceneId`.
  - Add a helper `sceneEventPayload(sceneCheck)` in `prerequisites.ts`.
  - Under `SAS_STRICT_EVENT_CONTRACT=1`, `ToolRegistry` warns when a `scene:*` `sceneId` isn't UUID-shaped.
  - `scene:created` gains `activated:true`.
  - The `LoopWorkstation` follow-effect uses `setDeckScene(..., {syncBackend:false})`: it mirrors main and never
    writes back.
  - Check the other consumers of engine ids: `PerformanceStackContext`, `sidechain-refresh-service`, and the SSE
    consumers (sas-cli, push-bridge).
- **1d. One activation path.**
  - **Main:** `services/scene-activation-service.ts` `activateScene(dbSceneId, {deckId:'loop-a'})`. It does the engine
    mutes (moved from scene-operations ~:659-677), `projectBindingService.switchActiveScene`,
    `PlaybackRuleEngine.setActiveContent` plus loop-bar sync (pulled out of `deck.ts:~763-812`), and emits
    `scene:activated`. It is idempotent: if the scene is already active, it does nothing and emits nothing.
  - **Main callers:** `scene_activate`, `play_scene`, and the `deck:setActiveScene` and `switch-active-scene` IPCs.
  - **Renderer:** pull `handleSceneSwitch` out into `useSceneActivation().activateScene(id, {origin:'user'|'remote'})`.
    - In remote mode, skip the writes back to main but run everything else a click runs.
    - If the id isn't in `project.scenes` yet (the scene was just created), run `reloadTracks()` first.
  - **Renderer callers:** the orchestrator's `scene:activated`, `scene:created{activated}` and `deck:scene-loaded`
    (loop-a) handlers dispatch `orchestrator:activate-scene`, buffered like `expand-section-buffer.ts`. Only the
    **left-deck** `LoopWorkstation` handles it.
  - Activation during playback must go through the existing deferred track-loading path.

## Tests / acceptance

- **Unit:**
  - every `scene:*` emit site carries a UUID;
  - async-job events are forwarded exactly once, with provenance, and broadcast once on success and not at all on
    failure;
  - a dependency-queued job keeps its original provenance;
  - MCP broadcasts for mutating calls only;
  - a static test that all 4 entry points use the gateway;
  - renderer: `useSceneActivation` in remote mode never calls `projectBinding.switchActiveScene` or
    `deck.setActiveScene`, and the follow-effect never writes to main;
  - a static guard that every `orchestrator:*` window event has a listener outside `orchestration/`.
- **E2E (`cli-ui-parity`):**
  - add `cli.executeAndWait()`: if the result holds `changes.jobId`, call `wait_for_job` and return the completed
    result;
  - compare UUIDs;
  - add `expectUiTruth(app)`: deck-selected scene = DOM active scene = DB `active_scene_id`, sampled for 1.5 s so a
    snap-back fails.
- **Manual:** in chat, "switch to the <x> scene". The scene is highlighted and scrolled into view with no flicker.
  Repeat with `sas scene activate <x>` and via MCP.
- `cd sas-app && npm test` green before and after. Update the north-star specs NS-01..05 (WO-NS0), then re-run and
  report the scores up to mgmt.

## Rules to update

- `.claude/skills/tool-authoring/SKILL.md`:
  - §8: every entry point goes through the gateway; broadcast when the job completes; scene events carry the DB UUID.
  - New §9 "UI fidelity": any mutation that has a click equivalent runs the same renderer path.
- `CLAUDE.md` Deck Playback Rules: note that selecting a scene on the left deck changes what you hear.
- `docs/chat-cli-architecture.md:~484`: the claim "one broadcast contract for every path" becomes true, so keep it and
  cite the gateway.

## Follow-on (separate WO-NS2, after this lands)

- Wire the dead reveal listeners and add a reveal policy.
- Add the `ui_*` view tools and `ui_get_view_state` (Steve approved view control + auto-reveal).
- The SDK half (`TrackRow` `data-track-id`, `onRevealRequest`) is done by sas-sdk.
