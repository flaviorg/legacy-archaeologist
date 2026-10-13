import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSource, reparseOk, tokenize } from "../../src/static/parser.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

const BILLING = readFileSync(join(PROJECT_ROOT, "fixtures/legacy-billing/billing.js"), "utf8");

test("[MAP-01] a CommonJS script falls back from module to script and keeps ranges, loc and comments", () => {
  const p = parseSource("a.js", "// lead\nwith (o) { x }\nmodule.exports = function () {}");
  assert.equal(p.sourceType, "script");
  assert.equal(p.error, null);
  assert.equal(p.comments.length, 1);
  assert.deepEqual(p.program!.range, [0, p.text.length]);
  assert.equal(p.program!.loc!.start.line, 1);
});

test("[MAP-01] an ES module parses as module", () => {
  assert.equal(parseSource("m.mjs", "export function f(a) { return a }").sourceType, "module");
  assert.equal(parseSource("i.mjs", "import x from './x.js';\nx();").sourceType, "module");
});

test("[MAP-01] a file with neither import nor export is reported as a script", () => {
  const p = parseSource("plain.js", "var a = 1;\nmodule.exports = { a: a };");
  assert.equal(p.sourceType, "script");
  assert.equal(p.error, null);
});

test("[MAP-01] a file that fails both modes reports the error and no program", () => {
  const p = parseSource("bad.js", "function (");
  assert.equal(p.program, null);
  assert.equal(p.sourceType, null);
  assert.deepEqual(p.comments, []);
  assert.match(p.error!, /Unexpected token/);
});

test("[MAP-01] a shebang line parses", () => {
  assert.equal(parseSource("cli.js", "#!/usr/bin/env node\nvar a = 1;").error, null);
});

test("tokenize returns operator tokens at exact offsets on the whole source", () => {
  const src = "return (cents / 100) + Math.ceil(days / 7) + (a /*c*/ / b) + a % 3;";
  const full = "function f(){" + src + "}";
  const tokens = tokenize(full, "script");
  assert.deepEqual(tokens.filter((t) => ["/", "+", "%"].includes(t.text)).map((t) => t.text), ["/", "+", "/", "+", "/", "+", "%"]);
  for (const t of tokens) assert.equal(full.slice(t.start, t.end), t.text);
  const firstSlash = tokens.find((t) => t.text === "/")!;
  assert.equal(firstSlash.start, full.indexOf("/ 100"));
});

test("reparseOk accepts valid text and rejects a broken splice", () => {
  assert.equal(reparseOk("var a = 1 + 2;", "script"), true);
  assert.equal(reparseOk("var a = 1 + ;", "script"), false);
  assert.equal(reparseOk("with (o) { x }", "module"), false);
});

test("the billing fixture parses as a script with seven exported functions in module.exports", () => {
  const p = parseSource("billing.js", BILLING);
  assert.equal(p.error, null);
  assert.equal(p.sourceType, "script");
  const last = p.program!.body.at(-1)!;
  assert.equal(last.type, "ExpressionStatement");
  const expr = last.type === "ExpressionStatement" ? last.expression : null;
  assert.ok(expr && expr.type === "AssignmentExpression" && expr.right.type === "ObjectExpression");
  const keys = expr.right.properties.map((prop) => (prop.type === "Property" && prop.key.type === "Identifier" ? prop.key.name : "?"));
  assert.deepEqual(keys, ["roundMoney", "applyDiscount", "prorate", "lateFee", "nextInvoiceNumber", "calculateInvoice", "formatMoney"]);
  assert.ok(!/["']use strict["']/.test(BILLING));
});
