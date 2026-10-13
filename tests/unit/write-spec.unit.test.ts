import test from "node:test";
import assert from "node:assert/strict";
import type { HypothesesFile, HypothesisOutput } from "../../src/contracts/hypotheses.ts";
import type { StaticMap } from "../../src/contracts/map.ts";
import type { MutationReport } from "../../src/contracts/mutation.ts";
import type { Outcome } from "../../src/contracts/outcomes.ts";
import type { RecordedCase, RecordsFile } from "../../src/contracts/records.ts";
import type { ReportFile } from "../../src/contracts/report.ts";
import type { Tagged } from "../../src/contracts/tagged.ts";
import { escapeMd, formatArgs, formatOutcome, formatPrediction, formatTagged } from "../../src/generate/format-value.ts";
import { listNotCharacterized, providerLabel, writeSpec } from "../../src/generate/write-spec.ts";
import { evaluateRules } from "../../src/pipeline/evaluate-rules.ts";
import { syntheticFn } from "../helpers/billing.ts";

const F = "x.js#f";
const tool = { name: "legacy-archaeologist" as const, version: "0.1.0" };
const sha = "sha256:" + "3f9a1b2c3d4e".padEnd(64, "0");
const R = (v: Tagged): Outcome => ({ kind: "returned", value: v });
const fn = syntheticFn(["a", "b"], {
  id: F, name: "f", exportName: "f", loc: { startLine: 3, endLine: 9 }, complexity: 3,
  sideEffects: [{ kind: "Date", line: 5, detail: "new Date" }, { kind: "Math.random", line: 6, detail: "Math.random" }, { kind: "net", line: 7, detail: "fetch" }],
  magicNumbers: [{ value: 100, line: 4, column: 10 }], readsModuleState: ["RATES"],
});
const map: StaticMap = {
  schemaVersion: 1, tool, targetDir: "fixtures/x", targetSha: sha,
  files: [{ path: "x.js", bytes: 10, sha256: "0".repeat(64), parse: "ok", sourceType: "script" }],
  modules: [{ file: "x.js", kind: "cjs", exports: [{ name: "f", kind: "function", functionId: F }], externalSpecifiers: [], moduleState: [{ name: "_n", line: 1, declaration: "var" }], functions: [{ ...fn, writesModuleState: ["_n"], writesGlobals: ["LAST"], sideEffects: [...fn.sideEffects, { kind: "global-write", line: 8, detail: "LAST" }] }] }],
  hotspots: [{ functionId: F, complexity: 3 }],
  stats: { files: 1, parsedFiles: 1, functions: 1, exportedFunctions: 1, unresolvedCalls: 0, unresolvedIdentifiers: 0, sideEffects: {} as StaticMap["stats"]["sideEffects"] },
};
let counter = 0;
const rc = (args: Tagged[], outcome: Outcome, extra: Partial<RecordedCase> = {}): RecordedCase => {
  counter += 1;
  return { id: `${F}#c${String(counter).padStart(2, "0")}`, functionId: F, moduleFile: "x.js", exportName: "f", style: "sync", origin: "rule-probe", ruleRefs: [], round: 0, label: "l", steps: [{ args, outcome }], stateAfter: null, consoleLines: 0, determinism: "stable", ...extra };
};
const cases = [
  rc([80, "STAFF"], R(60), { ruleRefs: ["BR-01"] }),
  rc([0.04, "STAFF"], R(0.03), { ruleRefs: ["BR-01"] }),
  rc([100, "VIP"], R(100), { ruleRefs: ["BR-02"], label: "vip at 100" }),
  rc([1, 1], R(1), { origin: "partition", determinism: "unstable", instability: { step: 1, firstRun: R(1), secondRun: R(2) } }),
  rc([2, 2], { kind: "timeout", reason: "watchdog" }, { origin: "partition" }),
  rc([3, 3], { kind: "no-callback" }, { origin: "partition" }),
  rc([4, 4], { kind: "threw", value: { $t: "Error", name: "Error", message: "network is disabled", code: "NO_NETWORK" } }, { origin: "partition" }),
];
const output: HypothesisOutput = {
  rules: [
    { key: "staff-rate", statement: "STAFF code always takes 25% off", relatedConstants: [], probes: [{ label: "staff 80", steps: [{ args: [80, "STAFF"] }], prediction: { kind: "returns", value: 60 } }, { label: "staff cents", steps: [{ args: [0.04, "STAFF"] }], prediction: { kind: "returns", value: 0.03 } }] },
    { key: "vip-threshold", statement: "VIP takes 10% off orders of 100.00 or more | a `b` <c>", relatedConstants: [100], probes: [{ label: "vip at 100", steps: [{ args: [100, "VIP"] }], prediction: { kind: "returns", value: 90 } }] },
    { key: "unknown-rule", statement: "Something nobody can check yet.", relatedConstants: [], probes: [{ label: "who knows", steps: [{ args: [5, 5] }], prediction: { kind: "unknown" } }] },
  ],
  partitions: [],
  notes: "Discount table keyed by code;\nVIP has a threshold.",
};
const hypotheses: HypothesesFile = { schemaVersion: 1, tool, targetSha: sha, provider: "fake", model: "fake", scenario: "x-scenario", functions: [{ functionId: F, output, usage: { promptTokens: 0, completionTokens: 0 } }], rejected: [] };
const records: RecordsFile = { schemaVersion: 1, tool, targetSha: sha, world: { clockNow: 1700000000000, seed: 42, tz: "UTC" }, limits: { maxCasesPerFunction: 40, maxExpansionsPerCase: 4, maxExpansionsPerFunction: 12, maxDepth: 5, maxSteps: 5, maxArgs: 8 }, cases, loadErrors: [] };
const testFile = "tests/x.characterization.test.mts";
const testLinks = { [`${F}#c01`]: { file: testFile, line: 14 }, [`${F}#c02`]: { file: testFile, line: 20 }, [`${F}#c03`]: { file: testFile, line: 26 } };
const evaluated = evaluateRules(hypotheses.functions, cases);
const report: ReportFile = { schemaVersion: 1, tool, targetSha: sha, provider: "fake", model: "fake", scenario: "x-scenario", rules: evaluated.rules, suspicious: evaluated.suspicious, notCharacterized: listNotCharacterized(cases), loadErrors: [], tests: [{ module: "x.js", file: testFile, count: 3 }], mutation: null };
const world = { clockNow: 1700000000000, seed: 42 };
const sample = { map, hypotheses, records, report, mutation: null, testLinks, world };

