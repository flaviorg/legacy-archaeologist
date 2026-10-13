import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { buildMap, restrictMap } from "../../src/static/map.ts";
import type { BuildMapMeta } from "../../src/static/map.ts";
import { stableStringify } from "../../src/contracts/stable-json.ts";
import { SIDE_EFFECT_KINDS } from "../../src/contracts/map.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

const read = (rel: string) => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const meta: BuildMapMeta = {
  targetDir: "tests/fixtures/targets/x",
  targetSha: "sha256:" + "0".repeat(64),
  builtinModules,
  fileSha256: { "billing.js": "a".repeat(64), "uses-dep.js": "b".repeat(64), "ok.js": "c".repeat(64) },
  tool: { name: "legacy-archaeologist", version: "0.1.0" },
};
const billing = [{ path: "billing.js", text: read("fixtures/legacy-billing/billing.js") }];
const requiresDep = [
  { path: "uses-dep.js", text: read("tests/fixtures/targets/requires-dep/uses-dep.js") },
  { path: "ok.js", text: read("tests/fixtures/targets/requires-dep/ok.js") },
];
const fnOf = (map: ReturnType<typeof buildMap>, id: string) => map.modules.flatMap((m) => m.functions).find((f) => f.id === id)!;

test("[MAP-07] buildMap is byte-identical across two calls and across file order", () => {
  const files = [...billing, ...requiresDep];
  const a = stableStringify(buildMap(files, "commonjs", meta));
  const b = stableStringify(buildMap([...files].reverse(), "commonjs", meta));
  assert.equal(a, b);
  assert.equal(a, stableStringify(buildMap(files, "commonjs", meta)));
  assert.deepEqual(buildMap(files, "commonjs", meta).files.map((f) => f.path), ["billing.js", "ok.js", "uses-dep.js"]);
});

test("[MAP-07] targetDir is carried relative as given", () => {
  assert.equal(buildMap(billing, "commonjs", { ...meta, targetDir: "fixtures/legacy-billing" }).targetDir, "fixtures/legacy-billing");
});

test("[MAP-08] the last param invoked inside the body marks style callback", () => {
  const map = buildMap(billing, "commonjs", meta);
  const calc = fnOf(map, "billing.js#calculateInvoice");
  assert.equal(calc.callbackParam, "cb");
  assert.equal(calc.style, "callback");
  const disc = fnOf(map, "billing.js#applyDiscount");
  assert.equal(disc.callbackParam, null);
  assert.equal(disc.style, "sync");
  const nested = buildMap([{ path: "n.js", text: "function later(x, done) { setTimeout(function () { done(null, x) }, 1) }\nfunction notLast(cb, x) { cb() }\nmodule.exports = { later: later, notLast: notLast };" }], "commonjs", meta);
  assert.equal(fnOf(nested, "n.js#later").callbackParam, "done");
  assert.equal(fnOf(nested, "n.js#notLast").style, "sync");
});

test("[MAP-01] externalSpecifiers lists leftpad and ../shared.js but not fs, node:path or ./local.js", () => {
  const map = buildMap(requiresDep, "commonjs", meta);
  const byFile = Object.fromEntries(map.modules.map((m) => [m.file, m.externalSpecifiers]));
  assert.deepEqual(byFile, { "ok.js": [], "uses-dep.js": ["../shared.js", "leftpad"] });
  const esm = buildMap([{ path: "lib/m.mjs", text: "import a from 'node:fs';\nimport b from '../c.js';\nimport d from '../../up.js';\nexport { e } from 'pkg/sub';\nexport function f() { return import('./dyn.js') }" }], "module", meta);
  assert.deepEqual(esm.modules[0]!.externalSpecifiers, ["../../up.js", "pkg/sub"]);
});

test("[MAP-01] a file that fails to parse is listed with its error and an unknown module; module kind follows the extension", () => {
  const map = buildMap([{ path: "bad.js", text: "function (" }, { path: "a.cjs", text: "module.exports = function () {}" }, { path: "b.js", text: "export const f = () => 1;" }], "module", meta);
  assert.deepEqual(map.files.map((f) => [f.path, f.parse, f.sourceType ?? null]), [["a.cjs", "ok", "script"], ["b.js", "ok", "module"], ["bad.js", "error", null]]);
  assert.match(map.files[2]!.error!, /Unexpected token/);
  assert.deepEqual(map.modules.map((m) => [m.file, m.kind]), [["a.cjs", "cjs"], ["b.js", "esm"], ["bad.js", "unknown"]]);
  assert.deepEqual([map.stats.files, map.stats.parsedFiles], [3, 2]);
});

