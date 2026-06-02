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
 * `sas-app/src/main/ipc-cli-install.ts:resolveInstallParams`). This
 * keeps the plugin testable without spinning up Electron and makes a
 * potential renderer-side stub trivial.
 *
 * Runs in the Electron main process only — subprocess spawning from the
 * renderer is not allowed.
 */

import { spawn } from 'node:child_process';

/** One newline-delimited line from the spawned CLI's stdout/stderr. */
export interface SasProgressChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

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
  /**
   * Fires once per newline-delimited line from stdout/stderr as it arrives.
   * Additive — the final result.stdout/stderr accumulators are unchanged.
   * Optional: long-running tools call frequently; short tools may never call.
   */
  onProgress?: (chunk: SasProgressChunk) => void;
}

/**
 * Verbatim-args spawn invocation. Use this when the caller (e.g. an LLM
 * agent driving the CLI like a shell) supplies a full argv array rather
 * than an action+params split.
 *
 * The PI-Agent migration uses this surface so the model decides argument
 * formatting itself: `["help"]`, `["help", "scene_create"]`,
 * `["compose_scene", "--json", "{...}"]`. No per-arg coercion happens
 * here — that's the caller's responsibility.
 */
export interface SasArgsInvocation {
  /** CLI argv to pass verbatim, e.g. ['list-actions'] or ['help', 'scene_create']. */
  args: string[];
  /** Absolute path to the Electron binary (host supplies via `app.getPath('exe')`). */
  appExe: string;
  /** Absolute path to the CLI's compiled JS entry (`dist/cli/sas.js`). */
  cliEntry: string;
  /** Per-call timeout. Default matches `invokeSas`. */
  timeoutMs?: number;
  /** Optional abort signal — kills the child with SIGTERM when triggered. */
  signal?: AbortSignal;
  /**
   * Fires once per newline-delimited line from stdout/stderr as it arrives.
   * Additive — the final result.stdout/stderr accumulators are unchanged.
   * Optional: long-running tools call frequently; short tools may never call.
   */
  onProgress?: (chunk: SasProgressChunk) => void;
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

/**
 * Default per-call timeout. Composite workflows (`compose_scene`,
 * `make_beat`, `revise_track`) load synth plugins and run per-track LLM
 * MIDI generation in series — three-track scenes routinely take 90 s+.
 * 60 s was killing them mid-stride; 300 s aligns with the upstream LLM
 * call's own timeout and keeps interactive failures fast for shorter
 * tools (a stuck 30-second tool still surfaces in well under the cap).
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Convert a parameters object to CLI args using the `--json '{...}'`
 * escape hatch.
 *
 * The active CLI (`sas-app/cli/sas.ts`) parses `--key value` and
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
 * Spawn `<appExe> <cliEntry> <args...>` (with `ELECTRON_RUN_AS_NODE=1`) and
 * capture its result.
 *
 * This is the lowest-level primitive — `args` is passed verbatim to the
 * child process. Use this when the caller drives the CLI like an external
 * shell agent (PI-Agent migration target). Use `invokeSas` for the legacy
 * action+params shape.
 *
 * Resolves with a `SasToolResult` even on non-zero exit — the agent loop
 * decides what to do with stderr (typically: feed it back as a tool response
 * and let the model recover). Rejects only on spawn failure (binary missing)
 * or timeout, which the caller translates into a synthetic failure response.
 */
export async function spawnSasArgs(invocation: SasArgsInvocation): Promise<SasToolResult> {
  const timeoutMs = invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The CLI entry is always argv[0]; the rest is what the caller supplied.
  const childArgs = [invocation.cliEntry, ...invocation.args];

  return new Promise<SasToolResult>((resolve, reject) => {
    const child = spawn(invocation.appExe, childArgs, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    // Line-split buffer per stream so `onProgress` fires once per logical
    // line. Tools that want progress visible to the user MUST terminate
    // each message with `\n` — anything left un-terminated at close is by
    // definition the tool's final result blob, which the caller already
    // gets via the resolved promise. Re-surfacing it as a progress line
    // would just duplicate the `↳ result` row in the UI.
    const lineBuffers: Record<'stdout' | 'stderr', string> = {
      stdout: '',
      stderr: '',
    };
    const flushLines = (stream: 'stdout' | 'stderr', chunkText: string): void => {
      if (!invocation.onProgress) return;
      const combined = lineBuffers[stream] + chunkText;
      const parts = combined.split('\n');
      // Last element is whatever followed the final \n — held as a partial
      // until the next chunk completes the line. If close arrives first,
      // it's discarded (see comment above).
      const partial = parts.pop() ?? '';
      for (const line of parts) {
        invocation.onProgress({ stream, line });
      }
      lineBuffers[stream] = partial;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
    };
    if (invocation.signal) {
      if (invocation.signal.aborted) {
        onAbort();
      } else {
        invocation.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      flushLines('stdout', text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      flushLines('stderr', text);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      invocation.signal?.removeEventListener('abort', onAbort);
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
      invocation.signal?.removeEventListener('abort', onAbort);

      if (timedOut) {
        const cmd = invocation.args[0] ?? '<no-args>';
        reject(new Error(`sas CLI '${cmd}' timed out after ${timeoutMs}ms`));
        return;
      }

      if (aborted) {
        const cmd = invocation.args[0] ?? '<no-args>';
        reject(new Error(`sas CLI '${cmd}' aborted`));
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

/**
 * Spawn `sas <action> --json '<params>'` and capture its result.
 *
 * Legacy wrapper around `spawnSasArgs` for the action+params shape used by
 * the current Gemini-function-calling loop (`panel-tools.ts`). New callers
 * should prefer `spawnSasArgs` directly.
 */
export async function invokeSas(invocation: SasToolInvocation): Promise<SasToolResult> {
  return spawnSasArgs({
    args: [invocation.action, ...paramsToCliArgs(invocation.params)],
    appExe: invocation.appExe,
    cliEntry: invocation.cliEntry,
    timeoutMs: invocation.timeoutMs,
    onProgress: invocation.onProgress,
  });
}
