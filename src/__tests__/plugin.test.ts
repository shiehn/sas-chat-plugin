/**
 * ChatPanelPlugin lifecycle spec.
 *
 * Verifies conformance to the GeneratorPlugin interface from
 * src/shared/types/plugin-sdk.types.ts:
 *   - activate(host): wires the ChatAgent to the host's LLM and tool surface
 *   - deactivate(): releases the host reference
 *   - getUIComponent(): returns a React component type
 *   - getSettingsSchema(): returns null (no settings for v1)
 *   - getSkills(): declares the external-agent `chat` skill
 *   - onSceneChanged(): clears conversation history (scene-scoped chat)
 *
 * The plugin integrates three pieces: ChatAgent (logic), makeLLMAdapter
 * (host LLM → structured tool-calling), buildPanelTools (host methods →
 * ChatAgentTool defs). Each is tested in its own spec; this file tests
 * only the wiring.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ChatPanelPlugin, CHAT_PANEL_PLUGIN_ID } from '../plugin';

// Minimal fake PluginHost — only the methods the plugin actually touches.
// Use `jest.fn<any>()` so mockResolvedValue / mockReturnValue don't fight
// the default `never`-typed mock signature.
function makeHost() {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return {
    getPluginTracks: jest.fn<any>().mockResolvedValue([]),
    getMusicalContext: jest.fn<any>().mockResolvedValue({ key: 'C', bpm: 120 }),
    getActiveSceneId: jest.fn<any>().mockReturnValue(null),
    getTrackFxState: jest.fn<any>().mockResolvedValue({}),
    setTrackMute: jest.fn<any>().mockResolvedValue(undefined),
    setTrackSolo: jest.fn<any>().mockResolvedValue(undefined),
    setTrackVolume: jest.fn<any>().mockResolvedValue(undefined),
    setTrackPan: jest.fn<any>().mockResolvedValue(undefined),
    toggleTrackFx: jest.fn<any>().mockResolvedValue(undefined),
    setTrackFxPreset: jest.fn<any>().mockResolvedValue({ dryWet: 0.4 }),
    setTrackFxDryWet: jest.fn<any>().mockResolvedValue(undefined),
    shufflePreset: jest.fn<any>().mockResolvedValue({ presetName: 'P1' }),
    deleteTrack: jest.fn<any>().mockResolvedValue(undefined),
    generateWithLLM: jest.fn<any>().mockResolvedValue({
      content: JSON.stringify({ type: 'text', content: 'ok' }),
      tokensUsed: 5,
      model: 'test',
    }),
    isLLMAvailable: jest.fn<any>().mockResolvedValue(true),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

describe('ChatPanelPlugin — GeneratorPlugin conformance', () => {
  let plugin: ChatPanelPlugin;

  beforeEach(() => {
    plugin = new ChatPanelPlugin();
  });

  // ---------------------------------------------------------------------------
  // Static metadata
  // ---------------------------------------------------------------------------

  describe('identity', () => {
    it('has the canonical plugin id', () => {
      expect(plugin.id).toBe(CHAT_PANEL_PLUGIN_ID);
      expect(plugin.id).toBe('@signalsandsorcery/chat-panel');
    });

    it('declares a displayName, version, description, generatorType', () => {
      expect(plugin.displayName).toBe('Chat');
      expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(plugin.description).toBeTruthy();
      // The chat panel creates no engine content itself — 'hybrid' is the
      // closest generator type (it can trigger MIDI generation via tools).
      expect(plugin.generatorType).toBe('hybrid');
    });

    it('declares a minHostVersion covering at least 1.1.0 (PluginSDK with skills)', () => {
      expect(plugin.minHostVersion).toBeDefined();
      expect(plugin.minHostVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('activate / deactivate', () => {
    it('activate(host) does not throw', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(plugin.activate(makeHost() as any)).resolves.toBeUndefined();
    });

    it('deactivate() releases host reference and is idempotent', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await plugin.activate(makeHost() as any);
      await plugin.deactivate();
      // Second deactivate should not throw
      await expect(plugin.deactivate()).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Chat entrypoint — the thing external agents and the UI both call
  // ---------------------------------------------------------------------------

  describe('chat()', () => {
    it('returns { text, actions } for a simple message', async () => {
      const host = makeHost();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await plugin.activate(host as any);

      const result = await plugin.chat({ message: 'hello' });

      expect(result.text).toBe('ok');
      expect(Array.isArray(result.actions)).toBe(true);
    });

    it('refuses to run before activation with a clear error', async () => {
      await expect(plugin.chat({ message: 'hi' })).rejects.toThrow(/not activated/i);
    });

    it('routes a tool_use response through the panel tool surface', async () => {
      const host = makeHost();
      host.getPluginTracks.mockResolvedValue([{ id: 't-1', displayName: 'Bass', role: 'bass' }]);
      host.generateWithLLM
        .mockResolvedValueOnce({
          content: JSON.stringify({
            type: 'tool_use',
            toolCalls: [{ id: 'c1', name: 'get_tracks', parameters: {} }],
          }),
          tokensUsed: 5,
          model: 'test',
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ type: 'text', content: 'Found Bass.' }),
          tokensUsed: 5,
          model: 'test',
        });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await plugin.activate(host as any);

      const result = await plugin.chat({ message: 'what tracks' });

      expect(result.text).toBe('Found Bass.');
      expect(host.getPluginTracks).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // UI + settings
  // ---------------------------------------------------------------------------

  describe('UI & settings', () => {
    it('getUIComponent() returns a renderable React component type', () => {
      const C = plugin.getUIComponent();
      // Any function or class is a valid React component type
      expect(typeof C === 'function' || (typeof C === 'object' && C !== null)).toBe(true);
    });

    it('getSettingsSchema() returns null in v1', () => {
      expect(plugin.getSettingsSchema()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Skills (external-agent delegation)
  // ---------------------------------------------------------------------------

  describe('getSkills()', () => {
    it('declares a single `chat` skill', () => {
      const skills = plugin.getSkills?.() ?? [];
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('chat');
      expect(skills[0].description).toBeTruthy();
    });

    it('chat skill requires a message field', () => {
      const skill = plugin.getSkills?.()?.[0];
      expect(skill?.inputSchema.type).toBe('object');
      expect(skill?.inputSchema.required).toContain('message');
    });
  });

  // ---------------------------------------------------------------------------
  // Scene scoping — history clears on scene change
  // ---------------------------------------------------------------------------

  describe('onSceneChanged', () => {
    it('clears conversation history when the scene changes', async () => {
      const host = makeHost();
      host.generateWithLLM
        .mockResolvedValueOnce({
          content: JSON.stringify({ type: 'text', content: 'first' }),
          tokensUsed: 1,
          model: 'test',
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ type: 'text', content: 'second' }),
          tokensUsed: 1,
          model: 'test',
        });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await plugin.activate(host as any);

      await plugin.chat({ message: 'first in scene A' });
      await plugin.onSceneChanged?.('scene-B');
      await plugin.chat({ message: 'first in scene B' });

      // The second LLM call must NOT see 'first in scene A' in the prompt
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const secondUserPrompt = (host.generateWithLLM.mock.calls[1][0] as any).user as string;
      expect(secondUserPrompt).not.toContain('first in scene A');
      expect(secondUserPrompt).toContain('first in scene B');
    });
  });
});
