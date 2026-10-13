import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HypothesesFile } from "../../src/contracts/hypotheses.ts";
import type { MutantEntry, MutationReport } from "../../src/contracts/mutation.ts";
import type { RecordedCase, RecordsFile } from "../../src/contracts/records.ts";
import { DEFAULT_CASE_LIMITS } from "../../src/contracts/limits.ts";
import { computeScore } from "../../src/mutation/score.ts";
import { evalLlm, renderEvalTable } from "../../src/pipeline/eval-llm.ts";
import type { RunArtifacts } from "../../src/pipeline/eval-llm.ts";
import { main } from "../../scripts/eval-llm.ts";
import { tmpDir } from "../helpers/tmp-target.ts";

// One function f(n) = n * 2, a handful of cases and two mutants per run.
const tool = { name: "legacy-archaeologist" as const, version: "0.0.0" };
const sha = "sha256:" + "a".repeat(64);
const fn = "x.js#f";

function rc(n: number, arg: number, origin: RecordedCase["origin"], extra: Partial<RecordedCase> = {}): RecordedCase {
  return { id: `${fn}#c${String(n).padStart(2, "0")}`, functionId: fn, moduleFile: "x.js", exportName: "f", style: "sync", origin, ruleRefs: [], round: 0, label: `case ${n}`, steps: [{ args: [arg], outcome: { kind: "returned", value: arg * 2 } }], stateAfter: null, consoleLines: 0, determinism: "stable", ...extra };
}

function records(cases: RecordedCase[]): RecordsFile {
  return { schemaVersion: 1, tool, targetSha: sha, world: { clockNow: 1700000000000, seed: 42, tz: "UTC" }, limits: DEFAULT_CASE_LIMITS, cases, loadErrors: [] };
}

function mutant(id: string, status: MutantEntry["status"], roundKilled: number | null): MutantEntry {
  return { id, functionId: fn, file: "x.js", line: 1, column: 25, operator: "AOR", original: "*", replacement: "/", status, killedBy: status === "killed" ? `${fn}#c01` : null, roundKilled, llmSuggestedEquivalent: null };
}

function mutation(mutants: MutantEntry[], rounds: MutationReport["rounds"], replayedCases: string[]): MutationReport {
  return { schemaVersion: 1, tool, targetSha: sha, operators: ["AOR"], truncated: 0, invalid: 0, replayedCases, mutants, rounds, score: computeScore(mutants) };
}

const noneHypotheses: HypothesesFile = {
  schemaVersion: 1, tool, targetSha: sha, provider: "none", model: "none",
  functions: [{ functionId: fn, output: { rules: [], partitions: [{ label: "base vector", steps: [{ args: [0] }] }, { label: "arg 1 = 2", steps: [{ args: [2] }] }] }, usage: { promptTokens: 0, completionTokens: 0 } }],
  rejected: [{ functionId: fn, origin: "baseline", label: "arg 1 = 0", reason: "DUPLICATE" }],
};

const noneRun: RunArtifacts = {
  hypotheses: noneHypotheses,
  records: records([rc(1, 0, "baseline"), rc(2, 2, "baseline"), rc(3, 1, "boundary-expansion", { expandsCase: `${fn}#c02` })]),
  mutation: mutation([mutant("m-0001", "killed", 0), mutant("m-0002", "survived", null)], [], [`${fn}#c01`, `${fn}#c02`, `${fn}#c03`]),
};

const probe = (label: string, arg: number, prediction: HypothesesFile["functions"][number]["output"]["rules"][number]["probes"][number]["prediction"]) => ({ label, steps: [{ args: [arg] }], prediction });

const fakeHypotheses: HypothesesFile = {
  schemaVersion: 1, tool, targetSha: sha, provider: "fake", model: "fake", scenario: "x-scenario",
  functions: [{
    functionId: fn,
    output: {
      rules: [
        { key: "doubles-one", statement: "One is doubled to two.", relatedConstants: [], probes: [probe("one", 1, { kind: "returns", value: 2 })] },
        { key: "two-gives-five", statement: "Two gives five, by a wrong guess.", relatedConstants: [], probes: [probe("two", 2, { kind: "returns", value: 5 })] },
        { key: "three-unknown", statement: "Three gives something unknown.", relatedConstants: [], probes: [probe("three", 3, { kind: "unknown" })] },
      ],
      partitions: [],
    },
    usage: { promptTokens: 120, completionTokens: 40 },
  }],
  rejected: [
    { functionId: fn, origin: "rule-probe", label: "too many arguments", reason: "ARITY", ruleKey: "doubles-one" },
    { functionId: fn, origin: "rule-probe", label: "one again", reason: "DUPLICATE", ruleKey: "doubles-one" },
    { functionId: fn, origin: "survivor-round", label: "zero again", reason: "DUPLICATE", mutantRef: "m-0002" }, // round 1: not a round-0 row
  ],
};

