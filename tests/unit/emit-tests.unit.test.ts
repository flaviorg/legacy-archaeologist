import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleInfo } from "../../src/contracts/map.ts";
import { outcomesEqual, stateAfterOf, taggedEqual } from "../../src/contracts/outcomes.ts";
import type { Outcome } from "../../src/contracts/outcomes.ts";
import type { RecordedCase } from "../../src/contracts/records.ts";
import { stableStringify } from "../../src/contracts/stable-json.ts";
import { revive, toTagged } from "../../src/contracts/tagged.ts";
import type { Tagged } from "../../src/contracts/tagged.ts";
import { emitTests } from "../../src/generate/emit-tests.ts";
import { formatOutcome } from "../../src/generate/format-value.ts";
import { supportFile } from "../../src/generate/support-template.ts";
import { parseSource } from "../../src/static/parser.ts";
import { syntheticFn } from "../helpers/billing.ts";
import { tmpDir } from "../helpers/tmp-target.ts";
import { OUTCOME_PAIRS, VALUES, sameValueDeep } from "../helpers/values.ts";

const fnF = syntheticFn(["a"], { id: "x.js#f", name: "f", exportName: "f" });
const fnCb = syntheticFn(["a", "b", "cb"], { id: "x.js#cbf", name: "cbf", exportName: "cbf", callbackParam: "cb", style: "callback" });
const fnDefault = syntheticFn(["a"], { id: "x.js#main", name: "main", exportName: "default" });
const fnDashed = syntheticFn(["a"], { id: "x.js#dashed", name: "dashed", exportName: "my-fn" });
const mod: ModuleInfo = {
  file: "x.js",
  kind: "cjs",
  exports: [{ name: "f", kind: "function", functionId: "x.js#f" }, { name: "cbf", kind: "function", functionId: "x.js#cbf" }],
  externalSpecifiers: [],
  moduleState: [],
  functions: [fnF, fnCb, fnDefault, fnDashed],
};
const base = { module: mod, cases: [] as RecordedCase[], moduleRelNoExt: "../../fixtures/x/x", targetDir: "fixtures/x", clockNow: 1700000000000, seed: 42, caseTimeoutMs: 2000, version: "0.1.0", targetSha: "sha256:" + "ab".repeat(32) };
const ok: Outcome = { kind: "returned", value: 1 };

