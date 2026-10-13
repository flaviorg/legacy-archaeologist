import test from "node:test";
import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import type { FunctionInfo } from "../../src/contracts/map.ts";
import type { OperatorId } from "../../src/contracts/mutation.ts";
import { applyMutant, listMutants } from "../../src/mutation/mutator.ts";
import { AOR_SWAPS, LOR_SWAPS, OPERATORS, ROR_SWAPS, numReplacements } from "../../src/mutation/operators.ts";
import { buildMap } from "../../src/static/map.ts";
import { parseSource, reparseOk } from "../../src/static/parser.ts";

const fnsOf = (text: string, path = "x.js"): FunctionInfo[] =>
  buildMap([{ path, text }], "commonjs", {
    targetDir: "t",
    targetSha: "sha256:" + "0".repeat(64),
    builtinModules,
    fileSha256: { [path]: "0".repeat(64) },
    tool: { name: "legacy-archaeologist", version: "0.0.0" },
  }).modules.flatMap((m) => m.functions);

const src = (body: string) => `function f(a, b, c, days, cents) { ${body} }\nmodule.exports = { f: f };\n`;
const muts = (body: string, ops: OperatorId[] = [...OPERATORS], max = 200) => listMutants([parseSource("x.js", src(body))], fnsOf(src(body)), ops, max);
const swaps = (body: string, ops: OperatorId[]) => muts(body, ops).mutants.map((m) => `${m.original}->${m.replacement}`);

test("the operator tables are the ones of spec 5.12", () => {
  assert.deepEqual([...OPERATORS], ["AOR", "ROR", "LOR", "NEG", "NUM", "BLOCK"]);
  assert.deepEqual(AOR_SWAPS, { "+": ["-"], "-": ["+"], "*": ["/"], "/": ["*"], "%": ["*"] });
  assert.deepEqual(ROR_SWAPS, { "<": ["<="], "<=": ["<"], ">": [">="], ">=": [">"], "==": ["!="], "!=": ["=="], "===": ["!=="], "!==": ["==="] });
  assert.deepEqual(LOR_SWAPS, { "&&": ["||"], "||": ["&&"] });
});

test("[MUT-01] AOR, ROR and LOR produce exactly the swaps of spec 5.12", () => {
  assert.deepEqual(swaps("return a + b * c % 2;", ["AOR"]), ["+->-", "*->/", "%->*"]);
  assert.deepEqual(swaps("return a - b / c;", ["AOR"]), ["-->+", "/->*"]);
  assert.deepEqual(swaps("return a < b || a >= c && a !== b;", ["ROR", "LOR"]), ["<-><=", "||->&&", ">=->>", "&&->||", "!==->==="]);
  assert.deepEqual(swaps("return a <= b || a > c || a == b || a != c || a === c;", ["ROR"]), ["<=-><", ">->>=", "==->!=", "!=->==", "===->!=="]);
  assert.equal(muts('return "x" + a;', ["AOR"]).mutants.length, 0);
  assert.equal(muts("return a + `t${b}`;", ["AOR"]).mutants.length, 0);
  assert.equal(muts("return a ?? b;", ["LOR"]).mutants.length, 0);
  assert.equal(muts("a += 1; return a ** 2;", ["AOR"]).mutants.length, 0);
});

test("[MUT-01] NEG wraps if and ternary tests; BLOCK empties an if consequent but not a single-statement exported body", () => {
  const neg = muts("if (a) { b = 1; } return a ? 1 : 2;", ["NEG"]).mutants;
  assert.deepEqual(neg.map((m) => [m.original, m.replacement]), [["a", "!(a)"], ["a", "!(a)"]]);
  assert.match(applyMutant(src("if (a) { b = 1; } return a ? 1 : 2;"), neg[0]!), /if \(!\(a\)\) \{ b = 1; \}/);
  assert.match(applyMutant(src("if (a) { b = 1; } return a ? 1 : 2;"), neg[1]!), /return !\(a\) \? 1 : 2;/);
  const single = muts("if (a) { b = 1; }", ["BLOCK"]).mutants;
  assert.deepEqual(single.map((m) => [m.original, m.replacement]), [["{ b = 1; }", "{}"]]);
  const two = muts("if (a) { b = 1; } return b;", ["BLOCK"]).mutants;
  assert.deepEqual(two.map((m) => [m.original, m.replacement]), [["{ if (a) { b = 1; } return b; }", "{}"], ["{ b = 1; }", "{}"]]);
  assert.equal(muts("if (a) {} return b;", ["BLOCK"]).mutants.length, 1, "an empty consequent is not a BLOCK mutant");
  const inner = muts("var g = function (x) { return x; }; return g(a);", ["BLOCK"]).mutants;
  assert.deepEqual(inner.map((m) => m.original), ["{ var g = function (x) { return x; }; return g(a); }", "{ return x; }"], "a nested function's single-statement body is mutated");
});

