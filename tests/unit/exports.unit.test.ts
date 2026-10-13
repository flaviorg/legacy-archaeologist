import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSource } from "../../src/static/parser.ts";
import { buildScope } from "../../src/static/scope.ts";
import { findExports, paramNames } from "../../src/static/exports.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

function exportsOf(path: string, text: string) {
  const parsed = parseSource(path, text);
  assert.equal(parsed.error, null);
  const found = findExports(parsed, buildScope(parsed.program!));
  return { ...found, fns: found.functions.map((f) => ({ id: f.functionId, name: f.name, exportName: f.exportName, params: paramNames(f.node, text) })) };
}
const target = (rel: string) => readFileSync(join(PROJECT_ROOT, "tests/fixtures/targets", rel), "utf8");

test("[MAP-02] the CommonJS shapes list each function with ID and params", () => {
  const r = exportsOf("styles.js", target("cjs-styles/styles.js"));
  assert.equal(r.kind, "cjs");
  assert.deepEqual(r.fns, [
    { id: "styles.js#a", name: "a", exportName: "a", params: [] },
    { id: "styles.js#b2", name: "b2", exportName: "b", params: ["x"] },
    { id: "styles.js#c", name: "c", exportName: "c", params: ["p", "q"] },
  ]);
  assert.deepEqual(r.exports, [
    { name: "a", kind: "function", functionId: "styles.js#a" },
    { name: "b", kind: "function", functionId: "styles.js#b2" },
    { name: "c", kind: "function", functionId: "styles.js#c" },
    { name: "limit", kind: "value" },
  ]);
});

test("[MAP-02] module.exports = function () {} is <file>#default with exportName default", () => {
  const r = exportsOf("index.js", target("cjs-default/index.js"));
  assert.deepEqual(r.fns, [
    { id: "index.js#default", name: "default", exportName: "default", params: ["x"] },
    { id: "index.js#helper", name: "helper", exportName: "helper", params: ["y"] },
  ]);
  assert.deepEqual(r.exports.map((e) => [e.name, e.functionId]), [["default", "index.js#default"], ["helper", "index.js#helper"]]);
});

test("[MAP-02] a named function in the default slot keeps its declared name in the ID", () => {
  const r = exportsOf("index.js", "function bytes(v){}; module.exports = bytes; module.exports.format = format; function format(){}");
  assert.deepEqual(r.fns.map((f) => [f.id, f.exportName]), [["index.js#bytes", "default"], ["index.js#format", "format"]]);
  const named = exportsOf("n.js", "module.exports = function parse(s) { return s }");
  assert.deepEqual(named.fns.map((f) => [f.id, f.exportName]), [["n.js#parse", "default"]]);
});

test("[MAP-02] the ESM shapes: export function, export const arrow, export default, export { h as hh }", () => {
  const r = exportsOf("index.mjs", target("esm-module/index.mjs"));
  assert.equal(r.kind, "esm");
  assert.deepEqual(r.fns, [
    { id: "index.mjs#f", name: "f", exportName: "f", params: ["a", "b"] },
    { id: "index.mjs#g", name: "g", exportName: "g", params: ["x"] },
    { id: "index.mjs#default", name: "default", exportName: "default", params: [] },
    { id: "index.mjs#h", name: "h", exportName: "hh", params: [] },
  ]);
  assert.deepEqual(r.exports.map((e) => e.name), ["f", "g", "default", "hh"]);
  const named = exportsOf("d.mjs", "export default function bytes(v) {}\nexport const LIMIT = 3;\nexport class K {}");
  assert.deepEqual(named.fns.map((f) => [f.id, f.exportName]), [["d.mjs#bytes", "default"]]);
  assert.deepEqual(named.exports, [{ name: "default", kind: "function", functionId: "d.mjs#bytes" }, { name: "LIMIT", kind: "value" }, { name: "K", kind: "value" }]);
});

test("[RF-3] two export names bound to one function yield one FunctionInfo and two export entries", () => {
  const r = exportsOf("x.js", "function calculate(){}; module.exports = { calc: calculate, calculate: calculate }");
  assert.equal(r.functions.length, 1);
  assert.equal(r.fns[0]!.exportName, "calc");
  assert.deepEqual(r.exports, [
    { name: "calc", kind: "function", functionId: "x.js#calculate" },
    { name: "calculate", kind: "function", functionId: "x.js#calculate" },
  ]);
});

test("[MAP-02] object literal exports: shorthand, inline functions and non-function values", () => {
  const r = exportsOf("o.js", "var VERSION = '1';\nfunction a(){}\nvar b = (x, y = 2, ...rest) => x;\nmodule.exports = { a, b, c: function (z) {}, VERSION: VERSION, n: 3 };");
  assert.deepEqual(r.fns, [
    { id: "o.js#a", name: "a", exportName: "a", params: [] },
    { id: "o.js#b", name: "b", exportName: "b", params: ["x", "y", "...rest"] },
    { id: "o.js#c", name: "c", exportName: "c", params: ["z"] },
  ]);
  assert.deepEqual(r.exports.filter((e) => e.kind === "value").map((e) => e.name), ["VERSION", "n"]);
});

test("[MAP-02] assignments inside functions are not exports, and a file with no export is unknown", () => {
  const r = exportsOf("u.js", "function init(){ module.exports.late = function () {} }\nvar x = 1;");
  assert.equal(r.kind, "unknown");
  assert.deepEqual(r.exports, []);
  assert.deepEqual(r.functions, []);
});

test("[MAP-02] two different functions with the same declared name get distinct IDs", () => {
  const r = exportsOf("d.js", "exports.a = function run() {};\nexports.b = function run() {};");
  assert.deepEqual(r.fns.map((f) => f.id), ["d.js#run", "d.js#b"]);
});
