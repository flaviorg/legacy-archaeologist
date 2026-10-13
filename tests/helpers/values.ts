import type { Outcome } from "../../src/contracts/outcomes.ts";
import type { Tagged } from "../../src/contracts/tagged.ts";

// The 25-value table shared by tagged.unit and (from Task 24) emit-tests.unit.
export const VALUES: unknown[] = [0, -0, 1.5, NaN, Infinity, -Infinity, "", "x", true, false, null, undefined, 12n, -12n,
  new Date(0), new Date(NaN), [1, [2, [3]]], { a: 1, b: { c: [] } }, { b: 1, a: 2 }, [undefined, -0],
  { $t: "NaN" }, { $t: "object", v: 1 }, Object.assign(new RangeError("r"), { code: "E1" }), Object.assign(new Error("n"), { code: 42 }), { nested: { d: new Date(1700000000000) } }];

// Object.is for primitives, getTime for dates (NaN equals NaN), name/message/code for errors,
// own keys compared in order, arrays by index.
export function sameValueDeep(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return Object.is(a, b);
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  }
  if (a instanceof Error || b instanceof Error) {
    return a instanceof Error && b instanceof Error && a.name === b.name && a.message === b.message
      && Object.is((a as { code?: unknown }).code, (b as { code?: unknown }).code);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValueDeep(v, b[i]));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => sameValueDeep((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// Pairs of tagged outcomes covering every outcome kind, equal and unequal (emit-tests.unit, write-spec.unit).
const err = (name: string, message: string, code?: string | number): Tagged =>
  (code === undefined ? { $t: "Error", name, message } : { $t: "Error", name, message, code });
export const OUTCOME_PAIRS: [Outcome, Outcome][] = [
  [{ kind: "returned", value: 100 }, { kind: "returned", value: 100 }],
  [{ kind: "returned", value: 100 }, { kind: "returned", value: 90 }],
  [{ kind: "returned", value: { $t: "-0" } }, { kind: "returned", value: 0 }],
  [{ kind: "returned", value: { a: 1, b: [2, { $t: "NaN" }] } }, { kind: "returned", value: { b: [2, { $t: "NaN" }], a: 1 } }],
  [{ kind: "returned", value: "x" }, { kind: "threw", value: "x" }],
  [{ kind: "threw", value: err("TypeError", "bad") }, { kind: "threw", value: err("TypeError", "bad") }],
  [{ kind: "threw", value: err("Error", "net", "NO_NETWORK") }, { kind: "threw", value: err("Error", "net") }],
  [{ kind: "callback", args: [null, { total: 107.25 }] }, { kind: "callback", args: [null, { total: 96.53 }] }],
  [{ kind: "callback", args: [err("Error", "no lines")] }, { kind: "callback", args: [err("Error", "no lines")] }],
  [{ kind: "promise", status: "fulfilled", value: 1 }, { kind: "promise", status: "rejected", value: 1 }],
  [{ kind: "promise", status: "rejected", value: err("RangeError", "r", 42) }, { kind: "promise", status: "rejected", value: err("RangeError", "r", 42) }],
  [{ kind: "timeout", reason: "watchdog" }, { kind: "timeout" }],
  [{ kind: "no-callback" }, { kind: "no-callback" }],
  [{ kind: "no-callback" }, { kind: "returned", value: { $t: "undefined" } }],
  [{ kind: "returned", value: [{ $t: "Date", v: "2023-11-14T22:13:20.000Z" }, { $t: "bigint", v: "12" }, { $t: "function", name: "f" }] }, { kind: "returned", value: [{ $t: "circular" }, { $t: "truncated", reason: "depth" }, { $t: "unserializable", type: "Map" }] }],
  [{ kind: "returned", value: { $t: "object", v: { $t: "NaN" } } }, { kind: "returned", value: { $t: "Infinity" } }],
];
