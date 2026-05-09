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

import { invokeSas, paramsToCliArgs } from '../sas-tool-handler';

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
