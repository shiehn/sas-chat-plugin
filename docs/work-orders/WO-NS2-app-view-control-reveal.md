# WO-NS2 (sas-app): View control + auto-reveal

**From:** sas-sdk · **Route:** via sas-mgmt → sas-app · **After:** WO-NS1 (it relies on UUID scene events, the
execute gateway and provenance) · **Charter:** `sas-chat-plugin/docs/NORTH-STAR.md` P1/P2
**Scenarios this moves:** NS-04, NS-06..08 · **SDK half: done in 3.20.0** (uncommitted, see below)

## Steve's decision (2026-09-26)
The agent controls view state, through a `ui_*` tool category plus auto-reveal: every agent mutation reveals what it
changed. This reverses the earlier rule that UI-only state is excluded.

## The SDK half, already written (3.20.0)
- **Row attributes.** `TrackRow` renders `data-track-id` (engine id), `data-track-db-id` and `data-track-role` on
  `[data-testid="sdk-track-row-wrapper"]`. Panel-core passes `dbId`. Monolith panels (drum, instrument, loops) need
  their own one-line pass-through; sas-sdk handles that in the fleet.
- **Reveal requests.** `PluginHost.onRevealRequest?(listener)` delivers
  `PluginRevealRequest { trackId?, trackDbId?, drawerTab?, requestId? }`. `useGeneratorPanelCore` subscribes and opens
  the drawer to the requested tab, running the same lazy loads a click does. It ignores requests for tracks it doesn't
  own. `findRevealTrackId` is exported for monolith panels.
- **Host split.** The host opens the panel and scrolls to / pulses the row, finding it through the attributes. The
  panel applies only the state it owns.

## Host tasks
1. **Wire the reveal listeners that have none today** (`UIOrchestrator.tsx:~96-107`).
   - `orchestrator:focus-scene`: in `VerticalSceneNavigator`, scroll to the scene and pulse it with
     `data-reveal="pulse"` for 1.2 s.
   - `focus-track`: open the owning panel (use `tracks.plugin_id` and `LEGACY_SECTION_ALIASES`), then run
     `querySelector('[data-track-db-id="…"]')`, scroll the row into view and pulse it.
   - `pulse-fx`: `focus-track`, then `onRevealRequest({ trackDbId, drawerTab: 'fx' })`.
   - `panel:order-changed`: add a handler.
   - `ArrangerPanel`: refresh on `scene:*` events instead of only polling every 60 s.
   - Add a static guard test: every `orchestrator:*` window event has a listener outside `orchestration/`.
2. **Implement `onRevealRequest` on the renderer plugin host** (`renderer-plugin-host.ts`, next to
   `onAfterAgentMutation` at ~:1123). Fan each request out to every panel; each panel filters by track.
3. **Reveal policy,** in `src/renderer/orchestration/reveal-policy.ts`:
   - Never reveal when provenance is `'user'` (tools-mcp IPC must stamp `'user'`; WO-NS1 1a).
   - Reveals only scroll, expand or pulse. Only events that mean main changed the active scene may activate a scene.
     Drop the scene selection from `handleTrackSceneChanged`.
   - **Idle guard:** if there was pointer, key or wheel input outside the chat panel in the last 1.5 s, or a non-chat
     input or modal has focus, queue the reveal. If it has waited more than 5 s, show a "Show" toast instead.
   - Reveal only the last target of a job or batch; `workflow:completed` flushes the queue.
   - Add `autoReveal: 'always' | 'when-idle' | 'off'` to `OrchestrationPolicy`, defaulting to `when-idle`.
   - Respect `prefers-reduced-motion`.
4. **`ui_*` tools** in `src/main/tools/ui-navigation-tools.ts`. Add a new `ToolDefinition.viewOnly` flag: such a tool
   may emit only `ui:*` events, and it never triggers the full reload, bumps `mutationSeq`, creates a checkpoint or
   marks the document dirty.
   - **Round trip:** `ui:navigate { requestId, target }`, then the renderer applies it and acks through
     `electronAPI.ui.ack` (using `setTimeout`, not rAF). If there is no ack within 2 s, return `success:false` with a
     remediation.
   - `ui_select_track {track}`: resolve with `findTrackBySelector`, open the owning panel, reveal the row. If the
     track is in another scene, error with a `scene_activate` next step. Never change what's playing silently.
   - `ui_open_panel {panel}`.
   - `ui_toggle_master_fx {open}` (`LoopWorkstation.tsx:~189`).
   - `ui_open_settings {open, section?}`: reuse the `openSettings` window event and add close.
   - `ui_set_layout {expandedColumn}` (`useDeckColumnResize.toggleExpand`). The legacy-deck localStorage flag is
     `dev-only` and stays excluded.
   - `ui_get_view_state` (readOnly): the snapshot plus
     `consistency { dbActiveSceneId, deckSceneId, domActiveSceneId, consistent }`.
   - No `ui_focus_scene`: on the left deck, `scene_activate` is the click equivalent.
5. **View-state reporting.** `src/renderer/orchestration/view-state-reporter.ts` builds the snapshot (active scene
   from the deck and the DOM probe, expanded sections, Master FX, settings, layout). It sends
   `ipcRenderer.send('ui:view-state', …)`, debounced to 100 ms, to `src/main/services/view-state-service.ts`, which
   keeps a `viewSeq`. Add `ui: { reportViewState, ack }` to the preload.
6. **Ledgers and rules.**
   - `ui:navigate` goes into `document-dirty-service` `TRANSIENT_EVENTS` and into the orchestration handler map.
   - Add a new `ui-affordance-ledger.ts` with a guard test: every `UiNavigateTarget` kind has a tool, a handler and a
     ledger entry.
   - Re-check the `pure-ui` entries in `tool-coverage-ledger.ts`; many are really navigation.
   - Add `onRevealRequest` to `plugin-host-coverage-ledger.ts` as `event-subscription`.
   - Update tool-authoring skill §9 "UI fidelity": reveals only scroll, expand or pulse.
7. **Mirror SDK 3.20.0 into `src/shared/types/plugin-sdk.types.ts`**: `onRevealRequest`, `PluginRevealRequest`, and
   `TrackRow`'s `track.dbId`. The graph has `app:plugin-host` queued for review.

## Tests / acceptance
- Reveal policy unit tests with fake timers.
- The static listener guard.
- `ui_*` round-trip tests, including the ack timeout.
- `cli-ui-parity/ui-navigation.spec.ts`.
- `expectUiTruth` extended to view state.
- NS-06..08 un-fixme'd and passing. NS-04 shows the new row revealed after the job completes.
- `cd sas-app && npm test` green before and after.
- Once `ui_get_view_state` exists, sas-sdk adds an "On screen: …" ambient line in the chat plugin.
