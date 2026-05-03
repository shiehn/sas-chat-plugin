# Chat Panel Plugin

A [Signals & Sorcery](https://signalsandsorcery.com) plugin that adds a natural-language chat assistant to the workstation. Scene-scoped, agentic, and tool-aware.

<p align="center">
  <img src="assets/iron-bound-tome.png" alt="Signals & Sorcery — Chat Panel" width="420" />
</p>

> Part of the **[Signals & Sorcery](https://signalsandsorcery.com)** ecosystem.

## What it does

- **Agentic tool loop** — the LLM reasons about the active scene, calls tools (mute, FX, MIDI, compose), observes results, and iterates. Scene context refreshes after every mutation so the agent never reasons from stale state.
- **Tool surface** — wraps 12+ `PluginHost` methods as typed tool definitions the agent can call, with `mutates: true` flags so the loop knows when to refresh context.
- **Scene-scoped** — every action targets the currently active scene; no cross-scene leakage.
- **Accordion panel UI** — message list, action log, input box. React + `@testing-library/react`.
- **External agent delegation** — exposes a `chat` skill via `getSkills()` so Claude Code, Cursor, and other MCP clients can delegate scene-scoped work to this panel.

## Install

From within Signals & Sorcery: **Settings > Manage Plugins > Add Plugin** and enter:

```
https://github.com/shiehn/sas-chat-plugin
```

Or install via npm for embedding in a host build:

```bash
npm install @signalsandsorcery/chat-plugin
```

Peer dependencies: `react`, `react-dom`, `@signalsandsorcery/plugin-sdk`.

## Capabilities

| Capability | Required |
|------------|----------|
| `requiresLLM` | Yes — agent loop calls `host.generateWithLLM` |

## Usage

The plugin registers itself when loaded by the Signals & Sorcery plugin registry:

```typescript
import { ChatPanelPlugin } from '@signalsandsorcery/chat-plugin';
import chatManifest from '@signalsandsorcery/chat-plugin/plugin.json';

const plugin = new ChatPanelPlugin();
await registry.register(plugin, chatManifest, { sortOrder: 4 });
await registry.activate(plugin.id, pluginHost);
```

Agents can delegate work to the panel over MCP:

```
agent → plugin:@signalsandsorcery/chat-panel:chat
        { message: "add reverb to the bass and make drums punchier" }

  → plugin runs its agentic loop, emits tool calls, returns summary
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
