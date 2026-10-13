import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TAGGED_LIMITS, LA_TAG, OUTPUT_ONLY_TAGS, revive, toTagged } from "../../src/contracts/tagged.ts";
import type { Tagged } from "../../src/contracts/tagged.ts";
import { OPAQUE_KEYS, stableStringify, writeJsonText } from "../../src/contracts/stable-json.ts";
import { VALUES, sameValueDeep } from "../helpers/values.ts";

test("[REC-05] revive(toTagged(v)) equals v for 25 representable values (Object.is leaves, key order kept)", () => {
  assert.equal(VALUES.length, 25);
  for (const v of VALUES) assert.ok(sameValueDeep(revive(toTagged(v)), v), String(v));
});

test("[REC-05] the tagged form is plain JSON that survives a JSON round trip", () => {
  for (const v of VALUES) {
    const tagged = toTagged(v);
    assert.ok(sameValueDeep(revive(JSON.parse(JSON.stringify(tagged)) as Tagged), v), String(v));
  }
});

test("[REC-05] -0 and NaN survive as tags", () => {
  assert.deepEqual(toTagged(-0), { $t: "-0" });
  assert.ok(Object.is(revive({ $t: "-0" }), -0));
  assert.ok(Number.isNaN(revive({ $t: "NaN" })));
  assert.deepEqual([toTagged(NaN), toTagged(Infinity), toTagged(-Infinity), toTagged(undefined), toTagged(12n)],
    [{ $t: "NaN" }, { $t: "Infinity" }, { $t: "-Infinity" }, { $t: "undefined" }, { $t: "bigint", v: "12" }]);
  assert.deepEqual([toTagged(new Date(0)), toTagged(new Date(NaN))], [{ $t: "Date", v: "1970-01-01T00:00:00.000Z" }, { $t: "Date", v: "Invalid Date" }]);
});

test("[REC-05] a real object with a $t key is escaped and unwrapped", () => {
  assert.deepEqual(toTagged({ $t: "NaN" }), { $t: "object", v: { $t: "NaN" } });
  assert.deepEqual(revive({ $t: "object", v: { $t: "NaN", k: { $t: "-0" } } }), { $t: "NaN", k: -0 });
});

test("[REC-05] errors keep name, message and a string or number code, never the stack", () => {
  assert.deepEqual(toTagged(Object.assign(new TypeError("t"), { code: "ERR_X", stack: "s" })), { $t: "Error", name: "TypeError", message: "t", code: "ERR_X" });
  assert.deepEqual(toTagged(Object.assign(new Error("e"), { code: { nested: 1 } })), { $t: "Error", name: "Error", message: "e" });
  const revived = revive({ $t: "Error", name: "RangeError", message: "r", code: "E1" });
  assert.ok(revived instanceof RangeError);
  const custom = revive({ $t: "Error", name: "ValidationError", message: "v" }) as Error;
  assert.ok(custom instanceof Error);
  assert.equal(custom.name, "ValidationError");
});

test("[REC-05] output-only tags: function, circular, caps, unserializable; revive returns frozen sentinels", () => {
  const o: any = { a: 1 };
  o.self = o;
  assert.deepEqual(toTagged(o), { a: 1, self: { $t: "circular" } });
  assert.deepEqual(toTagged(function named() {}), { $t: "function", name: "named" });
  assert.deepEqual(toTagged("y".repeat(10_241)), { $t: "truncated", reason: "string" });
  assert.equal(toTagged("y".repeat(10_240)), "y".repeat(10_240));
  assert.deepEqual(toTagged(new Map()), { $t: "unserializable", type: "Map" });
  assert.deepEqual([toTagged(new Set()), toTagged(new Uint8Array(2)), toTagged(Symbol("s")), toTagged(new WeakMap())],
    [{ $t: "unserializable", type: "Set" }, { $t: "unserializable", type: "Uint8Array" }, { $t: "unserializable", type: "Symbol" }, { $t: "unserializable", type: "WeakMap" }]);
  class Point { x = 1; }
  assert.deepEqual(toTagged(new Point()), { $t: "unserializable", type: "Point" });
  const deep = JSON.parse("[".repeat(9) + "]".repeat(9));
  assert.match(JSON.stringify(toTagged(deep)), /"reason":"depth"/);
  const s = revive({ $t: "circular" }) as Record<symbol, string>;
  assert.ok(Object.isFrozen(s));
  assert.equal(s[Symbol.for("la.tag")], "circular");
  for (const tag of OUTPUT_ONLY_TAGS) assert.equal((revive({ $t: tag } as Tagged) as Record<symbol, string>)[LA_TAG], tag);
});

