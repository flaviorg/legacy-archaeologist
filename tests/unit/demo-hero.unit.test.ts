import test from "node:test";
import assert from "node:assert/strict";
import type { HypothesesFile } from "../../src/contracts/hypotheses.ts";
import { SIDE_EFFECT_KINDS } from "../../src/contracts/map.ts";
import type { SideEffectKind, StaticMap } from "../../src/contracts/map.ts";
import { OPERATOR_IDS } from "../../src/contracts/mutation.ts";
import type { MutantEntry, MutationReport } from "../../src/contracts/mutation.ts";
import type { RecordedCase, RecordsFile } from "../../src/contracts/records.ts";
import type { ReportFile, SuspiciousBehavior } from "../../src/contracts/report.ts";
import { buildHero } from "../../src/pipeline/demo-hero.ts";
import type { DemoInput, PassArtifacts } from "../../src/pipeline/demo-hero.ts";
import { buildDemoSummary } from "../../src/pipeline/demo-summary.ts";
import type { VerifyReport } from "../../src/pipeline/verify.ts";

// A small hand-built DemoInput: only the fields the hero and the summary read are meaningful.
const TOOL = { name: "legacy-archaeologist", version: "0.1.0" } as const;

function mapOf(targetDir: string, sha: string, fns: { name: string; file: string; style: "sync" | "callback"; lines: [number, number] }[]): StaticMap {
  const sideEffects = Object.fromEntries(SIDE_EFFECT_KINDS.map((k) => [k, 0])) as Record<SideEffectKind, number>;
  sideEffects.Date = 2;
  return {
    schemaVersion: 1, tool: TOOL, targetDir, targetSha: sha,
    files: [{ path: fns[0]!.file, bytes: 100, sha256: "x", parse: "ok" }],
    modules: [{ file: fns[0]!.file, kind: "cjs", exports: [], externalSpecifiers: [], moduleState: [],
      functions: fns.map((f, i) => ({ id: `${f.file}#${f.name}`, name: f.name, exported: true, params: ["a"], callbackParam: f.style === "callback" ? "cb" : null, style: f.style,
        loc: { startLine: f.lines[0], endLine: f.lines[1] }, range: [0, 1], complexity: i + 1, sideEffects: [], calls: [], magicNumbers: [], readsModuleState: [], writesModuleState: [], writesGlobals: [], sourceBytes: 10, tooLargeForLlm: false })) }],
    hotspots: fns.map((f, i) => ({ functionId: `${f.file}#${f.name}`, complexity: fns.length - i })),
    stats: { files: 1, parsedFiles: 1, functions: fns.length, exportedFunctions: fns.length, unresolvedCalls: 0, unresolvedIdentifiers: 0, sideEffects },
  };
}

function caseOf(id: string, value: number, unstable = false): RecordedCase {
  const fn = id.split("#").slice(0, 2).join("#");
  return { id, functionId: fn, moduleFile: fn.split("#")[0]!, exportName: fn.split("#")[1]!, style: "sync", origin: "partition", ruleRefs: [], round: 0, label: "x",
    steps: [{ args: [value], outcome: { kind: "returned", value } }], stateAfter: null, consoleLines: 0, determinism: unstable ? "unstable" : "stable",
    ...(unstable ? { instability: { step: 1, firstRun: { kind: "returned", value: 1 }, secondRun: { kind: "returned", value: 2 } } } : {}) };
}

function mutant(id: string, status: MutantEntry["status"], roundKilled: number | null = null): MutantEntry {
  return { id, functionId: "billing.js#lateFee", file: "billing.js", line: 3, column: 1, operator: "AOR", original: "+", replacement: "-", status, killedBy: null, roundKilled, llmSuggestedEquivalent: null };
}

