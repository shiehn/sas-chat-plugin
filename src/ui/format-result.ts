/**
 * Compact result formatter for the terminal log.
 *
 * Rendered on the `↳` line after a tool call completes. Stays on one line —
 * tool details belong in the collapsed expansion, not the running log.
 */

const MAX_LEN = 80;

export function formatResult(value: unknown): string {
  if (value === undefined || value === null) return 'ok';

  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) return formatArray(value);

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Common "result wrapper" shapes — show the payload, not the wrapper.
    if ('tracks' in obj && Array.isArray(obj.tracks)) {
      return formatArray(obj.tracks, 'tracks');
    }
    if ('items' in obj && Array.isArray(obj.items)) {
      return formatArray(obj.items, 'items');
    }
    return truncate(safeStringify(obj));
  }

  return truncate(String(value));
}

export function formatParams(params: Record<string, unknown>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return '';
  return truncate(safeStringify(params));
}

function formatArray(arr: unknown[], label = 'items'): string {
  if (arr.length === 0) return `0 ${label}`;
  const names = arr
    .map((item) => itemLabel(item))
    .filter((s): s is string => s !== null);
  if (names.length === 0) {
    return `${arr.length} ${label}`;
  }
  const joined = names.join(', ');
  return truncate(`${arr.length} ${label}: ${joined}`);
}

function itemLabel(item: unknown): string | null {
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    const name = obj.name ?? obj.displayName ?? obj.id;
    if (typeof name === 'string') return name;
  }
  return null;
}

function truncate(s: string): string {
  if (s.length <= MAX_LEN) return s;
  return s.slice(0, MAX_LEN - 1) + '…';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
