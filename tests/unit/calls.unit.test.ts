import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSource } from "../../src/static/parser.ts";
import { buildScope } from "../../src/static/scope.ts";
import { findExports } from "../../src/static/exports.ts";
import { listCalls, moduleFunctionIds } from "../../src/static/calls.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

function callsOf(path: string, text: string, name: string) {
  const parsed = parseSource(path, text);
  assert.equal(parsed.error, null);
  const fns = findExports(parsed, buildScope(parsed.program!)).functions;
  return listCalls(fns.find((f) => f.name === name)!.node, moduleFunctionIds(parsed.program!, path));
}
const CALLS = readFileSync(join(PROJECT_ROOT, "tests/fixtures/targets/dynamic-calls/calls.js"), "utf8");

test("[MAP-06] computed members and non-identifier callees are dynamic with resolved null", () => {
  const calls = callsOf("calls.js", CALLS, "main");
  assert.deepEqual(calls.filter((c) => c.dynamic), [
    { callee: "<computed>", resolved: null, line: 8, dynamic: true },
    { callee: "<expression>", resolved: null, line: 9, dynamic: true },
    { callee: "<expression>", resolved: null, line: 10, dynamic: true },
  ]);
  assert.deepEqual(calls.find((c) => c.callee === "Math.ceil"), { callee: "Math.ceil", resolved: null, line: 11, dynamic: false });
  assert.ok(calls.some((c) => c.callee === "getFn" && !c.dynamic && c.resolved === null));
});

test("[MAP-06] a call to a module-level function of the same file resolves by name only", () => {
  const main = callsOf("calls.js", CALLS, "main");
  assert.deepEqual(main.find((c) => c.callee === "helper"), { callee: "helper", resolved: "calls.js#helper", line: 7, dynamic: false });
  assert.ok(!main.some((c) => c.callee === "other"), "the callee's body is not followed");
  assert.deepEqual(callsOf("calls.js", CALLS, "helper"), [{ callee: "other", resolved: "calls.js#other", line: 4, dynamic: false }]);
});

test("[MAP-06] calls are listed in source order, with member chains and method calls on expressions", () => {
  const calls = callsOf("o.js", "function f(t){ return (t / 100).toFixed(2).replace(/x/g, ',') + this.g() + a.b.c() }\nmodule.exports = { f: f };", "f");
  assert.deepEqual(calls.map((c) => [c.callee, c.dynamic]), [["<expression>.toFixed", false], ["<expression>.replace", false], ["this.g", false], ["a.b.c", false]]);
});