function mutationOf(mutants: MutantEntry[], score: number, rounds: MutationReport["rounds"] = []): MutationReport {
  const n = (s: string): number => mutants.filter((m) => m.status === s).length;
  const byOperator = Object.fromEntries(OPERATOR_IDS.map((op) => [op, { killed: 0, timeout: 0, survived: 0, noCoverage: 0, mutationScore: 0 }])) as MutationReport["score"]["byOperator"];
  return { schemaVersion: 1, tool: TOOL, targetSha: "sha256:ab", operators: [...OPERATOR_IDS], truncated: 0, invalid: 1, replayedCases: [], mutants, rounds,
    score: { killed: n("killed"), timeout: n("timeout"), survived: n("survived"), noCoverage: n("no-coverage"), error: n("error"), detected: n("killed") + n("timeout"), valid: mutants.length, mutationScore: score, byOperator } };
}

function hypothesesOf(provider: HypothesesFile["provider"], rules: number): HypothesesFile {
  const rule = { key: "late-fee", statement: "Paying early costs nothing at all.", relatedConstants: [], probes: [{ label: "early", steps: [{ args: [1] }], prediction: { kind: "returns" as const, value: 0 } }] };
  return { schemaVersion: 1, tool: TOOL, targetSha: "sha256:ab", provider, model: provider, functions: [{ functionId: "billing.js#lateFee", output: { rules: Array.from({ length: rules }, () => rule), partitions: [{ label: "p", steps: [{ args: [2] }] }] }, usage: { promptTokens: 1, completionTokens: 1 } }],
    rejected: [{ functionId: "billing.js#lateFee", origin: "partition", label: "dup", reason: "DUPLICATE" }] };
}

const SB: SuspiciousBehavior = { id: "SB-01", functionId: "billing.js#lateFee", ruleId: "BR-01", statement: "Paying early costs nothing at all.", probeLabel: "paid ten days early on 300.00", caseId: "billing.js#lateFee#c01",
  args: [[300]], predicted: { kind: "returns", value: 0 }, observed: { kind: "returned", value: -4.5 } };

function reportOf(provider: ReportFile["provider"], suspicious: SuspiciousBehavior[], tests: number, file: string): ReportFile {
  return { schemaVersion: 1, tool: TOOL, targetSha: "sha256:ab", provider, model: provider,
    rules: suspicious.length > 0 ? [{ functionId: "billing.js#lateFee", ruleId: "BR-01", key: "late-fee", statement: SB.statement, relatedConstants: [], status: "contradicted", probesChecked: 1, probes: [] }] : [],
    suspicious, notCharacterized: [], loadErrors: [], tests: [{ module: file, file: `x/${file}`, count: tests }], mutation: null };
}

function pass(outDir: string, map: StaticMap, provider: HypothesesFile["provider"], cases: RecordedCase[], mutation: MutationReport, suspicious: SuspiciousBehavior[], file: string): PassArtifacts {
  const records: RecordsFile = { schemaVersion: 1, tool: TOOL, targetSha: map.targetSha, world: { clockNow: 1700000000000, seed: 42, tz: "UTC" }, limits: {} as RecordsFile["limits"], cases, loadErrors: [] };
  return { outDir, map, hypotheses: hypothesesOf(provider, suspicious.length), records, mutation, report: reportOf(provider, suspicious, cases.filter((c) => c.determinism === "stable").length, file), testFiles: [`${outDir}/tests/${file.replace(/\.js$/, "")}.characterization.test.mts`], specLines: 40 };
}

const billing = mapOf("fixtures/legacy-billing", "sha256:0123456789abcdef", [{ name: "lateFee", file: "billing.js", style: "sync", lines: [82, 89] }, { name: "applyDiscount", file: "billing.js", style: "callback", lines: [35, 47] }]);
const bytes = mapOf("fixtures/third-party/bytes", "sha256:fedcba9876543210", [{ name: "bytes", file: "index.js", style: "sync", lines: [1, 20] }, { name: "format", file: "index.js", style: "sync", lines: [21, 40] }, { name: "parse", file: "index.js", style: "sync", lines: [41, 60] }]);

