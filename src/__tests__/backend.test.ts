/**
 * AgentBackend seam — GeminiBackend classification + delegation.
 *
 * The loop keys its recovery policy on `BackendError.kind`; this suite pins
 * the Gemini error-text → kind mapping (the ONE place provider string
 * matching is allowed) and the pass-through behavior.
 */

import { BackendError } from '../backend';
import {
  GeminiBackend,
  GEMINI_DEFAULT_MODEL,
  GEMINI_COMPACTION_MODEL,
  classifyGeminiError,
} from '../gemini-backend';
import type { PluginHost, LLMToolUseResponse } from '@signalsandsorcery/plugin-sdk';

describe('classifyGeminiError', () => {
  it.each([
    [
      'history_shape',
      'Request failed with status 400: function response turn comes immediately after a function call turn',
    ],
    ['history_shape', 'Invalid thought_signature provided for function call'],
    ['rate_limit', 'HTTP 429: rate limit exceeded'],
    ['rate_limit', 'RESOURCE_EXHAUSTED: quota exceeded for model'],
    ['auth', '401 Unauthorized'],
    ['auth', 'User not authenticated — sign in required'],
    ['transient', 'fetch failed'],
    ['transient', 'HTTP 503 Service Unavailable'],
    ['transient', 'Request timed out after 60000ms'],
    ['transient', 'read ECONNRESET'],
    ['other', 'Something completely unexpected happened'],
  ])('classifies %s: %s', (kind, message) => {
    const err = classifyGeminiError(new Error(message));
    expect(err).toBeInstanceOf(BackendError);
    expect(err.kind).toBe(kind);
    expect(err.message).toBe(message);
  });

  it('preserves the original error as cause', () => {
    const original = new Error('HTTP 429: rate limit');
    expect(classifyGeminiError(original).cause).toBe(original);
  });

  it('handles non-Error throwables', () => {
    expect(classifyGeminiError('plain string failure').kind).toBe('other');
  });
});

describe('GeminiBackend', () => {
  const response: LLMToolUseResponse = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
  };

  function makeHost(impl: jest.Mock): PluginHost {
    return { generateWithLLMTools: impl } as unknown as PluginHost;
  }

  it('delegates to host.generateWithLLMTools and returns the response', async () => {
    const gen = jest.fn().mockResolvedValue(response);
    const backend = new GeminiBackend(makeHost(gen));
    const req = { model: backend.defaultModel, contents: [] };
    await expect(backend.complete(req)).resolves.toBe(response);
    expect(gen).toHaveBeenCalledWith(req);
  });

  it('wraps host errors in BackendError with a classified kind', async () => {
    const gen = jest
      .fn()
      .mockRejectedValue(
        new Error('400: function response turn comes immediately after a function call turn'),
      );
    const backend = new GeminiBackend(makeHost(gen));
    await expect(
      backend.complete({ model: backend.defaultModel, contents: [] }),
    ).rejects.toMatchObject({ name: 'BackendError', kind: 'history_shape' });
  });

  it('exposes Gemini defaults and capabilities', () => {
    const backend = new GeminiBackend(makeHost(jest.fn()));
    expect(backend.name).toBe('gemini');
    expect(backend.defaultModel).toBe(GEMINI_DEFAULT_MODEL);
    expect(backend.compactionModel).toBe(GEMINI_COMPACTION_MODEL);
    expect(backend.capabilities.preservesThoughtSignatures).toBe(true);
    expect(backend.capabilities.requiresStringEnums).toBe(true);
  });

  it('honors a model override (plugin settings)', () => {
    const backend = new GeminiBackend(makeHost(jest.fn()), { model: 'gemini-2.5-flash' });
    expect(backend.defaultModel).toBe('gemini-2.5-flash');
  });
});
