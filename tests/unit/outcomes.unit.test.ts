import test from "node:test";
import assert from "node:assert/strict";
import { isCharacterized, outcomesEqual, stateAfterOf, taggedEqual } from "../../src/contracts/outcomes.ts";
import type { Outcome } from "../../src/contracts/outcomes.ts";
import type { Tagged } from "../../src/contracts/tagged.ts";

const r = (value: Tagged): Outcome => ({ kind: "returned", value });

test("[REC-05] NaN equals NaN and -0 differs from 0", () => {
  assert.ok(outcomesEqual(r({ $t: "NaN" }), r({ $t: "NaN" })));
  assert.ok(!outcomesEqual(r(0), r({ $t: "-0" })));
  assert.ok(!outcomesEqual(r(-0 as number), r(0)));
});

test("[MUT-04] the comparator works on tagged values without reviving: a Date tag differs from its ISO string", () => {
  assert.ok(!outcomesEqual(r({ $t: "Date", v: "2023-11-14T22:13:20.000Z" }), r("2023-11-14T22:13:20.000Z")));
  assert.ok(outcomesEqual(r({ $t: "Date", v: "2023-11-14T22:13:20.000Z" }), r({ $t: "Date", v: "2023-11-14T22:13:20.000Z" })));
  assert.ok(!outcomesEqual(r({ $t: "Date", v: "2023-11-14T22:13:20.000Z" }), r({ $t: "Date", v: "Invalid Date" })));
});

test("[MUT-04] Error tags compare name, message and code; timeout reasons are ignored", () => {
  const e = (code?: string): Outcome => ({ kind: "threw", value: { $t: "Error", name: "TypeError", message: "m", ...(code ? { code } : {}) } });
  assert.ok(outcomesEqual(e("X"), e("X")));
  assert.ok(!outcomesEqual(e("X"), e()));
  assert.ok(!outcomesEqual(e("X"), e("Y")));
  assert.ok(outcomesEqual({ kind: "timeout", reason: "watchdog" }, { kind: "timeout" }));
  assert.ok(!outcomesEqual({ kind: "callback", args: [null, 1] }, { kind: "callback", args: [null] }));
  assert.ok(!outcomesEqual({ kind: "promise", status: "fulfilled", value: 1 }, { kind: "promise", status: "rejected", value: 1 }));
});

test("[MUT-04] different kinds never compare equal; a thrown string differs from a returned one", () => {
  assert.ok(!outcomesEqual({ kind: "threw", value: "boom" }, r("boom")));
  assert.ok(!outcomesEqual({ kind: "no-callback" }, { kind: "timeout" }));
  assert.ok(outcomesEqual({ kind: "no-callback" }, { kind: "no-callback" }));
  assert.ok(outcomesEqual({ kind: "callback", args: [null, { total: 1 }] }, { kind: "callback", args: [null, { total: 1 }] }));
});

test("[GEN-09] taggedEqual is key-order sensitive", () => assert.ok(!taggedEqual({ a: 1, b: 2 }, { b: 2, a: 1 })));

