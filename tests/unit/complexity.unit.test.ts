import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSource } from "../../src/static/parser.ts";
import { buildScope } from "../../src/static/scope.ts";
import { findExports } from "../../src/static/exports.ts";
import { cyclomatic, topHotspots } from "../../src/static/complexity.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

test("[MAP-05] complexity of six snippets", () => {
  const parsed = parseSource("cc.js", readFileSync(join(PROJECT_ROOT, "tests/fixtures/targets/complexity/cc.js"), "utf8"));
  const fns = findExports(parsed, buildScope(parsed.program!)).functions;
  const cc = Object.fromEntries(fns.map((f) => [f.name, cyclomatic(f.node)]));
  assert.deepEqual(cc, { straight: 1, ifElse: 2, loopIf: 3, logical: 4, switcher: 3, tryTernary: 3, withNested: 2 });
});

test("[MAP-05] while, do-while, for-in, for-of and ?? each add one; an arrow with an expression body works", () => {
  const program = parseSource("w.js", "var f = (a) => a ?? 1;\nfunction g(o, xs) { while (o) { o = o.next } do { o-- } while (o > 0); for (var k in o) {} for (var x of xs) {} }").program!;
  const body = program.body;
  const arrow = body[0]!.type === "VariableDeclaration" ? body[0]!.declarations[0]!.init! : null;
  assert.equal(cyclomatic(arrow!), 2);
  assert.equal(cyclomatic(body[1]!), 5);
});

test("[MAP-05] hotspots are the top 5 by complexity, ties broken by functionId", () => {
  const fns = [
    { functionId: "a.js#z", complexity: 3 }, { functionId: "a.js#b", complexity: 7 }, { functionId: "a.js#c", complexity: 3 },
    { functionId: "a.js#a", complexity: 3 }, { functionId: "b.js#q", complexity: 1 }, { functionId: "a.js#y", complexity: 9 },
  ];
  assert.deepEqual(topHotspots(fns), [
    { functionId: "a.js#y", complexity: 9 }, { functionId: "a.js#b", complexity: 7 }, { functionId: "a.js#a", complexity: 3 },
    { functionId: "a.js#c", complexity: 3 }, { functionId: "a.js#z", complexity: 3 },
  ]);
  assert.equal(topHotspots(fns, 2).length, 2);
  assert.deepEqual(fns[0], { functionId: "a.js#z", complexity: 3 }, "input is not reordered");
});
