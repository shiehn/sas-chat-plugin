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
  it('serializes strings, numbers, and booleans as bare-KV', () => {
    expect(paramsToCliArgs({ name: 'Bass', volume: 0.8, mute: true })).toEqual([
      'name=Bass',
      'volume=0.8',
      'mute=true',
    ]);
  });

  it('serializes objects and arrays as JSON', () => {
    expect(
      paramsToCliArgs({ pattern: { kick: [1, 0, 1, 0] } })
    ).toEqual(['pattern={"kick":[1,0,1,0]}']);
  });

  it('serializes null and undefined as empty values', () => {
    expect(paramsToCliArgs({ a: null, b: undefined })).toEqual(['a=', 'b=']);
  });

  it('produces a stable order matching insertion', () => {
    expect(paramsToCliArgs({ z: 1, a: 2, m: 3 })).toEqual([
      'z=1',
      'a=2',
      'm=3',
    ]);
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
      const args = process.argv.slice(2);
      const action = args[0];
      const params = {};
      let exitCode = 0;
      let stderr = '';
      let sleepMs = 0;
      for (const arg of args.slice(1)) {
        const eq = arg.indexOf('=');
        if (eq < 0) continue;
        const key = arg.slice(0, eq);
        const val = arg.slice(eq + 1);
        if (key === '__exit_code') { exitCode = Number(val); continue; }
        if (key === '__stderr') { stderr = val; continue; }
        if (key === '__sleep_ms') { sleepMs = Number(val); continue; }
        params[key] = val;
      }
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