test("[REC-05] depth: 8 nested containers are kept, the 9th becomes truncated:depth", () => {
  const eight = JSON.parse("[".repeat(8) + "1" + "]".repeat(8));
  assert.deepEqual(toTagged(eight), eight);
  const nine = JSON.parse("[".repeat(9) + "]".repeat(9));
  assert.deepEqual(toTagged(nine), JSON.parse("[".repeat(8) + '{"$t":"truncated","reason":"depth"}' + "]".repeat(8)));
});

test("[REC-05] a shared, non-circular reference is serialized twice, not as circular", () => {
  const shared = { k: 1 };
  assert.deepEqual(toTagged({ a: shared, b: shared }), { a: { k: 1 }, b: { k: 1 } });
});

test("[REC-05] the node budget stops the walk with truncated:nodes", () => {
  const big = Array.from({ length: 10_001 }, (_v, i) => i);
  const out = toTagged(big) as Tagged[];
  assert.ok(Array.isArray(out));
  assert.ok(out.length <= 10_001);
  assert.deepEqual(out[out.length - 1], { $t: "truncated", reason: "nodes" });
  assert.equal(out.filter((v) => typeof v === "object").length, 1);
  const small = toTagged([[1, 2], [3, 4]], { ...DEFAULT_TAGGED_LIMITS, maxNodes: 4 });
  assert.deepEqual(small, [[1, 2], { $t: "truncated", reason: "nodes" }]);
});

test("[REC-05] insertion order of keys is kept, and __proto__ stays an own key", () => {
  assert.deepEqual(Object.keys(toTagged({ b: 1, a: 2 }) as object), ["b", "a"]);
  const withProto = JSON.parse('{"__proto__":{"x":1},"y":2}') as object;
  const tagged = toTagged(withProto) as Record<string, Tagged>;
  assert.deepEqual(Object.keys(tagged), ["__proto__", "y"]);
  assert.equal(Object.getPrototypeOf(tagged), Object.prototype);
  const revived = revive(tagged) as Record<string, unknown>;
  assert.deepEqual(Object.keys(revived), ["__proto__", "y"]);
  assert.equal(Object.getPrototypeOf(revived), Object.prototype);
});

test("[REC-05] a throwing getter does not crash the serializer", () => {
  const o = { a: 1, get b(): number { throw new Error("no"); } };
  assert.deepEqual(toTagged(o), { a: 1, b: { $t: "unserializable", type: "getter" } });
});

test("stableStringify sorts envelope keys but keeps the order inside args, value and stateAfter", () => {
  assert.equal(stableStringify({ z: 1, args: [{ b: 1, a: 2 }], a: { value: { y: 1, x: 2 }, k: 0 } }), '{"a":{"k":0,"value":{"y":1,"x":2}},"args":[{"b":1,"a":2}],"z":1}');
  assert.equal(stableStringify({ stateAfter: { b: 1, a: 1 }, cases: [{ y: 1, x: 2 }] }), '{"cases":[{"x":2,"y":1}],"stateAfter":{"b":1,"a":1}}');
  assert.deepEqual([...OPAQUE_KEYS].sort(), ["args", "stateAfter", "value"]);
});

test("writeJsonText indents by two spaces and ends with one newline", () => {
  assert.equal(writeJsonText({ b: 1, a: [1] }), '{\n  "a": [\n    1\n  ],\n  "b": 1\n}\n');
  assert.ok(!stableStringify({ a: 1 }).endsWith("\n"));
});
