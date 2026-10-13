import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Mutant, MutationReport, OperatorId } from "../../src/contracts/mutation.ts";
import type { PlannedCase } from "../../src/contracts/records.ts";
import type { Tagged } from "../../src/contracts/tagged.ts";
import { stageTarget } from "../../src/harness/stage.ts";
import { replayCasesBudget } from "../../src/harness/run-batch.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { listMutants } from "../../src/mutation/mutator.ts";
import { OPERATORS } from "../../src/mutation/operators.ts";
import { MUTANTS_MARKER, prepareMutantsDir, replayMutants } from "../../src/mutation/run-mutants.ts";
import { computeScore } from "../../src/mutation/score.ts";
import { runMapStage } from "../../src/pipeline/map.ts";
import { runRecordStage } from "../../src/pipeline/record.ts";
import { parseSource } from "../../src/static/parser.ts";
import { pipelineOn } from "../helpers/cases.ts";
import { runCli } from "../helpers/run-cli.ts";
import { tmpDir, tmpTarget } from "../helpers/tmp-target.ts";

const quiet = createLogger({ level: "error", write: () => {} });
const WORLD = { clockNow: 1700000000000, seed: 42 };
const CASE_TIMEOUT_MS = 300;
const MARGIN_MS = 200;

function planned(exportName: string, n: number, args: Tagged[]): PlannedCase {
  const functionId = `index.js#${exportName}`;
  return { id: `${functionId}#c${String(n).padStart(2, "0")}`, functionId, moduleFile: "index.js", exportName, style: "sync", origin: "partition", ruleRefs: [], round: 0, label: `case ${n}`, steps: [{ args }] };
}

// Records hand-planned cases on a temporary copy of a target, then lists its mutants and offers a replay function.
async function recordOn(t: TestContext, name: string, cases: PlannedCase[]) {
  const target = tmpTarget(t, name);
  const out = join(tmpDir(t), "out");
  const { map, files } = runMapStage({ targetReal: target, outDir: out, logger: quiet });
  const staged = stageTarget({ targetReal: target, outDir: out });
  const { records, durations } = await runRecordStage({ map, staged, planned: cases, world: WORLD, caseTimeoutMs: CASE_TIMEOUT_MS, watchdogMarginMs: MARGIN_MS, outDir: out, logger: quiet });
  const mutants = listMutants(files.map((f) => parseSource(f.path, f.text)), map.modules.flatMap((m) => m.functions), OPERATORS, 200).mutants;
  const mutantsDir = prepareMutantsDir(out);
  const replay = (list: Mutant[]) =>
    replayMutants({ mutants: list, cases: records.cases, files: new Map(files.map((f) => [f.path, f.text] as const)), map, staged, durations, world: WORLD, caseTimeoutMs: CASE_TIMEOUT_MS, watchdogMarginMs: MARGIN_MS, mutantsDir, logger: quiet });
  const find = (operator: OperatorId, original: string, replacement: string): Mutant => {
    const m = mutants.find((x) => x.operator === operator && x.original === original && x.replacement === replacement);
    assert.ok(m, `${operator} ${original} -> ${replacement}`);
    return m;
  };
  return { out, records, mutants, replay, find };
}

const readMutation = (out: string): MutationReport => JSON.parse(readFileSync(join(out, "mutation.json"), "utf8")) as MutationReport;

test("the replay budget is clamp(10 × recorded duration, 2,000, steps × caseTimeoutMs)", () => {
  assert.equal(replayCasesBudget(1, 3, 2000), 2000);
  assert.equal(replayCasesBudget(3, 450, 2000), 4500);
  assert.equal(replayCasesBudget(2, 900, 2000), 4000);
  assert.equal(replayCasesBudget(1, 3, 300), 300, "never above the full budget");
});

