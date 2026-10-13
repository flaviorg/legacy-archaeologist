import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HypothesesFile } from "../../src/contracts/hypotheses.ts";
import type { MutationReport } from "../../src/contracts/mutation.ts";
import type { RecordsFile, TimingsFile } from "../../src/contracts/records.ts";
import { pipelineOn } from "../helpers/cases.ts";

const readJson = <T>(out: string, name: string): T => JSON.parse(readFileSync(join(out, name), "utf8")) as T;
const traceOf = (out: string) => readFileSync(join(out, "llm-trace.jsonl"), "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

test("[MUT-06] the loop stops after maxRounds even when survivors remain and considers at most survivorsPerRound per round", async (t) => {
  const { out } = await pipelineOn(t, "threshold", { provider: "fake", scenario: "survivor-mini", maxRounds: 1, survivorsPerRound: 2 });
  const m = readJson<MutationReport>(out, "mutation.json");
  assert.equal(m.rounds.length, 1);
  assert.deepEqual(m.rounds[0]!.survivorsConsidered, ["m-0003", "m-0004"]);
  assert.ok(m.mutants.filter((x) => x.status === "survived").length > 0, "survivors remain");
  assert.deepEqual(m.mutants.filter((x) => x.status === "survived").map((x) => x.id), ["m-0004"]);
  const r = m.rounds[0]!;
  assert.equal(r.inputsProposed, 5);
  assert.equal(r.inputsAccepted, 3);
  assert.deepEqual(r.inputsRejected, [{ reason: "ARITY", count: 1 }, { reason: "DUPLICATE", count: 1 }]);
  const hypotheses = readJson<HypothesesFile>(out, "hypotheses.json");
  assert.deepEqual(hypotheses.rejected.map((x) => [x.origin, x.label, x.reason, x.mutantRef]), [["survivor-round", "same as an existing input", "DUPLICATE", "m-0003"], ["survivor-round", "three arguments", "ARITY", "m-0004"]]);
  assert.deepEqual(r.killed, ["m-0003", "m-0005", "m-0006", "m-0011", "m-0012"]);
  assert.ok(r.scoreAfter > r.scoreBefore);
  assert.equal(r.scoreAfter, m.score.mutationScore);
  const survivorTrace = traceOf(out).filter((e) => e.prompt === "survivor-inputs.v1");
  assert.deepEqual(survivorTrace.map((e) => e.matchKeys.mutantId), ["m-0003", "m-0004"]);
  assert.deepEqual(survivorTrace[1].rejected, [{ label: "three arguments", reason: "ARITY" }]);
  assert.match(survivorTrace[0].user, /Mutant: m-0003 \(ROR\) at line 3: `>` replaced by `>=`/);
  assert.match(survivorTrace[0].user, /^- \[20\]$/m, "the existing inputs are listed");
});

test("[MUT-06] a mutant is never asked about twice across rounds", async (t) => {
  // Round 1 asks m-0003 (its fee(10) kills everything but m-0004), round 2 asks m-0004, and round 3 has no survivor that
  // was not asked yet: the fixture has no round-3 turn, so asking m-0004 again would fail with UNSCRIPTED_LLM_CALL.
  const { out } = await pipelineOn(t, "threshold", { provider: "fake", scenario: "survivor-mini", maxRounds: 3, survivorsPerRound: 1 });
  const m = readJson<MutationReport>(out, "mutation.json");
  assert.deepEqual(m.rounds.map((r) => r.survivorsConsidered), [["m-0003"], ["m-0004"]]);
  assert.deepEqual(m.rounds[1]!.killed, []);
  const asked = traceOf(out).filter((e) => e.prompt === "survivor-inputs.v1").map((e) => e.matchKeys.mutantId);
  assert.deepEqual(asked, [...new Set(asked)]);
});

test("[MUT-06] the loop is skipped with the none provider", async (t) => {
  const { out } = await pipelineOn(t, "threshold", { provider: "none", maxRounds: 1 });
  const m = readJson<MutationReport>(out, "mutation.json");
  assert.deepEqual(m.rounds, []);
  assert.equal(readFileSync(join(out, "llm-trace.jsonl"), "utf8"), "");
  assert.ok(m.mutants.every((x) => x.roundKilled === null || x.roundKilled === 0));
});

test("[MUT-07] survivor inputs are recorded on the original code twice, added as survivor-round cases with mutantRef, and only survivors are re-run", async (t) => {
  const { out, result } = await pipelineOn(t, "threshold", { provider: "fake", scenario: "survivor-mini", maxRounds: 1, survivorsPerRound: 2 });
  const records = readJson<RecordsFile>(out, "records.json");
  assert.deepEqual(records, JSON.parse(JSON.stringify(result.records)));
  const atTen = records.cases.find((c) => JSON.stringify(c.steps.map((s) => s.args)) === "[[10]]");
  assert.ok(atTen, "the fee(10) case is in records.json");
  assert.equal(atTen.origin, "survivor-round");
  assert.equal(atTen.round, 1);
  assert.equal(atTen.mutantRef, "m-0003");
  assert.equal(atTen.id, "index.js#fee#c04", "numbering continues after the round-0 cases");
  assert.deepEqual(atTen.steps[0]!.outcome, { kind: "returned", value: 0 }, "the original's answer, not the mutant's");
  assert.equal(atTen.determinism, "stable");
  const m = readJson<MutationReport>(out, "mutation.json");
  assert.deepEqual(m.rounds[0]!.newCases, ["index.js#fee#c04", "index.js#fee#c05", "index.js#fee#c06"]);
  assert.equal(records.cases.find((c) => c.id === "index.js#fee#c06")!.mutantRef, "m-0004");

  const timings = readJson<TimingsFile>(out, "timings.json");
  assert.ok(timings.cases["index.js#fee#c04"], "durations of the new cases");
  const lastProbe = timings.batches.map((b) => b.kind).lastIndexOf("probe");
  const firstReplay = timings.batches.findIndex((b) => b.kind === "replay");
  assert.ok(firstReplay < lastProbe, "round-0 replays come before the round-1 recording");
  assert.deepEqual(timings.batches.slice(lastProbe - 1, lastProbe + 1).map((b) => b.kind), ["probe", "probe"], "two recording runs for round 1");
  const round1 = timings.batches.slice(lastProbe + 1);
  assert.ok(round1.length > 0 && round1.every((b) => b.kind === "replay"));
  const round0Survivors = new Set(m.mutants.filter((x) => x.roundKilled !== 0).map((x) => x.id));
  for (const b of round1) assert.ok(round0Survivors.has(b.mutantId!), `${b.mutantId} survived round 0`);
  assert.deepEqual(m.mutants.filter((x) => x.roundKilled === 1).map((x) => x.id), ["m-0003", "m-0005", "m-0006", "m-0011", "m-0012"]);
  assert.equal(m.mutants.find((x) => x.id === "m-0003")!.killedBy, "index.js#fee#c04");
  for (const id of ["index.js#fee#c04", "index.js#fee#c05", "index.js#fee#c06"]) assert.ok(m.replayedCases.includes(id), id);
  const emitted = [...readFileSync(join(out, "tests/index.characterization.test.mts"), "utf8").matchAll(/test\("\[([^\]]+)\]/g)].map((x) => x[1]).sort();
  assert.deepEqual(emitted, [...m.replayedCases].sort(), "DEMO-06 holds after a survivor round");
});

test("[MUT-09] likelyEquivalent true leaves the status and the score unchanged and stores llmSuggestedEquivalent", async (t) => {
  const before = await pipelineOn(t, "threshold", { provider: "fake", scenario: "survivor-equivalent", maxRounds: 0 });
  const after = await pipelineOn(t, "threshold", { provider: "fake", scenario: "survivor-equivalent", maxRounds: 1, survivorsPerRound: 1 });
  const m0 = readJson<MutationReport>(before.out, "mutation.json");
  const m1 = readJson<MutationReport>(after.out, "mutation.json");
  const asked = m1.mutants.find((x) => x.id === "m-0003")!;
  assert.equal(asked.status, "survived");
  assert.deepEqual(asked.llmSuggestedEquivalent, { reason: "The threshold value is never passed in practice, so both versions behave the same." });
  assert.ok(m1.mutants.filter((x) => x.id !== "m-0003").every((x) => x.llmSuggestedEquivalent === null));
  assert.deepEqual(m1.score, m0.score);
  assert.equal(m1.rounds[0]!.scoreBefore, m1.rounds[0]!.scoreAfter);
  assert.deepEqual(m1.rounds[0]!.newCases, []);
  assert.equal(m0.mutants.find((x) => x.id === "m-0003")!.llmSuggestedEquivalent, null);
});
