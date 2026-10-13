// Stable JSON for artifact envelopes (plan delta 3). Imports nothing.
// Keys are sorted recursively, except inside the values of OPAQUE_KEYS, which hold Tagged data whose key order
// is behavior (D-09) and is kept as recorded.

export const OPAQUE_KEYS: ReadonlySet<string> = new Set(["args", "value", "stateAfter"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v));
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const inner = value[key];
    Object.defineProperty(out, key, { value: OPAQUE_KEYS.has(key) ? inner : sortKeys(inner), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

export function stableStringify(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

export function writeJsonText(value: unknown): string {
  return stableStringify(value, 2) + "\n";
}