test("[GEN-09] taggedEqual compares nested arrays, escapes and output-only tags structurally", () => {
  assert.ok(taggedEqual([1, [2, { a: { $t: "-0" } }]], [1, [2, { a: { $t: "-0" } }]]));
  assert.ok(!taggedEqual([1, 2], [1, 2, 3]));
  assert.ok(!taggedEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(taggedEqual({ $t: "object", v: { $t: "NaN" } }, { $t: "object", v: { $t: "NaN" } }));
  assert.ok(!taggedEqual({ $t: "object", v: { $t: "NaN" } }, { $t: "NaN" }));
  assert.ok(!taggedEqual({ $t: "bigint", v: "1" }, { $t: "bigint", v: "2" }));
  assert.ok(!taggedEqual({ $t: "function", name: "a" }, { $t: "function", name: "b" }));
  assert.ok(!taggedEqual({ $t: "truncated", reason: "depth" }, { $t: "truncated", reason: "nodes" }));
  assert.ok(!taggedEqual({ $t: "unserializable", type: "Map" }, { $t: "unserializable", type: "Set" }));
  assert.ok(!taggedEqual(null, { $t: "undefined" }));
  assert.ok(!taggedEqual([], {}));
  assert.ok(!taggedEqual("1", 1));
});

test("[GEN-09] stateAfterOf drops the synthetic default and functions, identically for CJS and ESM", () => {
  const cjs = { count: 1, inc() {}, nested: { f() {}, k: [() => 1, 2] } };
  const normalized = { ...cjs, default: cjs };
  const esm = Object.freeze(Object.assign(Object.create(null), { count: 1, inc() {}, nested: cjs.nested, default: cjs, [Symbol.toStringTag]: "Module" }));
  const expected = { count: 1, nested: { k: [{ $t: "function", name: "" }, 2] } };
  assert.deepEqual(stateAfterOf(normalized, "commonjs"), expected);
  assert.deepEqual(stateAfterOf(esm, "module"), expected);
  assert.equal(stateAfterOf({ a() {}, default: {} }, "commonjs"), null);
});

test("[GEN-09] stateAfterOf reads a function-valued module.exports and keeps key order", () => {
  const fn = Object.assign(function bytes() {}, { zeta: 2, alpha: [named], format() {} });
  function named(): void {}
  assert.deepEqual(stateAfterOf(fn, "commonjs"), { zeta: 2, alpha: [{ $t: "function", name: "" }] });
  assert.equal(stateAfterOf(function only() {}, "commonjs"), null);
});

test("[GEN-09] stateAfterOf applies the tagged limits", () => {
  assert.deepEqual(stateAfterOf({ s: "x".repeat(20) }, "commonjs", { maxDepth: 8, maxNodes: 10_000, maxString: 10 }), { s: { $t: "truncated", reason: "string" } });
});

test("[GEN-04] isCharacterized excludes unstable, timeout, no-callback and sandbox-only cases", () => {
  const c = (outcome: Outcome, determinism: "stable" | "unstable" = "stable") => ({ determinism, steps: [{ outcome }] });
  assert.ok(isCharacterized(c(r(1))));
  assert.ok(!isCharacterized(c(r(1), "unstable")));
  assert.ok(!isCharacterized(c({ kind: "timeout", reason: "watchdog" })));
  assert.ok(!isCharacterized(c({ kind: "no-callback" })));
  assert.ok(!isCharacterized(c({ kind: "callback", args: [{ $t: "Error", name: "Error", message: "x", code: "NO_NETWORK" }] })));
  assert.ok(!isCharacterized(c({ kind: "promise", status: "rejected", value: { $t: "Error", name: "Error", message: "x", code: "ERR_ACCESS_DENIED" } })));
});

test("[GEN-04] a sandbox-only Error tag nested anywhere, in any step, excludes the case", () => {
  const nested: Outcome = r({ list: [{ inner: { $t: "Error", name: "Error", message: "x", code: "NO_NETWORK" } }] });
  assert.ok(!isCharacterized({ determinism: "stable", steps: [{ outcome: r(1) }, { outcome: nested }] }));
  const escaped: Outcome = r({ $t: "object", v: { $t: "x", e: { $t: "Error", name: "Error", message: "x", code: "ERR_ACCESS_DENIED" } } });
  assert.ok(!isCharacterized({ determinism: "stable", steps: [{ outcome: escaped }] }));
  assert.ok(isCharacterized({ determinism: "stable", steps: [{ outcome: { kind: "threw", value: { $t: "Error", name: "Error", message: "x", code: "ENOENT" } } }] }));
  assert.ok(isCharacterized({ determinism: "stable", steps: [{ outcome: r({ code: "NO_NETWORK" }) }] }));
});
