/**
 * format-result spec — compact one-line rendering for the ↳ line.
 */

import { describe, it, expect } from '@jest/globals';
import { formatResult, formatParams } from '../format-result';

describe('formatResult', () => {
  it('renders null/undefined as "ok"', () => {
    expect(formatResult(undefined)).toBe('ok');
    expect(formatResult(null)).toBe('ok');
  });

  it('renders primitives inline', () => {
    expect(formatResult('hello')).toBe('hello');
    expect(formatResult(42)).toBe('42');
    expect(formatResult(true)).toBe('true');
  });

  it('renders arrays with count and joined names', () => {
    expect(formatResult(['Bass', 'Drums'])).toBe('2 items: Bass, Drums');
    expect(formatResult([])).toBe('0 items');
  });

  it('extracts names from object arrays', () => {
    const arr = [
      { id: 't1', name: 'Bass' },
      { id: 't2', name: 'Drums' },
    ];
    expect(formatResult(arr)).toBe('2 items: Bass, Drums');
  });

  it('unwraps common { tracks: [...] } wrappers', () => {
    expect(formatResult({ tracks: ['Bass', 'Drums'] })).toBe('2 tracks: Bass, Drums');
  });

  it('unwraps { items: [...] } wrappers', () => {
    expect(formatResult({ items: ['a', 'b'] })).toBe('2 items: a, b');
  });

  it('stringifies plain objects', () => {
    expect(formatResult({ ok: true })).toBe('{"ok":true}');
  });

  it('truncates long results with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const out = formatResult(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('formatParams', () => {
  it('returns an empty string for no params', () => {
    expect(formatParams({})).toBe('');
  });

  it('stringifies params as JSON', () => {
    expect(formatParams({ trackId: 't1', enabled: true })).toBe(
      '{"trackId":"t1","enabled":true}'
    );
  });

  it('truncates long param blobs', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 50; i++) big[`key${i}`] = `value${i}`;
    const out = formatParams(big);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });
});
