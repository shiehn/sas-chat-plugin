# WO-NS3 (sas-app): A shared agent-skill registry and `skill_*` tools

**From:** sas-sdk · **Route:** via sas-mgmt → sas-app · **Can run in parallel with WO-NS1/NS2** (it doesn't depend on
them) · **Charter:** `sas-chat-plugin/docs/NORTH-STAR.md` P4 · **Scenarios:** NS-16..20
**SDK contract: done in 3.20.0** (uncommitted). The `PLUGIN_SDK_VERSION` constant in
`src/shared/constants/sdk-version.ts` was bumped to 3.20.0 as part of the SDK's version cascade.

## Steve's decision (2026-09-26)
Agent skills (knowledge packs) live in a **host registry shared by every agent**: the in-app chat, the `sas` CLI and
MCP. They are served through the `ToolRegistry`, and plugins contribute their own through the SDK. The point is that
the agent can interpret "add a beat" or "make it darker" from knowledge it loads when needed, rather than from recipes
in code.

## What already exists (build on it; don't start over)
- **Built-in skills:** 9 of them in `sas-app/skills/*/SKILL.md` (sas-terminology, mir-\*, dsp-\*), loaded by
  `src/main/services/skill-loader.ts` (flat frontmatter parser; the directory name must equal `name`).
- **Host methods:** `listAgentSkills` / `readAgentSkill` (`plugin-host-mixins/host-services.ts:~636`). No tool wraps
  them, the ledger (`plugin-host-coverage-ledger.ts:~519`) excludes them, and no agent calls them.
- **Packaging gap:** `resolveDefaultSkillsDir()` points at `__dirname/../../../skills`, but `build.files` has only
  `dist/**` and there is no `extraResources` entry. **Packaged builds ship no skills today.**

## The SDK 3.20.0 contract (sas-plugin-sdk)
- **`GeneratorPlugin.getAgentSkills?(): PluginAgentSkill[]`**, where `PluginAgentSkill` is `{ name, description,
  whenToUse?, category?, tags?, genres?, roles?, relatedActions?, relatedTools?, relatedSkills?, body }`.
- **`AgentSkillMetadata`** gains typed optional fields (`whenToUse`, `category`, `tags`, `genres`, `roles`,
  `relatedTools`, `relatedSkills`, `source`, `pluginId`). **`AgentSkillManifest.rootDir` / `skillMdPath`** become
  optional.
- **Helpers to reuse, not re-implement:**
  - `AGENT_SKILL_LIMITS`
  - `validatePluginAgentSkills(skills, { actionIds })`
  - `resolveAgentSkillActionTokens(body, pluginId)`, which rewrites `{{action:x}}` to `plugin:<pluginId>:x`
  - `isValidAgentSkillName`

## Tasks
1. **`src/main/services/agent-skill-registry.ts`** (singleton).
   - **Sources:** builtin (via `SkillLoader`) and plugin. Leave room for `user` (`{userData}/agent-skills/`).
   - **Each entry carries** `source`, `pluginId?`, `trust` (`first-party` / `third-party`), and `availableTools` /
     `unavailableTools`, both resolved at load time against the live registry.
   - **Name collisions:** a builtin skill wins, and the colliding plugin skill is rejected with the problem recorded.
     Reject any plugin skill for which `validatePluginAgentSkills` reports problems.
   - **Plugin lifecycle** (`plugin-registry.ts`): in `activate()`, next to where `getSkills` is collected, call
     `registerPluginSkills(pluginId, plugin.getAgentSkills?.())`. In `deactivate()`, call `unregisterPlugin`. Each
     emits `agent-skills:changed`.
   - `listAgentSkills` / `readAgentSkill` delegate to the registry. `readAgentSkill` returns plugin bodies with their
     tokens already resolved.
2. **Packaging.** Add `extraResources: { from: "skills/", to: "agent-skills/" }`. Resolve the folder as
   `app.isPackaged ? join(process.resourcesPath, 'agent-skills') : <dev path>`. Add a test that the entry exists.
3. **Frontmatter.** Extend the flat parser to accept inline `[a, b]` lists and the new keys: `when_to_use`,
   `category`, `tags`, `genres`, `roles`, `related_tools`, `related_skills`, mapped to the camelCase metadata fields.
   No YAML dependency.
4. **Tools** in `src/main/tools/agent-skill-tools.ts`, registered in `register-all-tools.ts`:
   - `skill_search({query, category?, genre?, limit=5})`: read-only, `scope:'scene'`, **not deferred** (same
     visibility as `tool_search`). Score like `tool-search.ts`, with boosts for tags and genres.
   - `skill_load({name | names[], section?, file?})`: read-only and not deferred. `file` reads only inside a builtin
     skill's own folder, which avoids `fs_read_file`'s consent dialog.
   - `skill_list({category?})`: deferred.
   - Set `cli.command` so `sas skill search|load|list` generates itself. MCP exposes skills as `sas-skill://<name>`
     resources.
   - `tool_search` results gain a `relatedSkills` array.
5. **Truncation.** Exempt `skill_load` by tool name from the 4K truncation, with a ~12K cap of its own, in
   `src/shared/utils/operation-result-truncate.ts`. sas-sdk mirrors this in the chat plugin's `truncateForLLM`
   (`truncate-parity.test.ts` guards the pair), so land both together.
6. **Musical context.** Add `genre` to `readMusicalContext` (`inspect-tools.ts:~563`). The chat plugin's ambient
   "Suggested skills" line matches the scene's genre against each skill's `genres`.
7. **Ledger and lint.**
   - Flip the `listAgentSkills` / `readAgentSkill` ledger entries from excluded to mapped
     (`tools: ['skill_list', 'skill_load']`).
   - New `agent-skill-catalog.test.ts`: frontmatter is valid, body ≤10K, and every backticked tool name in a skill
     body is registered (same pattern as `chat-promoted-tools-exist.test.ts`). That keeps skills from rotting as tools
     change.
8. **Mirror SDK 3.20.0** into `src/shared/types/plugin-sdk.types.ts`: `getAgentSkills`, `PluginAgentSkill`, the
   extended `AgentSkillMetadata`, and the optional manifest paths.

## Not in this WO
- **Skill content** (beat-construction, bassline-writing, the genre packs, …): chat Phase 4. sas-sdk writes the
  skills and they land in `sas-app/skills/`.
- **Chat-plugin wiring** (L1 index, "Suggested skills" ambient line, prompt slimming, kill switch): sas-sdk.
- **Removing the hard-coded defaults from the composites** (`make_beat`'s default roles, `compose_scene` always
  using Surge, `add_tracks`): WO-NS5.

## Tests / acceptance
- Registry unit tests covering: sources, collisions, plugin register/unregister, token resolution, invalid plugin
  skills rejected.
- Tool tests.
- The packaging test.
- `tool-surface-parity.test.ts` green, since every agent surface has to see the same `skill_*` tools.
- The catalog lint.
- `cd sas-app && npm test` green before and after.
- `sas skill list` works against a running app.