const verifyOf = (target: string, tests: number, failures: VerifyReport["files"][number]["failures"]): VerifyReport => ({
  target, files: [{ file: "artifacts/demo/tests/billing.characterization.test.mts", tests, passed: tests - failures.length, failed: failures.length, timedOut: false, failures }],
});

const sampleDemo: DemoInput = {
  version: "0.1.0",
  world: { clockNow: 1700000000000, seed: 42 },
  caseTimeoutMs: 2000,
  watchdogMarginMs: 1000,
  targetLines: 138,
  baseline: pass("artifacts/demo-baseline", billing, "none", [caseOf("billing.js#lateFee#c01", 1), caseOf("billing.js#lateFee#c02", 2, true)], mutationOf([mutant("m-0001", "killed", 0), mutant("m-0002", "survived")], 50), [], "billing.js"),
  fake: pass("artifacts/demo", billing, "fake", [caseOf("billing.js#lateFee#c01", 1), caseOf("billing.js#lateFee#c02", 2), caseOf("billing.js#lateFee#c03", 3)],
    mutationOf([mutant("m-0001", "killed", 0), mutant("m-0002", "killed", 1)], 100, [{ round: 1, survivorsConsidered: ["m-0002"], inputsProposed: 2, inputsAccepted: 1, inputsRejected: [], newCases: ["billing.js#lateFee#c03"], killed: ["m-0002"], scoreBefore: 50, scoreAfter: 100 }]), [SB], "billing.js"),
  thirdParty: pass("artifacts/demo-third-party", bytes, "none", [caseOf("index.js#bytes#c01", 1), caseOf("index.js#parse#c01", 2)], mutationOf([mutant("m-0001", "killed", 0), mutant("m-0002", "survived"), mutant("m-0003", "survived")], 33.3), [], "index.js"),
  thirdPartyName: "bytes@3.1.2",
  thirdPartyLicense: "MIT",
  verifyModern: verifyOf("fixtures/refactors/modern", 3, []),
  verifyBroken: verifyOf("fixtures/refactors/broken", 3, [
    { name: "[billing.js#applyDiscount#c01] probe BR-01: subtotal exactly 100.00 with VIP", caseId: "billing.js#applyDiscount#c01", message: "expected returned 100   actual returned 90" },
    { name: "[billing.js#lateFee#c02] partition: late", caseId: "billing.js#lateFee#c02", message: "expected returned 9   actual returned 4.5" },
  ]),
};

const EXPECTED_HERO = [
  "legacy-archaeologist 0.1.0 · demo · no network · no key",
  "fixtures/legacy-billing is a fixture we wrote with known quirks; the tool flags them without being told where they are:",
  "  ✔ lateFee paid ten days early on 300.00 returns -4.5 (a credit): flagged as SB-01, not fixed",
  "  ✔ the broken refactor fails 2 recorded cases (applyDiscount, lateFee); the modern one passes all 3",
  "bytes@3.1.2, code we did not write, no LLM: 3 functions · 2 stable cases · mutation score 33.3% · 2 surviving mutants",
  "mutation score on the fixture · none 50.0% · fake 100.0% (scripted: author-written survivor inputs; proves the loop, not the model)",
  "artifacts: artifacts/demo/SPEC.md · artifacts/demo/tests/ · artifacts/demo/llm-trace.jsonl · artifacts/demo-third-party/SPEC.md",
  "",
].join("\n");

test("[DEMO-03] the hero is at most 12 lines, built from the artifacts, with the caveat inside the score line", () => {
  const hero = buildHero(sampleDemo);
  const lines = hero.trimEnd().split("\n");
  assert.ok(lines.length <= 12);
  assert.equal(lines[0], "legacy-archaeologist 0.1.0 · demo · no network · no key");
  assert.ok(hero.includes(`none ${sampleDemo.baseline.mutation.score.mutationScore.toFixed(1)}% · fake ${sampleDemo.fake.mutation.score.mutationScore.toFixed(1)}% (scripted: author-written survivor inputs; proves the loop, not the model)`));
  assert.equal(hero, EXPECTED_HERO);
});

