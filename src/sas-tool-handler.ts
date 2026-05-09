/**
 * sas-tool-handler — spawns the `sas` CLI as a subprocess and returns its
 * stdout / stderr / exit-code. This is what makes the chat plugin "feel like
 * Claude Code at the terminal": every tool the agent calls goes through the
 * same CLI surface external agents use, with the same error legibility,
 * remediation hints, and prerequisite chains.
 *
 * The handler does NOT import `electron` directly — it accepts `appExe` and
 * `cliEntry` as inputs. The chat plugin wires those in main-side activation
 * via `app.getPath('exe')` and the same logic the CLI installer uses (see
 * `sas-assistant/src/main/ipc-cli-install.ts:resolveInstallParams`). This
 * keeps the plugin testable without spinning up Electron and makes a
 * potential renderer-side stub trivial.
 *
 * Runs in the Electron main process only — subprocess spawning from the
 * renderer is not allowed.
 */

import { spawn } from 'node:child_process';

export interface SasToolInvocation {
  /** sas CLI action name, e.g. 'scene_get_tracks'. */
  action: string;
  /** Parameters as a flat key/value map. Coerced to bare-KV CLI form. */
  params: Record<string, unknown>;
  /** Absolute path to the Electron binary (host supplies via `app.getPath('exe')`). */
  appExe: string;
  /** Absolute path to the CLI's compiled JS entry (`dist/cli/sas.js`). */
  cliEntry: string;
  /** Per-call timeout. Default 60s. */
  timeoutMs?: number;
}

export interface SasToolResult {
  /** True when the CLI exited with code 0. */
  success: boolean;
  /** Process exit code; -1 if spawn failed before a code was produced. */
  exitCode: number;
  /** Captured stdout (trimmed). */
  stdout: string;
  /** Captured stderr (trimmed). */
  stderr: string;
  /**
   * If stdout parsed as JSON, the parsed value. Useful for the agent loop
   * to feed structured data back into the next turn's `functionResponse`.
   */
  parsedStdout?: unknown;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Convert a parameters object to CLI args using the `--json '{...}'`
 * escape hatch.
 *
 * The active CLI (`sas-assistant/cli/sas.ts`) parses `--key value` and
 * `--json '{...}'`, but NOT bare `key=value` positionals — those land in
 * `positionals[]` and never reach `params`. Earlier versions of this
 * function emitted bare-KV form which silently dropped every argument
 * the model passed (e.g. compose_scene's `tracks=[...]` arrived as an
 * empty params object → "non-empty tracks array" error).
 *
 * Using `--json` is also the most robust path for nested objects and
 * arrays: the CLI does `JSON.parse(value)` and merges the result into
 * params verbatim, so types round-trip without any per-argv coercion.
 *
 * Exported for unit-test coverage.
 */
export function paramsToCliArgs(params: Record<string, unknown>): string[] {
  if (Object.keys(params).length === 0) return [];
  return ['--json', JSON.stringify(params)];
}

/**
 * Spawn `sas <action> <kvargs...>` and capture its result.
 *
 * Resolves with a `SasToolResult` even on non-zero exit — the agent loop
 * decides what to do with stderr (typically: feed it back as a tool response
 * and let the model recover). Rejects only on spawn failure (binary missing)
 * or timeout, which the loop translates into a synthetic failure response.
 */
export async function invokeSas(invocation: SasToolInvocation): Promise<SasToolResult> {
  const timeoutMs = invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = [invocation.cliEntry, invocation.action, ...paramsToCliArgs(invocation.params)];

  return new Promise<SasToolResult>((resolve, reject) => {
    const child = spawn(invocation.appExe, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to spawn sas CLI (${invocation.appExe} ${invocation.cliEntry}): ${err.message}`
        )
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new Error(
            `sas CLI '${invocation.action}' timed out after ${timeoutMs}ms`
          )
        );
        return;
      }

      const trimmedStdout = stdout.trim();
      let parsedStdout: unknown;
      if (trimmedStdout.length > 0) {
        try {
          parsedStdout = JSON.parse(trimmedStdout);
        } catch {
          // Non-JSON stdout — that's fine; the agent reads it as text.
        }
      }

      resolve({
        success: code === 0,
        exitCode: code ?? -1,
        stdout: trimmedStdout,
        stderr: stderr.trim(),
        parsedStdout,
      });
    });
  });
}
