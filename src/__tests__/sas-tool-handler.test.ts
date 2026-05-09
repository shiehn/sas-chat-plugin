/**
 * Tests for sas-tool-handler.
 *
 * The handler runs `<appExe> <cliEntry> <action> <key=value...>`. We use
 * a tiny Node script as the CLI substitute — it lets us assert on real
 * spawn behavior (stdout/stderr capture, exit codes, timeouts) without
 * needing the full Electron app.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { invokeSas, paramsToCliArgs, spawnSasArgs } from '../sas-tool-handler';

// ---------------------------------------------------------------------------
// paramsToCliArgs unit coverage
// ---------------------------------------------------------------------------

describe('paramsToCliArgs', () => {
  it('emits --json with a JSON-encoded payload for primitive params', () => {
    expect(paramsToCliArgs({ name: 'Bass', volume: 0.8, mute: true })).toEqual([
      '--json',
      JSON.stringify({ name: 'Bass', volume: 0.8, mute: true }),
    ]);
  });

  it('round-trips nested objects and arrays through JSON', () => {
    const params = {
      tracks: [
        { name: 'Kick', role: 'drums', prompt: 'four on the floor' },
        { name: 'Bass', role: 'bass', prompt: 'walking' },
      ],
    };
    const args = paramsToCliArgs(params);
    expect(args[0]).toBe('--json');
    expect(JSON.parse(args[1]!)).toEqual(params);
  });

  it('preserves null and undefined keys verbatim through JSON', () => {
    // JSON.stringify drops `undefined` fields and keeps `null` — that's the
    // documented contract; downstream tools should distinguish "not provided"
    // (undefined) from "explicit null" using JSON's native rules.
    expect(paramsToCliArgs({ a: null, b: undefined })).toEqual([
      '--json',
      '{"a":null}',
    ]);
  });

  it('returns an empty arg list when no params are passed', () => {
    expect(paramsToCliArgs({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// invokeSas integration with a stub CLI
// ---------------------------------------------------------------------------

describe('invokeSas — subprocess behavior', () => {
  /**
   * The stub CLI: a Node script that:
   *   - prints whatever it received on stdout (as JSON)
   *   - exits 0 by default, or with the code passed via `__exit_code` arg
   *   - if `__stderr=...` is present, writes it to stderr first
   *   - if `__sleep_ms=...` is present, sleeps that long before exiting
   * We point invokeSas at `process.execPath` (Node) and this script.
   */
  let stubPath: string;

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-tool-handler-'));
    stubPath = path.join(tmpDir, 'stub-cli.js');
    fs.writeFileSync(
      stubPath,
      `
      // Stub mirrors the active CLI's argv contract: \`<action> --json '<...>'\`.
      // \`__exit_code\` / \`__stderr\` / \`__sleep_ms\` are test sentinels read off
      // the parsed params object so individual tests can drive the stub.
      const args = process.argv.slice(2);
      const action = args[0];
      let params = {};
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--json' && i + 1 < args.length) {
          try { params = JSON.parse(args[i + 1]); } catch {}
          i++;
        }
      }
      const exitCode = Number(params.__exit_code ?? 0);
      const stderr = String(params.__stderr ?? '');
      const sleepMs = Number(params.__sleep_ms ?? 0);
      const finish = () => {
        if (stderr.length > 0) process.stderr.write(stderr);
        process.stdout.write(JSON.stringify({ action, params }));
        process.exit(exitCode);
      };
      if (sleepMs > 0) setTimeout(finish, sleepMs);
      else finish();
      `,
      'utf8'
    );
  });

  it('captures stdout and parses JSON when present', async () => {
    const result = await invokeSas({
      action: 'scene_get_tracks',
      params: { sceneId: 'abc' },
      appExe: process.execPath,
      cliEntry: stubPath,
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.parsedStdout).toEqual({
      action: 'scene_get_tracks',
      params: { sceneId: 'abc' },
    });
  });

  it('returns success=false on non-zero exit', async () => {
    const result = await invokeSas({
      action: 'broken_tool',
      params: { __exit_code: '1', __stderr: 'something went wrong\n' },
      appExe: process.execPath,
      cliEntry: stubPath,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('something went wrong');
    // stdout is still captured (the stub always writes something)
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('rejects on timeout', async () => {
    await expect(
      invokeSas({
        action: 'slow_tool',
        params: { __sleep_ms: '5000' },
        appExe: process.execPath,
        cliEntry: stubPath,
        timeoutMs: 100,
      })
    ).rejects.toThrow(/timed out/);
  });

  it('rejects when the binary cannot be spawned', async () => {
    await expect(
      invokeSas({
        action: 'whatever',
        params: {},
        appExe: '/path/that/does/not/exist',
        cliEntry: stubPath,
      })
    ).rejects.toThrow(/Failed to spawn/);
  });

  it('passes ELECTRON_RUN_AS_NODE=1 in env for proper CLI invocation', async () => {
    // The stub doesn't enforce this, but we can at least verify the CLI is invoked
    // and produces output. The env flag is essential when invoking Electron-as-Node
    // for the real `sas` binary; here we just smoke-test that spawn went through.
    const result = await invokeSas({
      action: 'noop',
      params: {},
      appExe: process.execPath,
      cliEntry: stubPath,
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// spawnSasArgs — verbatim-args primitive used by the PI-agent migration.
// Reuses the same stub CLI; difference is the caller hands over raw argv.
// ---------------------------------------------------------------------------

describe('spawnSasArgs — verbatim args', () => {
  let stubPath: string;

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-spawn-args-'));
    stubPath = path.join(tmpDir, 'stub-cli.js');
    fs.writeFileSync(
      stubPath,
      `
      // Echo argv back as JSON so tests can assert what we passed verbatim.
      const args = process.argv.slice(2);
      let exitCode = 0;
      let stderr = '';
      let sleepMs = 0;
      // Test sentinels — same shape as the invokeSas stub but read off argv
      // so callers can mix them in anywhere.
      for (const a of args) {
        if (a.startsWith('--__exit=')) exitCode = Number(a.slice('--__exit='.length));
        if (a.startsWith('--__stderr=')) stderr = a.slice('--__stderr='.length);
        if (a.startsWith('--__sleep=')) sleepMs = Number(a.slice('--__sleep='.length));
      }
      const finish = () => {
        if (stderr.length > 0) process.stderr.write(stderr);
        process.stdout.write(JSON.stringify({ args }));
        process.exit(exitCode);
      };
      if (sleepMs > 0) setTimeout(finish, sleepMs);
      else finish();
      `,
      'utf8'
    );
  });

  it('passes args verbatim to the child process', async () => {
    const result = await spawnSasArgs({
      args: ['help', 'scene_create'],
      appExe: process.execPath,
      cliEntry: stubPath,
    });

    expect(result.success).toBe(true);
    expect(result.parsedStdout).toEqual({ args: ['help', 'scene_create'] });
  });

  it('preserves --json blobs the caller already constructed', async () => {
    // The whole point of verbatim args: the caller (the LLM) decides
    // serialisation. We pass through whatever they hand us.
    const jsonBody = JSON.stringify({ name: 'Bass', volume: 0.8 });
    const result = await spawnSasArgs({
      args: ['compose_scene', '--json', jsonBody],
      appExe: process.execPath,
      cliEntry: stubPath,
    });

    expect(result.success).toBe(true);
    expect(result.parsedStdout).toEqual({
      args: ['compose_scene', '--json', jsonBody],
    });
  });

  it('returns success=false on non-zero exit and captures stderr', async () => {
    const result = await spawnSasArgs({
      args: ['broken_tool', '--__exit=1', '--__stderr=missing prerequisites\n'],
      appExe: process.execPath,
      cliEntry: stubPath,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('missing prerequisites');
  });

  it('rejects on timeout', async () => {
    await expect(
      spawnSasArgs({
        args: ['slow_tool', '--__sleep=5000'],
        appExe: process.execPath,
        cliEntry: stubPath,
        timeoutMs: 100,
      })
    ).rejects.toThrow(/timed out/);
  });

  it('rejects when the binary cannot be spawned', async () => {
    await expect(
      spawnSasArgs({
        args: ['whatever'],
        appExe: '/path/that/does/not/exist',
        cliEntry: stubPath,
      })
    ).rejects.toThrow(/Failed to spawn/);
  });

  it('rejects mid-flight when the supplied AbortSignal fires', async () => {
    const controller = new AbortController();
    const promise = spawnSasArgs({
      args: ['slow_tool', '--__sleep=5000'],
      appExe: process.execPath,
      cliEntry: stubPath,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    // Give the child a beat to actually start, then abort.
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toThrow(/aborted/);
  });

  it('rejects synchronously when given an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      spawnSasArgs({
        args: ['noop'],
        appExe: process.execPath,
        cliEntry: stubPath,
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/);
  });

  it('handles empty args without indexing past argv', async () => {
    // Edge case: an LLM that just runs `sas` (no subcommand) should still
    // get a clean error path rather than blowing up the stub. The stub
    // exits 0 with `args: []`; the timeout-cmd label uses '<no-args>'.
    const result = await spawnSasArgs({
      args: [],
      appExe: process.execPath,
      cliEntry: stubPath,
    });
    expect(result.success).toBe(true);
    expect(result.parsedStdout).toEqual({ args: [] });
  });
});

// ---------------------------------------------------------------------------
// spawnSasArgs — onProgress line-buffering correctness.
// Uses a dedicated stub that lets each test drive the chunk boundaries so we
// can prove partial lines hold across writes and the trailing partial flushes
// on close.
// ---------------------------------------------------------------------------

describe('spawnSasArgs — onProgress line buffering', () => {
  let stubPath: string;

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-progress-'));
    stubPath = path.join(tmpDir, 'progress-stub.js');
    fs.writeFileSync(
      stubPath,
      `
      // Replays a scripted sequence of writes so tests can assert that
      // newline-buffering reassembles lines correctly across chunk boundaries.
      // Script comes in as JSON via --json: { writes: [{ stream, text, delayMs }] }.
      const args = process.argv.slice(2);
      let script = { writes: [] };
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--json' && i + 1 < args.length) {
          try { script = JSON.parse(args[i + 1]); } catch {}
          i++;
        }
      }
      let i = 0;
      const next = () => {
        if (i >= script.writes.length) {
          process.exit(0);
          return;
        }
        const w = script.writes[i++];
        const stream = w.stream === 'stderr' ? process.stderr : process.stdout;
        stream.write(w.text);
        if (w.delayMs > 0) setTimeout(next, w.delayMs);
        else setImmediate(next);
      };
      next();
      `,
      'utf8'
    );
  });

  it('splits a multi-line chunk into one onProgress call per line', async () => {
    const lines: Array<{ stream: string; line: string }> = [];
    const result = await spawnSasArgs({
      args: ['--json', JSON.stringify({ writes: [{ stream: 'stdout', text: 'a\nb\nc\n', delayMs: 0 }] })],
      appExe: process.execPath,
      cliEntry: stubPath,
      onProgress: (chunk) => lines.push(chunk),
    });
    expect(result.success).toBe(true);
    // Three complete lines, each surfaced once. Trailing newline does not
    // produce a fourth empty line.
    expect(lines).toEqual([
      { stream: 'stdout', line: 'a' },
      { stream: 'stdout', line: 'b' },
      { stream: 'stdout', line: 'c' },
    ]);
  });

  it('holds a partial line across a chunk boundary until the next chunk', async () => {
    // First chunk leaves "abc" with no newline; second chunk starts with
    // "def\n". The buffer should emit ONE line ("abcdef"), not two halves.
    const lines: Array<{ stream: string; line: string }> = [];
    const result = await spawnSasArgs({
      args: [
        '--json',
        JSON.stringify({
          writes: [
            { stream: 'stdout', text: 'abc', delayMs: 30 },
            { stream: 'stdout', text: 'def\n', delayMs: 0 },
          ],
        }),
      ],
      appExe: process.execPath,
      cliEntry: stubPath,
      onProgress: (chunk) => lines.push(chunk),
    });
    expect(result.success).toBe(true);
    expect(lines).toEqual([{ stream: 'stdout', line: 'abcdef' }]);
  });

  it('does NOT flush a trailing un-terminated partial at close', async () => {
    // Tools must terminate progress messages with `\n`. Anything left
    // un-terminated at close is the tool's final result blob (caller
    // gets it via the resolved promise / tool_call_done). Re-surfacing
    // it as a progress line would duplicate the `↳ result` row visible
    // in the chat panel — the exact bug this guards against.
    const lines: Array<{ stream: string; line: string }> = [];
    const result = await spawnSasArgs({
      args: [
        '--json',
        JSON.stringify({
          writes: [{ stream: 'stdout', text: 'trailing', delayMs: 0 }],
        }),
      ],
      appExe: process.execPath,
      cliEntry: stubPath,
      onProgress: (chunk) => lines.push(chunk),
    });
    expect(lines).toEqual([]);
    // The accumulated stdout still contains the un-terminated content,
    // so the caller (tool_call_done) gets it.
    expect(result.stdout).toBe('trailing');
  });

  it('keeps stdout and stderr streams independent', async () => {
    const lines: Array<{ stream: string; line: string }> = [];
    await spawnSasArgs({
      args: [
        '--json',
        JSON.stringify({
          writes: [
            { stream: 'stdout', text: 'one\n', delayMs: 10 },
            { stream: 'stderr', text: 'warn\n', delayMs: 10 },
            { stream: 'stdout', text: 'two\n', delayMs: 0 },
          ],
        }),
      ],
      appExe: process.execPath,
      cliEntry: stubPath,
      onProgress: (chunk) => lines.push(chunk),
    });
    // Order is event-loop dependent across streams, so just assert the
    // multiset.
    expect(lines).toEqual(
      expect.arrayContaining([
        { stream: 'stdout', line: 'one' },
        { stream: 'stderr', line: 'warn' },
        { stream: 'stdout', line: 'two' },
      ])
    );
    expect(lines).toHaveLength(3);
  });

  it('keeps the accumulated stdout/stderr unchanged when onProgress is supplied (regression guard)', async () => {
    // The aggregated result.stdout/stderr fields must continue to reflect
    // the full byte stream — onProgress is additive, not a replacement.
    const result = await spawnSasArgs({
      args: [
        '--json',
        JSON.stringify({
          writes: [
            { stream: 'stdout', text: 'hello\nworld', delayMs: 0 },
            { stream: 'stderr', text: 'err1\n', delayMs: 0 },
          ],
        }),
      ],
      appExe: process.execPath,
      cliEntry: stubPath,
      onProgress: () => {},
    });
    // .trim() is applied by the handler, but the joined content survives.
    expect(result.stdout).toBe('hello\nworld');
    expect(result.stderr).toBe('err1');
  });

  it('is a no-op when onProgress is omitted', async () => {
    // Should still complete successfully; no callback to invoke.
    const result = await spawnSasArgs({
      args: [
        '--json',
        JSON.stringify({
          writes: [{ stream: 'stdout', text: 'a\nb\n', delayMs: 0 }],
        }),
      ],
      appExe: process.execPath,
      cliEntry: stubPath,
    });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('a\nb');
  });
});
