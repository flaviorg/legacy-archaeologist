import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSource } from "../../src/static/parser.ts";
import { buildScope, enclosingFunctionsOf } from "../../src/static/scope.ts";
import { findExports } from "../../src/static/exports.ts";
import { detectSideEffects, magicNumbers, moduleConstantRanges, moduleNumericConstants, moduleStateUse, requireAliases } from "../../src/static/side-effects.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

function analyze(path: string, text: string) {
  const parsed = parseSource(path, text);
  assert.equal(parsed.error, null);
  const program = parsed.program!;
  const scope = buildScope(program);
  const aliases = requireAliases(program);
  const enclosingOf = enclosingFunctionsOf(program);
  const fns = findExports(parsed, scope).functions;
  const byName = (name: string) => fns.find((f) => f.name === name)!.node;
  return {
    program, scope, aliases, fns,
    effects: (name: string) => detectSideEffects(byName(name), scope, aliases, enclosingOf),
    state: (name: string) => moduleStateUse(byName(name), scope, enclosingOf),
    magic: (name: string) => magicNumbers(byName(name), moduleConstantRanges(program)),
  };
}

test("[MAP-04] each SideEffectKind is detected once with the right line", () => {
  const a = analyze("effects.js", readFileSync(join(PROJECT_ROOT, "tests/fixtures/targets/side-effects/effects.js"), "utf8"));
  const expected: [string, string, number][] = [
    ["useDate", "Date", 10], ["useRandom", "Math.random", 11], ["usePerformance", "performance.now", 12], ["useHrtime", "process.hrtime", 13],
    ["useCrypto", "crypto", 14], ["useFs", "fs", 15], ["useChildProcess", "child_process", 16], ["useNet", "net", 17],
    ["useHttp", "http", 18], ["useDns", "dns", 19], ["useConsole", "console", 20], ["useEnv", "process.env", 21],
    ["useTimers", "timers", 22], ["useIntl", "Intl", 23], ["writeGlobal", "global-write", 24], ["writeModule", "module-state-write", 25],
  ];
  assert.equal(a.fns.length, expected.length);
  for (const [name, kind, line] of expected) {
    assert.deepEqual(a.effects(name).map((e) => [e.kind, e.line]), [[kind, line]], name);
  }
  assert.equal(a.effects("useFs")[0]!.detail, "fs.writeFileSync");
  assert.equal(a.effects("writeGlobal")[0]!.detail, "LAST");
  assert.equal(a.effects("writeModule")[0]!.detail, "counter");
});

test("[MAP-04] require aliases are followed: var f = require('fs'); f.writeFileSync → fs", () => {
  const a = analyze("a.js", "var f = require('fs');\nfunction w(){ f.writeFileSync('x', 'y'); return require('node:fs').readFileSync('x') }\nmodule.exports = { w: w };");
  assert.equal(a.aliases.get("f"), "fs");
  assert.deepEqual(a.effects("w").map((e) => [e.kind, e.line, e.detail]), [["fs", 2, "fs.writeFileSync"], ["fs", 2, "fs.readFileSync"]]);
});

test("[MAP-04] destructured node: imports are followed", () => {
  const a = analyze("b.js", 'const { exec } = require("node:child_process");\nconst { readFileSync: r } = require("node:fs");\nfunction run(){ exec("x"); return r("y") }\nmodule.exports = { run };');
  assert.equal(a.aliases.get("exec"), "child_process.exec");
  assert.equal(a.aliases.get("r"), "fs.readFileSync");
  assert.deepEqual(a.effects("run").map((e) => [e.kind, e.detail]), [["child_process", "child_process.exec"], ["fs", "fs.readFileSync"]]);
});

test("[MAP-04] ESM namespace and named imports are aliases too", () => {
  const a = analyze("m.mjs", 'import * as fs from "node:fs";\nimport { request } from "node:http";\nimport { randomUUID } from "node:crypto";\nexport function f(){ fs.readFileSync("x"); request("y"); return randomUUID() }');
  assert.deepEqual(a.effects("f").map((e) => [e.kind, e.detail]), [["fs", "fs.readFileSync"], ["http", "http.request"], ["crypto", "crypto.randomUUID"]]);
});

test("[MAP-04] a write to a module-level var is module-state-write and a write to global.X is global-write", () => {
  const src = "var count = 0;\nvar cache = {};\nfunction f(k){ count++; cache[k] = 1; global.X = count; globalThis.Y = 2; undeclared = 3; var local = 1; local = 2; return cache }\nmodule.exports = { f: f };";
  const a = analyze("c.js", src);
  assert.deepEqual(a.effects("f").map((e) => [e.kind, e.detail]), [
    ["module-state-write", "count"], ["module-state-write", "cache"], ["global-write", "X"], ["global-write", "Y"], ["global-write", "undeclared"],
  ]);
  assert.deepEqual(a.state("f"), { reads: ["cache", "count"], writes: ["cache", "count"], globalsWritten: ["X", "Y", "undeclared"] });
});

test("[MAP-04] a shadowed Date or console is not a side effect", () => {
  const a = analyze("s.js", "function f(Date, console){ console.log(1); return Date.now() }\nmodule.exports = { f: f };");
  assert.deepEqual(a.effects("f"), []);
});

test("module state use ignores module-level functions and lists reads sorted and unique", () => {
  const a = analyze("r.js", "var RATE = 0.1;\nvar seq = 1;\nfunction helper(){ return 1 }\nfunction f(x){ return helper() + x * RATE + seq + RATE }\nmodule.exports = { f: f };");
  assert.deepEqual(a.state("f"), { reads: ["RATE", "seq"], writes: [], globalsWritten: [] });
});

test("magic numbers skip 0, 1 and module-level constant declarations", () => {
  const a = analyze("n.js", "var RATE = 0.0725; function f(x){ return x * RATE + 100 * 1 } module.exports = { f: f };");
  assert.deepEqual(a.magic("f"), [{ value: 100, line: 1, column: 53 }]);
  assert.deepEqual(moduleNumericConstants(a.program), [{ name: "RATE", value: 0.0725, line: 1 }]);
});

test("module numeric constants include object tables of numbers", () => {
  const program = parseSource("t.js", "var TABLE = { VIP: 0.1, STAFF: 0.25 };\nconst NEG = -3;\nvar s = 'x';\nvar mixed = { a: 1, b: function () {} };").program!;
  assert.deepEqual(moduleNumericConstants(program), [
    { name: "TABLE.VIP", value: 0.1, line: 1 }, { name: "TABLE.STAFF", value: 0.25, line: 1 }, { name: "NEG", value: -3, line: 2 },
  ]);
  assert.equal(moduleConstantRanges(program).length, 2);
});
