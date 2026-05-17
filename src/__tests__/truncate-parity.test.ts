/**
 * Cross-repo parity tests for `truncateForLLM`.
 *
 * Mirror of `sas-assistant/src/shared/utils/__tests__/truncate-parity.test.ts`.
 * Loads the same shared fixture file via monorepo-relative path and
 * exercises the chat-plugin's inline copy of `truncateForLLM`. If the
 * two implementations of the truncator ever diverge (one updated, the
 * other forgotten), one of these suites surfaces it.
 *
 * Fixture path is monorepo-layout-dependent. If the chat-plugin is
 * checked out standalone (no sibling sas-assistant), this test skips
 * cleanly rather than failing.
 *
 * Resolves the cross-repo parity follow-up in
 * `sas-assistant/docs/chat-cli-architecture.md` § 2.6.
 */

import * as fs from 'fs';
import * as path from 'path';
import { truncateForLLM } from '../agent-loop';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'sas-assistant',
  'src',
  'shared',
  'utils',
  '__fixtures__',
  'truncate-parity-cases.json',
);

interface PreservedPath {
  path: string;
  equals: unknown;
}

interface Invariants {
  unchanged?: boolean;
  shorterThanInput?: boolean;
  containsMarker?: string;
  startsWithFirstChar?: boolean;
  endsWithLastChar?: boolean;
  validJson?: boolean;
  preservesPath?: PreservedPath[];
}

interface ParityCase {
  name: string;
  input: string;
  padField?: string;
  padFront?: number;
  padBack?: number;
  padFiller?: string;
  invariants: Invariants;
}

interface ParityFixture {
  cap: number;
  maxCandidateItems: number;
  maxDbRows: number;
  cases: ParityCase[];
}

function buildInput(c: ParityCase): string {
  const filler = c.padFiller ?? 'x';
  const front = c.padFront ? filler.repeat(c.padFront) : '';
  const back = c.padBack ? filler.repeat(c.padBack) : '';
  if (c.padField) {
    return c.input.replace('@@PAD@@', filler.repeat(c.padFront ?? 0));
  }
  let s = c.input;
  if (s.includes('@@PAD@@')) {
    s = s.replace('@@PAD@@', filler.repeat(c.padFront ?? 0));
    return s;
  }
  return front + s + back;
}

function readPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      cur = cur[Number(part)];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

const hasFixture = fs.existsSync(FIXTURE_PATH);
const fixture: ParityFixture | null = hasFixture
  ? (JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as ParityFixture)
  : null;

// describe.skip if the sibling repo isn't present — keeps the chat-plugin
// portable for someone who checks it out standalone.
const d = hasFixture ? describe : describe.skip;

d('truncateForLLM parity (shared fixture from sas-assistant)', () => {
  it('fixture file resolves and parses', () => {
    expect(fixture).not.toBeNull();
    expect(Array.isArray(fixture!.cases)).toBe(true);
    expect(fixture!.cases.length).toBeGreaterThan(0);
  });

  for (const c of fixture?.cases ?? []) {
    it(`case: ${c.name}`, () => {
      const input = buildInput(c);
      const out = truncateForLLM(input);

      if (c.invariants.unchanged) {
        expect(out).toBe(input);
      }
      if (c.invariants.shorterThanInput) {
        expect(out.length).toBeLessThan(input.length);
      }
      if (c.invariants.containsMarker) {
        expect(out).toMatch(c.invariants.containsMarker);
      }
      if (c.invariants.startsWithFirstChar) {
        expect(out.startsWith(input[0])).toBe(true);
      }
      if (c.invariants.endsWithLastChar) {
        expect(out.endsWith(input[input.length - 1])).toBe(true);
      }
      if (c.invariants.validJson) {
        expect(() => JSON.parse(out)).not.toThrow();
      }
      if (c.invariants.preservesPath) {
        const parsed = JSON.parse(out);
        for (const p of c.invariants.preservesPath) {
          expect(readPath(parsed, p.path)).toEqual(p.equals);
        }
      }
    });
  }
});
