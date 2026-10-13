import test from "node:test";
import assert from "node:assert/strict";
import * as walk from "acorn-walk";
import type { Node } from "acorn";
import { parseSource } from "../../src/static/parser.ts";
import { buildScope, classifyIdentifier, isFunctionNode } from "../../src/static/scope.ts";
import type { IdentifierClass } from "../../src/static/scope.ts";

// Classifies every identifier reference (reads) in the source, keyed by "name@innermost function name".
function classifyAll(src: string): Map<string, IdentifierClass> {
  const parsed = parseSource("x.js", src);
  assert.equal(parsed.error, null);
  const program = parsed.program!;
  const scope = buildScope(program);
  const out = new Map<string, IdentifierClass>();
  walk.ancestor(program, {
    Identifier(node, _state, ancestors) {
      const enclosing = (ancestors as Node[]).filter((a) => a !== node && isFunctionNode(a));
      const inner = enclosing.at(-1) as { id?: { name: string } | null } | undefined;
      const where = inner ? (inner.id?.name ?? "<anon>") : "<module>";
      out.set(`${node.name}@${where}`, classifyIdentifier(scope, node.name, { pos: node.start, enclosing }));
    },
  });
  return out;
}

test("[MAP-03] var hoisting, params, nested functions and shadowing", () => {
  const c = classifyAll("var total = 0; function f(a) { if (a) { var h = 1; } function g() { return total + h + a + zz; } total = h; }");
  assert.equal(c.get("total@g"), "module");
  assert.equal(c.get("h@g"), "local");
  assert.equal(c.get("a@g"), "local");
  assert.equal(c.get("zz@g"), "global");
  assert.equal(c.get("h@f"), "local");
});

test("[MAP-03] a let in an inner block counts as local to the function", () => {
  assert.equal(classifyAll("function f(){ { let x = 1 } return x }").get("x@f"), "local");
});

test("[MAP-03] a module-level binding shadowed by a param is local", () => {
  assert.equal(classifyAll("var n=1; function f(n){ return n }").get("n@f"), "local");
});

test("[MAP-03] destructured params, catch params, class and function declarations inside a body are local", () => {
  const c = classifyAll("function f({ a, b: [c] }, ...rest){ try { a() } catch (e) { e } class K {} function inner(){} return c + rest + K + inner + arguments }");
  for (const name of ["a", "c", "rest", "e", "K", "inner", "arguments"]) assert.equal(c.get(`${name}@f`), "local", name);
});

test("[MAP-03] a named function expression's own name is local to it", () => {
  const c = classifyAll("var f = function fact(n){ return n && fact(n - 1) }");
  assert.equal(c.get("fact@fact"), "local");
});

test("[MAP-03] identifiers in a with body and every identifier of a file with direct eval are unresolved", () => {
  const w = classifyAll("var k = 1; function f(o){ with (o) { y = k } return k }");
  assert.equal(w.get("k@f"), "module"); // the read after the with body
  const parsed = parseSource("w.js", "function f(o){ with (o) { y } }");
  const scope = buildScope(parsed.program!);
  const pos = parsed.text.indexOf("y }");
  assert.equal(classifyIdentifier(scope, "y", { pos, enclosing: [] }), "unresolved");
  assert.deepEqual(scope.withRanges.length, 1);
  const e = classifyAll("var a; function f(){ eval('1'); return a }");
  assert.equal(e.get("a@f"), "unresolved");
  assert.equal(buildScope(parseSource("e.js", "var a; function f(){ eval('1'); return a }").program!).hasDirectEval, true);
  assert.equal(buildScope(parseSource("i.js", "var a; function f(){ (0, eval)('1'); return a }").program!).hasDirectEval, false);
});

test("[MAP-03] ESM imports and class declarations are module bindings", () => {
  const src = "import x from './x.js'; import { y as z } from './y.js'; class K {} export function f(){ return x && K && z }";
  const c = classifyAll(src);
  assert.equal(c.get("x@f"), "module");
  assert.equal(c.get("K@f"), "module");
  assert.equal(c.get("z@f"), "module");
  const scope = buildScope(parseSource("m.mjs", src).program!);
  assert.equal(scope.moduleBindings.get("x")?.kind, "import");
  assert.equal(scope.moduleBindings.get("K")?.kind, "class");
  assert.equal(scope.moduleBindings.get("f")?.kind, "function");
});

test("[MAP-03] module bindings record kind, line and whether the value is a function", () => {
  const scope = buildScope(parseSource("b.js", "var a = 1;\nlet b;\nconst c = function () {};\nif (a) { var d = 2; }\nfunction e() { var notModule = 1; }").program!);
  assert.deepEqual([...scope.moduleBindings.entries()].map(([n, b]) => [n, b.kind, b.line, b.functionValued]), [
    ["a", "var", 1, false], ["b", "let", 2, false], ["c", "const", 3, true], ["d", "var", 4, false], ["e", "function", 5, true],
  ]);
});