test("[MUT-04] killed with killedBy the first differing characterized case, survived when all equal", async (t) => {
  const r = await recordOn(t, "mutation-mini", [planned("fee", 1, [10]), planned("fee", 2, [20])]);
  assert.deepEqual(r.records.cases.map((c) => c.steps[0]!.outcome), [{ kind: "returned", value: 0 }, { kind: "returned", value: 5 }]);
  const ror = r.find("ROR", ">", ">=");
  const five = r.find("NUM", "5", "6");
  const ten = r.find("NUM", "10", "11");
  const { statuses, replayedCases, batches } = await r.replay([ror, five, ten]);
  assert.deepEqual(statuses[ror.id], { status: "killed", killedBy: "index.js#fee#c01" });
  assert.deepEqual(statuses[five.id], { status: "killed", killedBy: "index.js#fee#c02" });
  assert.deepEqual(statuses[ten.id], { status: "survived", killedBy: null });
  assert.deepEqual(replayedCases, ["index.js#fee#c01", "index.js#fee#c02"]);
  assert.deepEqual(batches.map((b) => [b.kind, b.mutantId]), [["replay", ror.id], ["replay", five.id], ["replay", ten.id]]);
});

test("[MUT-04] a mutant that changes only exported state is killed through stateAfter", async (t) => {
  const r = await recordOn(t, "state-only", [planned("inc", 1, [2])]);
  const c = r.records.cases[0]!;
  assert.deepEqual([c.steps[0]!.outcome, c.stateAfter], [{ kind: "returned", value: true }, { count: 2 }]);
  const aor = r.find("AOR", "+", "-");
  const { statuses } = await r.replay([aor]);
  assert.deepEqual(statuses[aor.id], { status: "killed", killedBy: "index.js#inc#c01" });
});

test("[MUT-04] a function with no characterized case gives no-coverage; a mutant that breaks loading gives error", async (t) => {
  const net = await pipelineOn(t, "net-caller", { maxRounds: 0 });
  const netMutation = readMutation(net.out);
  assert.ok(netMutation.mutants.length > 0);
  assert.ok(netMutation.mutants.every((m) => m.status === "no-coverage" && m.killedBy === null), JSON.stringify(netMutation.mutants));
  assert.deepEqual(netMutation.replayedCases, []);
  assert.equal(netMutation.score.mutationScore, 0);
  assert.equal(netMutation.score.valid, netMutation.mutants.length);

  const boot = await pipelineOn(t, "load-error", { maxRounds: 0 });
  const bootMutation = readMutation(boot.out);
  const neg = bootMutation.mutants.find((m) => m.operator === "NEG");
  assert.ok(neg);
  assert.equal(neg.status, "error");
  assert.equal(bootMutation.score.error, bootMutation.mutants.filter((m) => m.status === "error").length);
  assert.equal(bootMutation.score.valid, bootMutation.mutants.length - bootMutation.score.error, "error mutants are outside the denominator");
});

test("[MUT-04] a mutant that loops is classified timeout only after a full-budget re-run, and counts as detected", async (t) => {
  const r = await recordOn(t, "mutation-loop", [planned("spin", 1, [3])]);
  assert.deepEqual(r.records.cases[0]!.steps[0]!.outcome, { kind: "returned", value: 3 });
  const loops = r.find("AOR", "+", "-");
  const ror = r.find("ROR", "<", "<=");
  const { statuses, batches } = await r.replay([loops, ror]);
  assert.deepEqual(statuses[loops.id], { status: "timeout", killedBy: null });
  assert.equal(batches.filter((b) => b.mutantId === loops.id).length, 2, "a first replay and the full-budget re-run");
  assert.deepEqual(statuses[ror.id], { status: "killed", killedBy: "index.js#spin#c01" });
  assert.equal(batches.filter((b) => b.mutantId === ror.id).length, 1);
  assert.equal(computeScore([{ operator: "AOR", status: "timeout" }]).detected, 1);
});

