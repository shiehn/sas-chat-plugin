# Chat Panel Plugin

A [Signals & Sorcery](https://signalsandsorcery.com) plugin that adds a natural-language chat assistant to the workstation. Drives the `sas` CLI iteratively — the same agent-mode experience as Claude Code at a terminal or VS Code agent mode.

<p align="center">
  <img src="assets/iron-bound-tome.png" alt="Signals & Sorcery — Chat Panel" width="420" />
</p>

> Part of the **[Signals & Sorcery](https://signalsandsorcery.com)** ecosystem.

## What it does

A built-in [`GeneratorPlugin`](https://github.com/shiehn/sas-plugin-sdk) that runs an agentic loop in the Electron main process:

```
user message
  └─► host.generateWithLLMTools (Gemini function-calling, via sas-gateway)
       └─► tool calls → invokeSas() → spawn `sas <action> <kvargs>`
            └─► CLI stdout / stderr / exit code → next turn
```

The model decides which CLI tools to call (the same surface external agents use), reads the CLI's structured `remediation` / `prerequisiteChain` / `nextSteps` from stderr, recovers from errors, and iterates until the task is done or the iteration cap is hit.

- **Agentic tool loop** — model reasons about the active scene, calls CLI tools, observes results, recovers from errors, iterates.
- **Scene-scoped** — every action targets the currently active scene; `sceneId` is auto-injected for tools whose schema declares it.
- **Terminal-style action log UI** — message list, streaming tool rows that collapse to a one-line summary on turn completion, click to re-expand.
- **External agent delegation** — exposes a `chat` skill via `getSkills()` so Claude Code, Cursor, and other MCP clients can delegate scene-scoped work to this panel.

### Why subprocess?

Going through the same `sas` CLI subprocess external agents use means:

- **Same agent-legibility surface.** Bare-KV args, real-errors-in-stderr, `(required)/(optional)` markers — every CLI improvement automatically improves the chat panel's behavior.
- **Errantry test coverage applies.** The existing LLM-vs-CLI harness (`errantry-tests/`) keeps the surface tuned for agents — the chat panel inherits that discipline (chat-surface harness extension is a follow-up).
- **No second source of truth.** The chat panel can never drift from what the terminal can do.

The cost is ~80ms × N tool calls per turn (subprocess + HTTP). Acceptable for an interactive chat where the LLM call already dominates latency.

### What's new in 2.0.0

- **Native Gemini function-calling** via `host.generateWithLLMTools` (SDK 2.4.0+) — replaces the prior 290-line custom JSON-protocol-in-text loop.
- **`sas` CLI subprocess as tool surface** — replaces direct `host.executeAppTool` calls that discarded the registry's structured remediation envelope.
- **Renderer ↔ main IPC bridge** — the React panel proxies user messages to the main-process `AgentLoop` and subscribes to streaming `tool_call_*` / `final_text` events.

## Install

From within Signals & Sorcery: **Settings > Manage Plugins > Add Plugin** and enter:

```
https://github.com/shiehn/sas-chat-plugin
```

Or install via npm for embedding in a host build:

```bash
npm install @signalsandsorcery/chat-plugin
```

Peer dependencies: `react`, `react-dom`, `@signalsandsorcery/plugin-sdk` (>=2.4.0).

## Capabilities

| Capability | Required |
|------------|----------|
| `requiresLLM` | Yes — agent loop calls `host.generateWithLLMTools` |

## Usage

The plugin registers itself when loaded by the Signals & Sorcery plugin registry:

```typescript
import { ChatPanelPlugin } from '@signalsandsorcery/chat-plugin';
import chatManifest from '@signalsandsorcery/chat-plugin/plugin.json';

const plugin = new ChatPanelPlugin();
await registry.register(plugin, chatManifest, { sortOrder: 4 });
await registry.activate(plugin.id, pluginHost);
```

External agents can delegate to the panel over MCP via the `chat` skill:

```
agent → plugin:@signalsandsorcery/chat-panel:chat
        { message: "add reverb to the bass and make drums punchier" }

  → main-process AgentLoop runs, drives the sas CLI, returns the summary
    + the streamed event log
```

## Development

Built with the [@signalsandsorcery/plugin-sdk](https://github.com/shiehn/sas-plugin-sdk). See the [Plugin SDK docs](https://signalsandsorcery.com/plugin-sdk/) for the full API reference.

```bash
npm install
npm test          # Jest — unit + @testing-library/react
npm run typecheck
npm run lint
npm run build     # tsup → dist/ (ESM + CJS + .d.ts)
```

## Structure

```
src/
├── index.ts              # barrel export
├── plugin.tsx            # ChatPanelPlugin class — lifecycle, UI, skills
├── plugin.json           # Manifest for the SAS plugin registry
├── agent-loop.ts         # Native-tool-use loop (Gemini function-calling)
├── sas-tool-handler.ts   # `sas` CLI subprocess wrapper
├── panel-tools.ts        # host.listAppTools() → LLMTool[] + executor
├── ui/
│   ├── ChatPanel.tsx     # Root component (terminal-style log + input)
│   ├── TerminalLog.tsx
│   ├── InputBox.tsx
│   ├── format-result.ts  # renders structured tool results inline
│   └── types.ts
└── __tests__/            # Jest tests (unit + RTL)
```

## Architecture

The plugin requires SDK 2.4.0+ for two new `PluginHost` methods:

| Method | Purpose |
|---|---|
| `generateWithLLMTools(req)` | Gemini-native function-calling via the gateway's passthrough endpoint. Plugins never see the API key. |
| `getCliPaths()` | Returns `{ appExe, cliEntry }` for spawning the bundled `sas` CLI. |

The host's `generateWithLLMTools` posts to `<sas-gateway>/v1/gemini/v1beta/models/{model}:generateContent`, which forwards verbatim to Google after adding the central API key.

Subprocess invocation uses the same `electronExe + ELECTRON_RUN_AS_NODE=1 + cliEntry` pattern as `sas-assistant`'s CLI installer — works in dev and packaged builds without depending on the user having `sas` on their shell PATH.

## The Signals & Sorcery Ecosystem

- **[Signals & Sorcery](https://signalsandsorcery.com)** — the flagship AI music production workstation
- **[sas-plugin-sdk](https://github.com/shiehn/sas-plugin-sdk)** — TypeScript SDK for building generator plugins
- **[sas-synth-plugin](https://github.com/shiehn/sas-synth-plugin)** — AI MIDI generation with Surge XT
- **[sas-sample-plugin](https://github.com/shiehn/sas-sample-plugin)** — Sample library browser with time-stretching
- **[sas-audio-plugin](https://github.com/shiehn/sas-audio-plugin)** — AI audio texture generation
- **[sas-recorder-plugin](https://github.com/shiehn/sas-recorder-plugin)** — Loop-aware microphone recording
- **[DeclarAgent](https://github.com/shiehn/DeclarAgent)** — Declarative agent + MCP transport for S&S

<p align="center">
  <a href="https://signalsandsorcery.com">signalsandsorcery.com</a>
</p>

## License

MIT