const noneHyp: HypothesesFile = { ...hypotheses, provider: "none", model: "none", functions: [{ functionId: F, output: { rules: [], partitions: [] }, usage: { promptTokens: 0, completionTokens: 0 } }] };
delete noneHyp.scenario;
const sampleNone = { ...sample, hypotheses: noneHyp, report: { ...report, provider: "none" as const, model: "none", rules: [], suspicious: [] } };

test("[GEN-03] SPEC.md has the sections of spec 5.11 in order with links to test lines and source lines", () => {
  const md = writeSpec(sample);
  const order = ["# Living spec: fixtures/x", "Generated by legacy-archaeologist 0.1.0 · target sha256 3f9a1b2c3d4e · provider: fake (scripted) · scenario x-scenario · clock 2023-11-14T22:13:20.000Z · seed 42", "## Summary", "## Module x.js (CommonJS)", "### f(a, b) — x.js:3-9 · complexity 3 · hotspot #1", "| Rule | Statement (LLM hypothesis) | Status | Probes (inputs → observed) | Evidence (tests) | Source |", "## Suspicious behaviors (human review required; nothing was changed)", "### SB-01 · x.js#f · BR-02", "## Not characterized", "## Side effects by function"];
  let at = -1;
  for (const h of order) {
    const i = md.indexOf(h);
    assert.ok(i > at, h);
    at = i;
  }
  assert.match(md, /\[c03\]\(tests\/x\.characterization\.test\.mts#L26\)/);
  assert.ok(md.includes("| 1 | 1 | 7 | 3 | 3 | 1 | 1 | 1 | not measured | 1 |"), md);
  assert.ok(md.includes("A rule is *consistent* when every probe the model chose for it matched the recorded outcome; it covers those probes and nothing more."));
  assert.ok(md.includes("Module state: `_n` (line 1, written by f). Globals written: `LAST` (f, line 8). Unresolved calls: 0."));
  assert.ok(md.includes("Magic numbers: 100 (line 4)."));
  assert.ok(md.includes('Archaeologist notes (LLM, unverified prose): "Discount table keyed by code; VIP has a threshold."'));
  assert.ok(md.includes("x.js:3-9; constant 100 at line 4"));
  assert.ok(!md.includes("## Mutation score"));
  assert.ok(!md.includes("## Modules not recorded"));
  assert.ok(md.endsWith("\n") && !md.endsWith("\n\n") && !md.includes("\r"));
  assert.equal(writeSpec(sample), md);
});

test("[SUS-02] statuses print as consistent (n probes), **contradicted** → SB-nn and unverified, with probe inputs and observed values", () => {
  const md = writeSpec(sample);
  assert.ok(md.includes("| BR-01 | STAFF code always takes 25% off | consistent (2 probes) | (80, \"STAFF\") → 60 · (0.04, \"STAFF\") → 0.03 | [c01](tests/x.characterization.test.mts#L14), [c02](tests/x.characterization.test.mts#L20) | x.js:3-9 |"), md);
  assert.ok(md.includes("| **contradicted** → SB-01 | (100, \"VIP\") → 100 (predicted 90) | [c03](tests/x.characterization.test.mts#L26) |"));
  assert.ok(md.includes("| BR-03 | Something nobody can check yet. | unverified | (5, 5) → not recorded (prediction unknown) | none | x.js:3-9 |"));
  assert.ok(md.includes("- Predicted for `f(100, \"VIP\")`: returns 90."));
  assert.ok(md.includes("- Observed (recorded, run twice, stable): returned 100."));
  assert.ok(md.includes("- Source: x.js:3-9; constant 100 at line 4."));
  assert.ok(md.includes("- Test that pins the observed behavior: [x.js#f#c03](tests/x.characterization.test.mts#L26)."));
  assert.ok(md.includes("- Hypothesis (LLM): VIP takes 10% off orders of 100.00 or more \\| a \\`b\\` \\<c\\>"));
});

test("[GEN-03] the provider label is printed: fake (scripted) with scenario, none (no LLM) with no rules table", () => {
  assert.equal(providerLabel({ provider: "fake", model: "fake", scenario: "s" }), "provider: fake (scripted) · scenario s");
  assert.equal(providerLabel({ provider: "none", model: "none" }), "provider: none (no LLM)");
  assert.equal(providerLabel({ provider: "openai-compatible", model: "openrouter/free" }), "provider: openai-compatible (openrouter/free)");
  const md = writeSpec(sampleNone);
  assert.match(md, /provider: none \(no LLM\)/);
  assert.ok(!md.includes("| Rule |"));
  assert.ok(md.includes("No rules: provider none derives inputs from the static map only."));
  assert.ok(md.includes("None: no probe contradicted the recorded behavior."));
});

test("[GEN-04] Not characterized lists each excluded case with its reason", () => {
  assert.deepEqual(listNotCharacterized(cases).map((n) => [n.caseId.split("#").at(-1), n.reason]), [["c04", "unstable"], ["c05", "timeout"], ["c06", "no-callback"], ["c07", "sandbox-only outcome"]]);
  const md = writeSpec(sample);
  for (const row of ["| x.js#f#c04 | unstable: step 1 differed between two runs |", "| x.js#f#c05 | timeout (watchdog) |", "| x.js#f#c06 | no callback within the case timeout |", "| x.js#f#c07 | sandbox-only outcome (NO_NETWORK) |"]) assert.ok(md.includes(row), row);
  const leaked = rc([9], { kind: "timeout", reason: "leaked-error" });
  assert.equal(listNotCharacterized([leaked])[0]!.reason, "leaked-error");
  const stateOnly = rc([9], R(1), { determinism: "unstable", instability: { step: 0, firstRun: R(1), secondRun: R(2) } });
  assert.equal(listNotCharacterized([stateOnly])[0]!.detail, "stateAfter differed between two runs");
});

test("side effects are listed per function with their handling; load errors get their own section", () => {
  const md = writeSpec({ ...sample, records: { ...records, loadErrors: [{ module: "y.js", code: "EXTERNAL_DEPENDENCY", error: "requires leftpad" }] }, report: { ...report, loadErrors: [{ module: "y.js", code: "EXTERNAL_DEPENDENCY", error: "requires leftpad" }] } });
  assert.ok(md.includes("| f | Date: new Date (line 5) | frozen at 2023-11-14T22:13:20.000Z |"));
  assert.ok(md.includes("| f | Math.random: Math.random (line 6) | seeded (seed 42) in recording and in the tests; in production it varies |"));
  assert.ok(md.includes("| f | net: fetch (line 7) | blocked (records threw) |"));
  assert.ok(md.includes("| f | global-write: LAST (line 8) | detected; not asserted |"));
  assert.ok(md.includes("## Modules not recorded"));
  assert.ok(md.includes("| y.js | EXTERNAL_DEPENDENCY | requires leftpad |"));
});

test("the mutation section and the per-function mutants line appear when a mutation report is given", () => {
  const mutation: MutationReport = {
    schemaVersion: 1, tool, targetSha: sha, operators: ["ROR", "NUM"], truncated: 0, invalid: 0, replayedCases: [`${F}#c01`],
    mutants: [
      { id: "m-0001", functionId: F, file: "x.js", line: 4, column: 10, operator: "ROR", original: ">", replacement: ">=", status: "killed", killedBy: `${F}#c03`, roundKilled: 0, llmSuggestedEquivalent: null },
      { id: "m-0002", functionId: F, file: "x.js", line: 4, column: 12, operator: "NUM", original: "100", replacement: "101", status: "survived", killedBy: null, roundKilled: null, llmSuggestedEquivalent: { reason: "same | result" } },
    ],
    rounds: [],
    score: { killed: 1, timeout: 0, survived: 1, noCoverage: 0, error: 0, detected: 1, valid: 2, mutationScore: 50, byOperator: { ROR: { killed: 1, timeout: 0, survived: 0, noCoverage: 0, mutationScore: 100 }, NUM: { killed: 0, timeout: 0, survived: 1, noCoverage: 0, mutationScore: 0 } } as MutationReport["score"]["byOperator"] },
  };
  const md = writeSpec({ ...sample, mutation, report: { ...report, mutation: { mutationScore: 50, detected: 1, valid: 2 } } });
  assert.ok(md.includes("| 50.0% (1/2) |"));
  assert.ok(md.includes("Mutants in this function: 2 (killed 1, timeout 0, survived 1, no coverage 0)."));
  assert.ok(md.includes("## Mutation score"));
  assert.ok(md.includes("Same formula as Stryker so the definitions match; the scores are not comparable because the operator sets differ."));
  assert.ok(md.includes("| ROR | 1 | 0 | 0 | 0 | 100.0% |"));
  assert.ok(md.includes("| m-0002 | f | NUM | 4 | 100 → 101 | LLM suggests equivalent (advisory): same \\| result |"));
});

test("LLM strings are escaped for Markdown", () => {
  assert.equal(escapeMd("a | b `c` <x>"), "a \\| b \\`c\\` \\<x\\>");
  assert.equal(escapeMd("back\\slash *bold* _it_ [link]\r\nnext"), "back\\\\slash \\*bold\\* \\_it\\_ \\[link\\] next");
  const md = writeSpec(sample);
  assert.ok(md.includes("| VIP takes 10% off orders of 100.00 or more \\| a \\`b\\` \\<c\\> |"));
});

test("formatOutcome and formatArgs print the documented grammar", () => {
  const rows: [string, string][] = [
    [formatArgs([100, "VIP"]), '(100, "VIP")'],
    [formatArgs([]), "()"],
    [formatOutcome(R(100)), "returned 100"],
    [formatOutcome({ kind: "threw", value: { $t: "Error", name: "TypeError", message: "x" } }), 'threw TypeError("x")'],
    [formatOutcome({ kind: "callback", args: [null, { total: 107.25 }] }), 'callback [null, {"total": 107.25}]'],
    [formatOutcome({ kind: "promise", status: "fulfilled", value: 1 }), "promise fulfilled 1"],
    [formatOutcome({ kind: "timeout", reason: "watchdog" }), "timeout (watchdog)"],
    [formatOutcome({ kind: "timeout" }), "timeout"],
    [formatOutcome({ kind: "no-callback" }), "no callback"],
    [formatTagged([{ $t: "NaN" }, { $t: "-0" }, { $t: "Infinity" }, { $t: "-Infinity" }, { $t: "undefined" }, { $t: "bigint", v: "12" }]), "[NaN, -0, Infinity, -Infinity, undefined, 12n]"],
    [formatTagged({ $t: "Date", v: "2023-11-14T22:13:20.000Z" }), "Date(2023-11-14T22:13:20.000Z)"],
    [formatTagged({ $t: "Error", name: "Error", message: "msg", code: "NO_NETWORK" }), 'Error("msg", code NO_NETWORK)'],
    [formatTagged([{ $t: "function", name: "f" }, { $t: "function", name: "" }, { $t: "circular" }, { $t: "truncated", reason: "depth" }, { $t: "unserializable", type: "Map" }]), "[[function f], [function], [circular], [truncated: depth], [Map]]"],
    [formatTagged({ k: "v", n: [1, {}] }), '{"k": "v", "n": [1, {}]}'],
    [formatTagged({ $t: "object", v: { $t: "NaN" } }), '{"$t": "NaN"}'],
    [formatPrediction({ kind: "returns", value: 90 }), "returns 90"],
    [formatPrediction({ kind: "throws", name: "TypeError" }), "throws TypeError"],
    [formatPrediction({ kind: "throws" }), "throws"],
    [formatPrediction({ kind: "callback", value: 3 }), "callback 3"],
    [formatPrediction({ kind: "unknown" }), "unknown"],
  ];
  for (const [actual, expected] of rows) assert.equal(actual, expected);
});
