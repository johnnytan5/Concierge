import type { CSSProperties } from 'react';

/**
 * Converts a CSS declaration string into a React style object.
 *
 * The mockup was authored with inline CSS strings; this keeps the ported
 * markup byte-for-byte faithful to the design. When these screens are wired
 * to real data, migrate the hot paths to CSS modules or styled objects.
 */
export function s(css?: string): CSSProperties {
  if (!css) return {};
  const out: Record<string, string> = {};
  for (const part of css.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || !v) continue;
    const key = k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    out[key] = v;
  }
  return out as CSSProperties;
}
