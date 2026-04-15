# @signalsandsorcery/chat-plugin

AI-powered chat panel plugin for [Signals & Sorcery](https://signalsandsorcery.com).
Scene-scoped natural-language audio manipulation via the Signals & Sorcery
Plugin SDK.

## What it is

A built-in [`GeneratorPlugin`](https://github.com/shiehn/sas-plugin-sdk) that
provides:

- **Agentic tool loop** — LLM reasons about the active scene, calls tools
  (mute/fx/midi/compose), observes results, iterates. Reinforcement-injected:
  scene context refreshes after every mutation so the agent never reasons
  from stale state.
- **LLM adapter** — bridges `PluginHost.generateWithLLM` (text I/O) to a
  structured tool-calling interface via a strict JSON protocol, with
  graceful fallback to plain text when the LLM goes off-protocol.
- **Panel tool surface** — wraps 12+ PluginHost methods as typed tool
  definitions the agent can call. Includes `mutates: true` flags so the
  agent loop knows when to refresh scene context.
- **React UI** — accordion panel with message list, action log, input box.
  Tested with `@testing-library/react`.
- **External agent delegation** — exposes a `chat` skill through
  `getSkills()` so Claude Code, OpenClaw, Cursor, etc. can delegate
  scene-scoped work to this panel over the shared MCP surface.

See `sas-assistant/docs-ai-planning/ai-orchestration-design.md` Section
14–15 for the full design.

## Install

```bash
npm install @signalsandsorcery/chat-plugin
```

Peer dependencies: `react`, `react-dom`, `@signalsandsorcery/plugin-sdk`.

## Usage

The plugin registers itself when loaded by the Signals & Sorcery plugin
registry. From the host app:

```typescript
import { ChatPanelPlugin } from '@signalsandsorcery/chat-plugin';
import chatManifest from '@signalsandsorcery/chat-plugin/plugin.json';

const plugin = new ChatPanelPlugin();
await registry.register(plugin, chatManifest, { sortOrder: 3 });
await registry.activate(plugin.id, pluginHost);
```

Agents can delegate work to the panel over MCP:

```
agent → plugin:@signalsandsorcery/chat-panel:chat
        { message: "add reverb to the bass and make drums punchier" }

  → plugin runs its agentic loop, emits tool calls, returns summary
```

## Development

```bash
npm install
npm test          # Jest — unit + @testing-library/react
npm run typecheck
npm run lint
npm run build     # tsup produces dist/ (ESM + CJS + .d.ts)
```

## Structure

```
src/
├── index.ts              # barrel export
├── plugin.tsx            # ChatPanelPlugin class (GeneratorPlugin)
├── plugin.json           # Manifest for the SAS plugin registry
├── chat-agent.ts         # Agentic tool-loop (LLM ↔ tools ↔ reinforcement)
├── llm-adapter.ts        # PluginHost.generateWithLLM ↔ structured tools
├── panel-tools.ts        # PluginHost methods as ChatAgentTool defs
├── ui/
│   ├── ChatPanel.tsx     # Root component (message list + input + action log)
│   ├── MessageList.tsx
│   ├── MessageItem.tsx
│   ├── InputBox.tsx
│   ├── ActionLog.tsx
│   └── types.ts
└── __tests__/            # Jest tests (unit + RTL)
```

## License

MIT
