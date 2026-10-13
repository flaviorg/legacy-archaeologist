import test from "node:test";
import assert from "node:assert/strict";
import { parseChildLine } from "../../src/harness/protocol.ts";

const n = "a".repeat(32);

test("[SAFE-08] parseChildLine rejects another nonce, unparseable text and a schema violation", () => {
  assert.deepEqual(parseChildLine(JSON.stringify({ nonce: "b".repeat(32), done: true, cases: 1 }), n), { ok: false, reason: "nonce" });
  assert.deepEqual(parseChildLine("not json", n), { ok: false, reason: "unparseable" });
  assert.deepEqual(parseChildLine(JSON.stringify({ nonce: n, caseId: 3 }), n), { ok: false, reason: "schema" });
  assert.equal(parseChildLine(JSON.stringify({ nonce: n, done: true, cases: 1 }), n).ok, true);
});

test("[SAFE-08] a line with no nonce at all, or a JSON value that is not an object, counts as a nonce failure", () => {
  assert.deepEqual(parseChildLine(JSON.stringify({ done: true, cases: 1 }), n), { ok: false, reason: "nonce" });
  assert.deepEqual(parseChildLine("[1,2]", n), { ok: false, reason: "nonce" });
  assert.deepEqual(parseChildLine("null", n), { ok: false, reason: "nonce" });
});

test("parseChildLine accepts the four line kinds of spec 5.4", () => {
  const hello = parseChildLine(JSON.stringify({ nonce: n, hello: "legacy-archaeologist-child", version: "0.1.0" }), n);
  assert.ok(hello.ok && "hello" in hello.line);
  const kase = parseChildLine(JSON.stringify({
    nonce: n, caseId: "index.js#f#c01",
    steps: [{ args: [1, { $t: "NaN" }], outcome: { kind: "returned", value: { a: 1 } } }, { args: [], outcome: { kind: "timeout", reason: "case-timeout" } }],
    stateAfter: null, consoleLines: 2, durationsMs: [0.5, 1],
  }), n);
  assert.ok(kase.ok && "caseId" in kase.line && "steps" in kase.line);
  const load = parseChildLine(JSON.stringify({ nonce: n, caseId: "index.js#f#c01", loadError: "boom" }), n);
  assert.ok(load.ok && "loadError" in load.line);
});

test("parseChildLine rejects unknown outcome kinds and extra keys", () => {
  const bad = (o: unknown) => JSON.stringify({ nonce: n, caseId: "x", steps: [{ args: [], outcome: o }], stateAfter: null, consoleLines: 0, durationsMs: [0] });
  assert.deepEqual(parseChildLine(bad({ kind: "exploded" }), n), { ok: false, reason: "schema" });
  assert.deepEqual(parseChildLine(bad({ kind: "timeout", reason: "nap" }), n), { ok: false, reason: "schema" });
  assert.deepEqual(parseChildLine(JSON.stringify({ nonce: n, done: true, cases: 1, extra: 1 }), n), { ok: false, reason: "schema" });
});