test("[MAP-02] the billing map has seven exported functions, tooLargeForLlm false, _seq as module state", () => {
  const map = buildMap(billing, "commonjs", { ...meta, targetDir: "fixtures/legacy-billing" });
  const mod = map.modules[0]!;
  assert.equal(mod.kind, "cjs");
  assert.deepEqual(mod.functions.map((f) => f.name), ["roundMoney", "applyDiscount", "prorate", "lateFee", "nextInvoiceNumber", "calculateInvoice", "formatMoney"]);
  assert.ok(mod.functions.every((f) => f.exported && !f.tooLargeForLlm && f.exportName === f.name));
  assert.deepEqual(mod.moduleState, [{ name: "_seq", line: 9, declaration: "var" }]);
  assert.deepEqual(mod.externalSpecifiers, []);
  assert.equal(map.stats.exportedFunctions, 7);
  assert.equal(map.stats.unresolvedCalls, 0);
  assert.deepEqual(Object.keys(map.stats.sideEffects), [...SIDE_EFFECT_KINDS]);
  assert.deepEqual(map.hotspots.map((h) => h.functionId), ["billing.js#calculateInvoice", "billing.js#prorate", "billing.js#applyDiscount", "billing.js#lateFee", "billing.js#nextInvoiceNumber"]);
  const calc = fnOf(map, "billing.js#calculateInvoice");
  assert.deepEqual([...new Set(calc.sideEffects.map((e) => e.kind))], ["Math.random", "global-write"]);
  assert.deepEqual(calc.writesGlobals, ["LAST_INVOICE"]);
  assert.deepEqual(calc.readsModuleState, ["TAX_RATE"]);
  assert.deepEqual(calc.calls.filter((c) => c.resolved).map((c) => c.resolved), ["billing.js#applyDiscount", "billing.js#roundMoney", "billing.js#nextInvoiceNumber", "billing.js#roundMoney", "billing.js#roundMoney", "billing.js#roundMoney"]);
  const next = fnOf(map, "billing.js#nextInvoiceNumber");
  assert.deepEqual(next.sideEffects.map((e) => e.kind), ["module-state-write", "Date"]);
  assert.deepEqual([next.readsModuleState, next.writesModuleState], [["_seq"], ["_seq"]]);
  assert.deepEqual(fnOf(map, "billing.js#applyDiscount").magicNumbers.map((m) => m.value), [100]);
  assert.deepEqual(fnOf(map, "billing.js#applyDiscount").readsModuleState, ["DISCOUNTS"]);
  assert.equal(map.files[0]!.bytes, Buffer.byteLength(billing[0]!.text, "utf8"));
  assert.equal(map.files[0]!.sha256, "a".repeat(64));
  assert.equal(map.schemaVersion, 1);
  assert.deepEqual(map.tool, { name: "legacy-archaeologist", version: "0.1.0" });
});

test("[RF-4] map line and column are right after a line with non-ASCII text", () => {
  const text = "// crème brûlée — naïve café\nfunction f(x){ return x * 37 }\nmodule.exports = { f: f }";
  const f = fnOf(buildMap([{ path: "a.js", text }], "commonjs", meta), "a.js#f");
  assert.deepEqual(f.magicNumbers, [{ value: 37, line: 2, column: 27 }]);
  assert.deepEqual(f.loc, { startLine: 2, endLine: 2 });
  assert.equal(text.slice(f.range[0], f.range[1]), "function f(x){ return x * 37 }");
  const same = fnOf(buildMap([{ path: "b.js", text: "function g(){ var s = 'déjà'; return 42 }\nmodule.exports = { g: g }" }], "commonjs", meta), "b.js#g");
  assert.deepEqual(same.magicNumbers, [{ value: 42, line: 1, column: 38 }]);
  assert.equal(same.sourceBytes, Buffer.byteLength("function g(){ var s = 'déjà'; return 42 }", "utf8"));
});

test("[MAP-03] identifiers of a file with direct eval are counted as unresolved and never guessed", () => {
  const map = buildMap([{ path: "e.js", text: "var n = 0;\nfunction f(){ eval('1'); n = 1; return n }\nmodule.exports = { f: f };" }], "commonjs", meta);
  const f = fnOf(map, "e.js#f");
  assert.deepEqual([f.writesModuleState, f.sideEffects], [[], []]);
  assert.ok(map.stats.unresolvedIdentifiers > 0);
  assert.equal(buildMap(billing, "commonjs", meta).stats.unresolvedIdentifiers, 0);
});

test("restrictMap keeps only the selected functions, every export entry, and recomputes hotspots and function stats", () => {
  const map = buildMap(billing, "commonjs", meta);
  const only = restrictMap(map, new Set(["billing.js#applyDiscount"]));
  assert.deepEqual(only.modules[0]!.functions.map((f) => f.id), ["billing.js#applyDiscount"]);
  assert.equal(only.modules[0]!.exports.length, 7);
  assert.deepEqual(only.hotspots, [{ functionId: "billing.js#applyDiscount", complexity: 4 }]);
  assert.equal(only.stats.exportedFunctions, 1);
  assert.equal(only.stats.sideEffects["Math.random"], 0);
  assert.equal(map.modules[0]!.functions.length, 7, "the input map is not mutated");
});
