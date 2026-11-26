/**
 * Flexible timestamp parser & Chinese date-time formatter.
 *
 * Go CodeArts2API returns timestamps as Unix seconds (int64, e.g. 1795689595),
 * whereas Node preview or browser APIs may return ISO 8601 strings or Unix milliseconds.
 * Passing Unix seconds directly to `new Date(sec)` in JS renders 1970-01-21.
 * This helper normalizes all formats safely and returns null for 0 / empty / invalid values.
 */
export function parseFlexibleTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Values below 1e12 (~year 33658 in seconds, or 2001-09-09 in ms) are Unix seconds
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return parseFlexibleTimestamp(Number(trimmed));
    }
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  return null;
}

export function formatDateTimeCN(value: unknown, fallback = '—'): string {
  const d = parseFlexibleTimestamp(value);
  if (!d) return fallback;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatTimeCN(value: unknown, fallback = '—'): string {
  const d = parseFlexibleTimestamp(value);
  if (!d) return fallback;
  return d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Compares two semver strings (with optional leading "v", e.g. "v1.0.1" vs "1.0.0").
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (raw: string): [number, number, number] => {
    const cleaned = raw.trim().replace(/^v/i, '').split('-')[0] || '0.0.0';
    const parts = cleaned.split('.').map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}