const rc = (id: string, outcome: Outcome, extra: Partial<RecordedCase> = {}): RecordedCase => ({
  id: `x.js#f#${id}`, functionId: "x.js#f", moduleFile: "x.js", exportName: "f", style: "sync", origin: "partition", ruleRefs: [], round: 0, label: "l",
  steps: [{ args: [1], outcome }], stateAfter: null, consoleLines: 0, determinism: "stable", ...extra,
});
const testNames = (text: string): string[] => [...text.matchAll(/^test\((".*?"), async \(\) => \{$/gm)].map((m) => JSON.parse(m[1] as string) as string);

function importSources(text: string): string[] {
  const parsed = parseSource("support.mts", text);
  assert.ok(parsed.program, parsed.error ?? "parse failed");
  return parsed.program.body.flatMap((s) => (s.type === "ImportDeclaration" ? [String(s.source.value)] : []));
}

test("[GEN-02] test names follow [<caseId>] <origin>: <label> for every origin and never contain a statement", () => {
  const { testFile } = emitTests({
    ...base,
    cases: [
      rc("c01", ok, { origin: "rule-probe", ruleRefs: ["BR-01", "BR-02"], label: "vip at 100" }),
      rc("c02", ok, { origin: "baseline", label: "base vector" }),
      rc("c03", ok, { origin: "boundary-expansion", expandsCase: "x.js#f#c01", label: "vip at 100 / arg 1 +1" }),
      rc("c04", ok, { origin: "survivor-round", mutantRef: "m-0007", round: 1, label: "tiny" }),
      rc("c05", ok, { origin: "partition", label: "plain" }),
    ],
  });
  assert.deepEqual(testNames(testFile), [
    "[x.js#f#c01] probe BR-01, BR-02: vip at 100",
    "[x.js#f#c02] baseline: base vector",
    "[x.js#f#c03] boundary of x.js#f#c01: vip at 100 / arg 1 +1",
    "[x.js#f#c04] survivor m-0007: tiny",
    "[x.js#f#c05] partition: plain",
  ]);
  for (const n of ['"[x.js#f#c01] probe BR-01, BR-02: vip at 100"', '"[x.js#f#c04] survivor m-0007: tiny"']) assert.ok(testFile.includes(`test(${n}`), n);
});

test("[GEN-02] labels are sanitized to printable ASCII and at most 120 characters", () => {
  const { testFile } = emitTests({ ...base, cases: [rc("c01", ok, { label: "é\u0007" + "a".repeat(200) }), rc("c02", ok, { label: 'quote " and back\\slash' })] });
  const [first, second] = testNames(testFile);
  assert.ok(first && second);
  assert.match(first, /^[\x20-\x7E]+$/);
  assert.equal(first, "[x.js#f#c01] partition: " + "a".repeat(120));
  assert.equal(second, '[x.js#f#c02] partition: quote " and back\\slash');
});

test("[GEN-04] unstable, timeout, no-callback and sandbox-only cases are not emitted", () => {
  const net: Outcome = { kind: "threw", value: { $t: "Error", name: "Error", message: "network is disabled", code: "NO_NETWORK" } };
  const { testFile, testLines } = emitTests({
    ...base,
    cases: [
      rc("c01", ok),
      rc("c02", ok, { determinism: "unstable", instability: { step: 1, firstRun: ok, secondRun: { kind: "returned", value: 2 } } }),
      rc("c03", { kind: "timeout", reason: "watchdog" }),
      rc("c04", { kind: "no-callback" }),
      rc("c05", net),
    ],
  });
  assert.deepEqual(Object.keys(testLines), ["x.js#f#c01"]);
  assert.deepEqual(testNames(testFile), ["[x.js#f#c01] partition: l"]);
});

test("[GEN-02] every test is async, loads fresh first, and the file declares MODULE_REL, MODULE_NAME and configureWorld", () => {
  const { testFile } = emitTests({ ...base, cases: [rc("c01", ok), rc("c02", ok), rc("c03", ok)] });
  const lines = testFile.split("\n");
  assert.equal(lines[0], "// Generated by legacy-archaeologist 0.1.0 for fixtures/x (sha256 abababababab). Do not edit: regenerate.");
  assert.equal(lines[1], "// Expected values were RECORDED from the real code with a frozen clock (2023-11-14T22:13:20.000Z) and seed 42.");
  assert.ok(lines.includes('import { test } from "node:test";'));
  assert.ok(lines.includes('import assert from "node:assert/strict";'));
  assert.ok(lines.includes('import { configureWorld, loadFresh, capture, outcomesEqual, describeOutcome } from "./support.mts";'));
  assert.ok(lines.includes('const MODULE_REL = "../../fixtures/x/x";'));
  assert.ok(lines.includes('const MODULE_NAME = "x";'));
  assert.ok(lines.includes("configureWorld({ clockNow: 1700000000000, seed: 42 });"));
  const asyncLoads = testFile.match(/^test\(".*", async \(\) => \{\n {2}const m = await loadFresh\(MODULE_REL, MODULE_NAME, import\.meta\.url\);$/gm) ?? [];
  assert.equal(asyncLoads.length, 3);
  assert.equal((testFile.match(/^test\(/gm) ?? []).length, 3);
  const parsed = parseSource("x.characterization.test.mts", testFile);
  assert.equal(parsed.error, null);
  assert.equal(parsed.sourceType, "module");
});

test("[GEN-02] callback, promise and sequence cases use captureCallback, captureAsync and per-step comparison", () => {
  const date: Tagged = { $t: "Date", v: "2023-11-24T22:13:20.000Z" };
  const { testFile } = emitTests({
    ...base,
    cases: [
      rc("c01", { kind: "promise", status: "fulfilled", value: 3 }),
      { ...rc("c02", ok), steps: [{ args: [1], outcome: ok }, { args: [2], outcome: { kind: "promise", status: "rejected", value: "no" } }, { args: [], outcome: ok }] },
      rc("c03", ok, { steps: [{ args: [date, { a: [1, "x"] }], outcome: ok }] }),
      { ...rc("c01", { kind: "callback", args: [null, 2] }), id: "x.js#cbf#c01", functionId: "x.js#cbf", exportName: "cbf", style: "callback" },
      { ...rc("c01", ok), id: "x.js#main#c01", functionId: "x.js#main", exportName: "default" },
      { ...rc("c01", ok), id: "x.js#dashed#c01", functionId: "x.js#dashed", exportName: "my-fn" },
    ],
  });
  assert.ok(testFile.includes("  const actual = await captureAsync(() => m.f(1), 2000);"));
  assert.ok(testFile.includes('  const expected = {"kind":"promise","status":"fulfilled","value":3};'));
  assert.ok(testFile.includes("  const actual = [\n    capture(() => m.f(1)),\n    await captureAsync(() => m.f(2), 2000),\n    capture(() => m.f()),\n  ];"));
  assert.ok(testFile.includes("  actual.forEach((a, i) => assert.ok(outcomesEqual(a, expected[i]), describeOutcome(expected[i], a, i)));"));
  assert.ok(testFile.includes('  const actual = capture(() => m.f(revive({"$t":"Date","v":"2023-11-24T22:13:20.000Z"}), {"a":[1,"x"]}));'));
  assert.ok(testFile.includes("  const actual = await captureCallback((cb) => m.cbf(1, undefined, cb), 2000);"));
  assert.ok(testFile.includes('  const expected = {"kind":"callback","args":[null,2]};'));
  assert.ok(testFile.includes("  const actual = capture(() => m.default(1));"));
  assert.ok(testFile.includes('  const actual = capture(() => m["my-fn"](1));'));
  assert.ok(testFile.includes("  assert.ok(outcomesEqual(actual, expected), describeOutcome(expected, actual));"));
  assert.ok(testFile.includes('import { configureWorld, loadFresh, capture, captureAsync, captureCallback, revive, outcomesEqual, describeOutcome } from "./support.mts";'));
});

test("keys named __proto__ survive in arguments and expected values through JSON.parse literals", () => {
  const arg = JSON.parse('{"__proto__":{"x":1}}') as Tagged;
  const { testFile } = emitTests({ ...base, cases: [rc("c01", { kind: "returned", value: arg }, { steps: [{ args: [arg], outcome: { kind: "returned", value: arg } }] })] });
  assert.ok(testFile.includes(`capture(() => m.f(revive(JSON.parse(${JSON.stringify('{"__proto__":{"x":1}}')}))))`), testFile);
  assert.ok(testFile.includes(`const expected = JSON.parse(${JSON.stringify('{"kind":"returned","value":{"__proto__":{"x":1}}}')});`));
});

test("[GEN-09] stateAfter is asserted with taggedEqual only when non-null", () => {
  const { testFile } = emitTests({ ...base, cases: [rc("c01", ok, { stateAfter: { count: 2, list: [1] } }), rc("c02", ok)] });
  const blocks = testFile.split("\ntest(").slice(1);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0]!.includes('  assert.ok(taggedEqual(stateAfterOf(m), {"count":2,"list":[1]}), "stateAfter differs");'));
  assert.ok(!blocks[1]!.includes("stateAfterOf"));
  assert.ok(testFile.includes("taggedEqual, stateAfterOf, describeOutcome } from"));
  assert.ok(!emitTests({ ...base, cases: [rc("c02", ok)] }).testFile.includes("stateAfterOf"));
});

test("emitting twice yields identical text, LF and a trailing newline; testLines point at the test( lines", () => {
  const input = { ...base, cases: [rc("c02", ok), rc("c01", ok, { stateAfter: { n: 1 } }), { ...rc("c01", ok), id: "x.js#cbf#c01", functionId: "x.js#cbf", exportName: "cbf", style: "callback" as const, steps: [{ args: [], outcome: { kind: "callback" as const, args: [null] } }] }] };
  const a = emitTests(input), b = emitTests(input);
  assert.equal(a.testFile, b.testFile);
  assert.ok(!a.testFile.includes("\r"));
  assert.ok(a.testFile.endsWith("});\n") && !a.testFile.endsWith("\n\n"));
  assert.ok(!a.testFile.includes("\n\n\n"));
  const lines = a.testFile.split("\n");
  assert.deepEqual(Object.keys(a.testLines), ["x.js#f#c01", "x.js#f#c02", "x.js#cbf#c01"]);
  for (const [id, line] of Object.entries(a.testLines)) assert.ok(lines[line - 1]!.startsWith(`test("[${id}]`), `${id} at ${line}`);
  for (const line of lines) assert.ok(!/^\t/.test(line) && !/ $/.test(line), JSON.stringify(line));
});

test("support.mts imports only node:* and its pure functions agree with the tool's", async (t) => {
  const text = supportFile();
  assert.ok(text.endsWith("\n") && !text.includes("\r"));
  for (const lit of ['process.env.TZ = "UTC"', "registerHooks", "0x6D2B79F5", "LA_TARGET_DIR", "MODULE_NOT_FOUND_IN_AGAINST"]) assert.ok(text.includes(lit), lit);
  const sources = importSources(text);
  assert.ok(sources.length > 0);
  assert.deepEqual(sources.filter((x) => !x.startsWith("node:")), []);
  const dir = tmpDir(t);
  writeFileSync(join(dir, "support.mts"), text);
  const s = (await import(pathToFileURL(join(dir, "support.mts")).href)) as Record<string, (...args: any[]) => any>;
  for (const name of ["configureWorld", "reseedWorld", "loadFresh", "capture", "captureAsync", "captureCallback", "revive", "toTagged", "outcomesEqual", "taggedEqual", "stateAfterOf", "describeOutcome"]) assert.equal(typeof s[name], "function", name);
  for (const v of VALUES) {
    assert.equal(stableStringify(s.toTagged!(v)), stableStringify(toTagged(v)), String(v));
    assert.ok(sameValueDeep(s.revive!(toTagged(v)), revive(toTagged(v))), String(v));
  }
  for (const [a, b] of OUTCOME_PAIRS) {
    assert.equal(s.outcomesEqual!(a, b), outcomesEqual(a, b), JSON.stringify([a, b]));
    if (a.kind === "returned" && b.kind === "returned") assert.equal(s.taggedEqual!(a.value, b.value), taggedEqual(a.value, b.value));
    assert.equal(s.describeOutcome!(a, b), `expected ${formatOutcome(a)}   actual ${formatOutcome(b)}`);
    assert.equal(s.describeOutcome!(a, b, 2), `step 3: expected ${formatOutcome(a)}   actual ${formatOutcome(b)}`);
  }
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  for (const v of [circular, { f() { return 1; }, n: [() => 1, 2] }, "x".repeat(10_241), Array.from({ length: 3 }, () => ({ deep: { deeper: { deepest: { a: { b: { c: { d: 1 } } } } } } }))]) {
    assert.equal(stableStringify(s.toTagged!(v)), stableStringify(toTagged(v)));
  }
  const exportsLike = { count: 3, run() { return 1; }, default: { ignored: true }, nested: { fn: () => 1, keep: [() => 2, 4] } };
  // stateAfterOf in support.mts takes the module only (the kind is remembered from the last loadFresh).
  assert.equal(stableStringify(s.stateAfterOf!(exportsLike)), stableStringify(stateAfterOf(exportsLike, "commonjs")));
  assert.equal(s.stateAfterOf!({ run() { return 1; } }), null);
});