test("[MUT-05] mutation.json carries the score computed from the statuses, error excluded", async (t) => {
  const { out, result } = await pipelineOn(t, "mutation-mini", { maxRounds: 0 });
  const mutation = readMutation(out);
  assert.deepEqual(mutation, JSON.parse(JSON.stringify(result.mutation)));
  assert.deepEqual(mutation.score, computeScore(mutation.mutants));
  assert.deepEqual(mutation.operators, ["AOR", "ROR", "LOR", "NEG", "NUM", "BLOCK"]);
  assert.deepEqual(mutation.rounds, []);
  assert.deepEqual(mutation.mutants.map((m) => m.id), mutation.mutants.map((_, i) => `m-${String(i + 1).padStart(4, "0")}`));
  for (const m of mutation.mutants) assert.equal(m.roundKilled, m.status === "killed" || m.status === "timeout" ? 0 : null);
  assert.ok(mutation.score.valid > 0);
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  assert.deepEqual(report.mutation, { mutationScore: mutation.score.mutationScore, detected: mutation.score.detected, valid: mutation.score.valid });
  assert.match(readFileSync(join(out, "SPEC.md"), "utf8"), /Mutation score: \d+\.\d%/);
  const timings = JSON.parse(readFileSync(join(out, "timings.json"), "utf8"));
  assert.ok(timings.batches.some((b: { kind: string }) => b.kind === "replay"));
});

test("[DEMO-06] the case IDs in the emitted test file equal mutation.json replayedCases", async (t) => {
  const { out } = await pipelineOn(t, "mutation-mini", { maxRounds: 0 });
  const ids = [...readFileSync(join(out, "tests/index.characterization.test.mts"), "utf8").matchAll(/test\("\[([^\]]+)\]/g)].map((m) => m[1]).sort();
  assert.ok(ids.length > 0);
  assert.deepEqual(ids, [...readMutation(out).replayedCases].sort());
});

test("[MUT-08] the mutants directory is removed when the run ends", async (t) => {
  const { out } = await pipelineOn(t, "mutation-mini", { maxRounds: 0 });
  assert.ok(existsSync(join(out, "mutation.json")));
  assert.ok(!existsSync(join(out, "mutants")));
});

test("[RF-5] a leftover mutants directory with the marker is removed before mutation; one without the marker is refused", (t) => {
  const out = tmpDir(t);
  const dir = join(out, "mutants");
  mkdirSync(join(dir, "m-0001"), { recursive: true });
  writeFileSync(join(dir, MUTANTS_MARKER), "");
  writeFileSync(join(dir, "m-0001", "index.js"), "stale");
  assert.equal(prepareMutantsDir(out), dir);
  assert.ok(!existsSync(join(dir, "m-0001")) && existsSync(join(dir, MUTANTS_MARKER)));

  const other = tmpDir(t);
  mkdirSync(join(other, "mutants"));
  writeFileSync(join(other, "mutants", "notes.txt"), "mine");
  assert.throws(() => prepareMutantsDir(other), (err: Error & { code?: string }) => err.code === "MUTANT_COPY" && err.message === `refusing to delete ${join(other, "mutants")}: marker file missing`);
  assert.equal(readFileSync(join(other, "mutants", "notes.txt"), "utf8"), "mine");
});

test("run prints the mutation line with the per-operator breakdown", async (t) => {
  const target = tmpTarget(t, "mutation-mini");
  const out = join(tmpDir(t), "out");
  const r = await runCli(["run", "--target", target, "--out", out, "--provider", "none", "--i-trust-this-code", "--log-level", "warn"]);
  assert.equal(r.code, 0, r.stderr);
  const m = readMutation(out);
  const count = (op: OperatorId) => `${m.score.byOperator[op].killed + m.score.byOperator[op].timeout}/${m.score.byOperator[op].killed + m.score.byOperator[op].timeout + m.score.byOperator[op].survived + m.score.byOperator[op].noCoverage}`;
  const expected = `mutation: ${m.score.mutationScore.toFixed(1)}% (${m.score.detected}/${m.score.valid}) · ${OPERATORS.map((op) => `${op} ${count(op)}`).join(" · ")} · ${m.truncated} truncated · ${m.invalid} invalid`;
  assert.ok(r.stdout.split("\n").includes(expected), r.stdout);
});