test("[DEMO-03] (a credit) appears only for a negative observed value", () => {
  const zero: SuspiciousBehavior = { ...SB, observed: { kind: "returned", value: 0 } };
  const demo: DemoInput = { ...sampleDemo, fake: { ...sampleDemo.fake, report: { ...sampleDemo.fake.report, suspicious: [zero] } } };
  const hero = buildHero(demo);
  assert.ok(!hero.includes("(a credit)"));
  assert.match(hero, /lateFee paid ten days early on 300\.00 returns 0: flagged as SB-01, not fixed/);
  const none: DemoInput = { ...sampleDemo, fake: { ...sampleDemo.fake, report: { ...sampleDemo.fake.report, suspicious: [] } } };
  assert.equal(buildHero(none).split("\n").length, EXPECTED_HERO.split("\n").length - 1, "the featured line is omitted without an SB");
});

test("the summary has three pass headers, six stage markers per pass, the two verify lines and no wall time", () => {
  const s = buildDemoSummary(sampleDemo);
  for (const m of ["[1/6] static map", "[3/6] recording", "[4/6] mutation", "[5/6] tests + SPEC.md", "[6/6] rules"]) assert.equal(s.split(m).length - 1, 3, m);
  assert.equal(s.split("[2/6] inputs").length - 1, 2);
  assert.equal(s.split("[2/6] hypotheses (LLM)").length - 1, 1);
  assert.ok(!/done in/.test(s));
  assert.match(s, /verify --against fixtures\/refactors\/modern/);
  assert.match(s, /verify --against fixtures\/refactors\/broken/);
  for (const h of ["── pass A · provider: none (no LLM; inputs derived from the static map) ──", "── pass B · provider: fake (scripted) ──", "── pass C · fixtures/third-party/bytes (bytes@3.1.2, MIT, not written by the author) · provider: none (no LLM) ──"]) assert.ok(s.includes(h), h);
  assert.ok(s.startsWith("\nlegacy-archaeologist 0.1.0 · demo · no network · clock 2023-11-14T22:13:20.000Z · seed 42\n"));
  assert.ok(s.includes("target: fixtures/legacy-billing (1 file, 138 lines, sha256 0123456789ab)"));
  assert.ok(s.includes("child: --permission, net guard, fd 3 + nonce, watchdog 3.0 s per case · 0 timeouts"));
  assert.ok(s.includes("round 0: killed 1 · timeout 0 · survived 1 · no-coverage 0 → mutation score 50.0%"));
  assert.ok(s.includes('1 more killed → 100.0% (0 survivors left, 0 flagged "likely equivalent" by the LLM, advisory)'));
  assert.ok(s.includes("SB-01 lateFee(300): predicted 0, observed -4.5 (billing.js:82-89)"));
  assert.ok(s.includes("  [billing.js#applyDiscount#c01] probe BR-01 … expected returned 100, actual returned 90"));
  assert.ok(s.includes("1 unstable (billing.js#lateFee#c02: step 1)"));
  assert.ok(s.includes("same 2 valid mutants as pass A"));
  assert.ok(s.includes("baseline value table · 0 rules · 1 derived inputs · 1 rejected (DUPLICATE ×1)"));
  assert.ok(s.includes("[2/6] hypotheses (LLM)  1 calls · 1 rules · 2 proposed inputs · 1 rejected (DUPLICATE ×1)"));
});

test("hero and summary are deterministic", () => {
  assert.equal(buildHero(sampleDemo), buildHero(sampleDemo));
  assert.equal(buildDemoSummary(sampleDemo), buildDemoSummary(sampleDemo));
});
