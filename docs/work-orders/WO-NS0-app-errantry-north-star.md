# WO-NS0 (sas-app): Get Errantry-PI running properly again + add the North-Star scenario specs

**From:** sas-sdk (chat plugin) · **Route:** via sas-mgmt → sas-app · **Charter:** `sas-chat-plugin/docs/NORTH-STAR.md`
**Priority:** P1. Every later phase is scored with this suite, so it has to run properly first.

## Why

The chat charter (P5, "Measured") depends on Errantry-PI. The suite has not produced a usable run since 2026-05-17
(22/113 passed):

- `errantry-tests-pi/baselines/latest.json` (2026-07-03): 5/120 passed.
- `baselines/2026-07-27T04-09-18-996Z.json`: 0/80 passed.
- In both, every test took ~1 s with **0 iterations and 0 tool calls**, so these were environment failures, not
  measurements.

## Tasks

1. **Find why PI runs fail on the environment**, and make the runner fail loudly instead of recording a bogus baseline.
   - Look first at the bridge not being installed, missing `ERRANTRY_AUTO_CONSENT`, auth, and the chat plugin not
     activating.
   - Fix: `00-wiring-smoke` should abort the run, and the baseline writer should refuse to write when
     `aggregate.toolCalls === 0`.
2. **Take a fresh full PI baseline.** Save it as `baselines/before-north-star.json`.
3. **Add `errantry-tests-pi/north-star/`.** Put one spec per scenario NS-01…NS-20 there, with the seeds and rubrics
   from `sas-chat-plugin/docs/NORTH-STAR.md` §5.
   - Seed with direct tools (no LLM).
   - Run the LLM-driven cases 3×, and report the pass rate.
   - Mark `test.fixme` any case whose capability doesn't exist yet. Expected fixme today: NS-06..10 (no `ui_*` tools,
     no bass/arp/pad actions) and NS-16..20 (no agent skills).
   - Until WO-NS1 adds `ui_get_view_state`, UI-truth rubrics can assert DB `active_scene_id` plus the event stream
     only. Leave a `// TODO(WO-NS1): toMatchUiTruth` marker.
4. **Fix `composite-natural-refs.spec.ts:80-94`** ("Switch to the techno scene"). It should assert
   `projects.active_scene_id` is the techno scene, not just that some tool with "activate" in its name was called.
5. **Link the charter from `sas-app/docs/chat-cli-architecture.md`**, one line: "Product direction:
   `sas-chat-plugin/docs/NORTH-STAR.md`".

## Acceptance

- `npm run test:errantry-pi:smoke` passes.
- The full PI run records a non-zero `aggregate.toolCalls`.
- `before-north-star.json` is committed, pending Steve's word.
- The north-star specs run: they pass, fail on a real rubric, or are fixme. None may fail because of the environment.
- Report the pass/fail per NS id back up to mgmt. sas-sdk will fill in the scorecard (`NORTH-STAR.md` §6).
- `cd sas-app && npm test` is green before and after the change. Errantry stays out of `npm test`.

## Notes

- The live app currently runs without `ERRANTRY_TEST=1`; `/errantry/health` returns 404. Boot per the `errantry`
  skill: `ERRANTRY_TEST=1 ERRANTRY_AUTO_CONSENT=1 ENABLE_TEST_SERVER=true npm run electron:dev`.
- Costs real Gemini tokens (~$0.05–0.15 per run).