test("[MUT-01] NUM replacements after dedup for 0, 1 and 0.1, negatives parenthesized", () => {
  assert.deepEqual(numReplacements(0), ["1", "(-1)"]);
  assert.deepEqual(numReplacements(1), ["2", "0"]);
  assert.deepEqual(numReplacements(0.1), ["1.1", "(-0.9)", "0"]);
  assert.deepEqual(numReplacements(100), ["101", "99", "0"]);
  const m = muts("return a-0.1;", ["NUM"]).mutants;
  assert.deepEqual(m.map((x) => x.replacement), ["1.1", "(-0.9)", "0"]);
  assert.equal(applyMutant(src("return a-0.1;"), m[1]!).includes("a-(-0.9)"), true);
  assert.equal(muts("return a + 10n;", ["NUM"]).mutants.length, 0, "bigint literals are not NUM mutants");
});

test("[MUT-01] only nodes inside exported functions are mutated and IDs follow file, start, operator, replacement", () => {
  const text = "function g(x) { return x + 1; }\nfunction f(a) { if (a > 1) { return g(a); } return 0; }\nmodule.exports = { f: f };\n";
  const fns = fnsOf(text);
  const r = listMutants([parseSource("x.js", text)], fns, OPERATORS, 200);
  const gEnd = text.indexOf("}") + 1;
  assert.ok(r.mutants.every((m) => m.start >= gEnd), "nothing inside the non-exported helper g");
  assert.ok(r.mutants.every((m) => m.functionId === "x.js#f"));
  assert.deepEqual(r.mutants.map((m) => m.id), r.mutants.map((_, i) => `m-${String(i + 1).padStart(4, "0")}`));
  assert.deepEqual(r.mutants.map((m) => `${m.operator}:${m.original}->${m.replacement}`), [
    "BLOCK:{ if (a > 1) { return g(a); } return 0; }->{}",
    "NEG:a > 1->!(a > 1)",
    "ROR:>->>=",
    "NUM:1->2",
    "NUM:1->0",
    "BLOCK:{ return g(a); }->{}",
    "NUM:0->1",
    "NUM:0->(-1)",
  ]);
  const second = "function h(n) { return n * 2; }\nmodule.exports = { h: h };\n";
  const both = listMutants([parseSource("b.js", second), parseSource("a.js", text)], [...fnsOf(second, "b.js"), ...fnsOf(text, "a.js")], OPERATORS, 200);
  assert.equal(both.mutants[0]!.file, "a.js", "files are ordered by path");
  assert.equal(both.mutants.at(-1)!.file, "b.js");
});

test("[MUT-02] a mutant whose text does not parse is dropped and counted as invalid", () => {
  const r = muts('var o = { 0: "z" }; return o;', ["NUM"]);
  assert.equal(r.invalid, 1);
  assert.deepEqual(r.mutants.map((m) => m.replacement), ["1"]);
});

test("[MUT-03] the splice changes only the operator token: parentheses and comments survive, / included", () => {
  for (const body of ["return (cents / 100);", "return Math.ceil(days / 7);", "return (a /*c*/) / (b);", "if ((a + b) > c) { return 1; } return 0;", "return a /* + */ + b; // a - b\n"]) {
    const text = src(body);
    const list = muts(body, ["AOR", "ROR"]).mutants;
    assert.ok(list.length > 0, body);
    for (const m of list) {
      const out = applyMutant(text, m);
      assert.equal(out.slice(0, m.start), text.slice(0, m.start));
      assert.equal(out.slice(m.start + m.replacement.length), text.slice(m.end));
      assert.equal(m.end - m.start, m.original.length);
      assert.equal(text.slice(m.start, m.end), m.original);
      assert.equal(reparseOk(out, "script"), true, out);
    }
  }
  const commented = muts("return a /* + */ + b; // a - b\n", ["AOR"]).mutants;
  assert.equal(commented.length, 1);
  assert.equal(applyMutant(src("return a /* + */ + b; // a - b\n"), commented[0]!).includes("return a /* + */ - b; // a - b\n"), true);
});

test("--max-mutants truncates in the stable order and reports the rest", () => {
  const body = "if (a > 1) { return a + 2; } return a - 3;";
  const all = muts(body);
  const cut = muts(body, [...OPERATORS], 3);
  assert.ok(all.mutants.length > 3);
  assert.deepEqual(cut.mutants, all.mutants.slice(0, 3));
  assert.equal(cut.truncated, all.mutants.length - 3);
  assert.equal(all.truncated, 0);
});

test("[RF-4] a non-ASCII comment before an operator does not shift the splice", () => {
  const body = "// minimum fee — naïve €10\n  return a > 10;";
  const m = muts(body, ["ROR"]).mutants[0]!;
  assert.equal(src(body).slice(m.start, m.end), ">");
  assert.equal(m.line, 2);
  assert.equal(m.column, src(body).split("\n")[1]!.indexOf(">"));
});

test("an ES module file is tokenized and reparsed as a module", () => {
  const text = "export function f(a) { return a + 1; }\n";
  const r = listMutants([parseSource("m.mjs", text)], fnsOf(text, "m.mjs"), ["AOR"], 200);
  assert.deepEqual(r.mutants.map((m) => `${m.original}->${m.replacement}`), ["+->-"]);
});