const fakeRun: RunArtifacts = {
  hypotheses: fakeHypotheses,
  records: records([
    rc(1, 1, "rule-probe", { ruleRefs: ["BR-01"] }),
    rc(2, 2, "rule-probe", { ruleRefs: ["BR-02"] }),
    rc(3, 3, "rule-probe", { ruleRefs: ["BR-03"], determinism: "unstable", instability: { step: 1, firstRun: { kind: "returned", value: 6 }, secondRun: { kind: "returned", value: 7 } } }),
    rc(4, 0, "survivor-round", { round: 1, mutantRef: "m-0002" }),
  ]),
  mutation: mutation(
    [mutant("m-0001", "killed", 0), mutant("m-0002", "killed", 1)],
    [{ round: 1, survivorsConsidered: ["m-0002"], inputsProposed: 2, inputsAccepted: 1, inputsRejected: [{ reason: "DUPLICATE", count: 1 }], newCases: [`${fn}#c04`], killed: ["m-0002"], scoreBefore: 50, scoreAfter: 100 }],
    [`${fn}#c01`, `${fn}#c02`, `${fn}#c04`],
  ),
};

const EXPECTED_TABLE = [
  "| Metric | none | fake (scripted) | Delta |",
  "|---|---|---|---|",
  "| rules consistent | 0 | 1 | +1 |",
  "| rules contradicted | 0 | 1 | +1 |",
  "| rules unverified | 0 | 1 | +1 |",
  "| inputs proposed | 2 | 3 | +1 |",
  "| inputs accepted (round 0) | 2 | 3 | +1 |",
  "| inputs rejected · ARITY | 0 | 1 | +1 |",
  "| inputs rejected · DUPLICATE | 1 | 1 | 0 |",
  "| cases recorded | 3 | 4 | +1 |",
  "| stable cases | 3 | 3 | 0 |",
  "| survivor inputs accepted | 0 | 1 | +1 |",
  "| mutants killed in survivor rounds | 0 | 1 | +1 |",
  "| kills per accepted survivor input | n/a | 1.00 | — |",
  "| mutation score | 50.0% | 100.0% | +50.0 pts |",
  "",
].join("\n");

test("[DEMO-05] the eval table from two hand-written runs is exactly the expected Markdown", () => {
  assert.equal(renderEvalTable(evalLlm(noneRun, fakeRun)), EXPECTED_TABLE);
  const t = evalLlm(noneRun, fakeRun);
  assert.deepEqual([t.targetSha, t.baseline, t.candidate], [sha, "none", "fake (scripted)"]);
});

test("[DEMO-05] runs with different targetSha are refused", () => {
  assert.throws(() => evalLlm(noneRun, { ...fakeRun, hypotheses: { ...fakeRun.hypotheses, targetSha: "sha256:other" } }), { code: "USAGE", message: "the two runs have different targetSha" });
});

test("[DEMO-05] the table is deterministic", () => {
  assert.equal(renderEvalTable(evalLlm(noneRun, fakeRun)), renderEvalTable(evalLlm(structuredClone(noneRun), structuredClone(fakeRun))));
});

test("negative deltas are signed and a real model is labeled with its name", () => {
  const real: RunArtifacts = { ...fakeRun, hypotheses: { ...fakeRun.hypotheses, provider: "openai-compatible", model: "some-model" } };
  const t = evalLlm(real, noneRun);
  assert.equal(t.baseline, "openai-compatible (some-model)");
  const row = (metric: string) => t.rows.find((r) => r.metric === metric)!;
  assert.deepEqual(row("cases recorded"), { metric: "cases recorded", baseline: "4", candidate: "3", delta: "-1" });
  assert.deepEqual(row("mutation score"), { metric: "mutation score", baseline: "100.0%", candidate: "50.0%", delta: "-50.0 pts" });
  assert.equal(row("kills per accepted survivor input").delta, "—");
});

test("[DEMO-05] scripts/eval-llm.ts prints the table for two run directories and refuses bad input with USAGE", (t) => {
  const dirs = [noneRun, fakeRun].map((run) => {
    const dir = tmpDir(t);
    writeFileSync(join(dir, "hypotheses.json"), JSON.stringify(run.hypotheses));
    writeFileSync(join(dir, "records.json"), JSON.stringify(run.records));
    writeFileSync(join(dir, "mutation.json"), JSON.stringify(run.mutation));
    return dir;
  });
  assert.deepEqual(main(["--baseline", dirs[0]!, "--candidate", dirs[1]!], "/"), { code: 0, stdout: EXPECTED_TABLE, stderr: "" });
  const missing = main(["--baseline", dirs[0]!], "/");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^error: USAGE: usage: node scripts\/eval-llm\.ts --baseline <run dir> --candidate <run dir>\n$/);
  const empty = tmpDir(t);
  assert.equal(main(["--baseline", dirs[0]!, "--candidate", empty], "/").stderr, `error: USAGE: --candidate: hypotheses.json not found in ${empty}\n`);
  assert.match(main(["--baseline", dirs[0]!, "--candidate", dirs[1]!, "--json"], "/").stderr, /^error: USAGE: Unknown option '--json'/);
});
