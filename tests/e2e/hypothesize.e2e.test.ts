import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StaticMap } from "../../src/contracts/map.ts";
import { LaError } from "../../src/infra/errors.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";
import { createFakeProvider } from "../../src/llm/fake-provider.ts";
import { runHypothesizeStage } from "../../src/pipeline/hypothesize.ts";
import { runMapStage } from "../../src/pipeline/map.ts";
import { tmpDir, tmpTarget } from "../helpers/tmp-target.ts";

const BILLING = join(PROJECT_ROOT, "fixtures/legacy-billing");
const FIXTURE = join(PROJECT_ROOT, "fixtures/llm/legacy-billing.json");
const ids = (map: StaticMap) => map.modules.flatMap((m) => m.functions.map((f) => f.id));

function capture() {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: createLogger({ level: "debug", write: (l) => lines.push(JSON.parse(l)) }) };
}

test("[HYP-01] the stage calls hypothesize.v1 once per exported function and writes hypotheses.json and the trace", async (t) => {
  const out = tmpDir(t);
  const { lines, logger } = capture();
  const { map, files } = runMapStage({ targetReal: BILLING, outDir: out, logger });
  const llm = createFakeProvider({ fixturePath: FIXTURE, targetSha: map.targetSha, functionIds: ids(map) });
  const r = await runHypothesizeStage({ map, files, provider: { kind: "llm", llm, name: "fake", model: "fake", scenario: "legacy-billing" }, outDir: out, logger, secrets: [] });
  assert.equal(r.hypotheses.functions.length, 7);
  assert.deepEqual(r.hypotheses.functions.map((f) => f.functionId), ids(map));
  const traceLines = readFileSync(join(out, "llm-trace.jsonl"), "utf8").trim().split("\n");
  assert.equal(traceLines.length, 7);
  assert.ok(traceLines.every((l) => JSON.parse(l).prompt === "hypothesize.v1"));
  assert.ok(traceLines.every((l) => JSON.parse(l).validation === "ok"));
  // Every hypothesize turn is used here; the survivor turns belong to the mutate stage.
  const hypothesizeTurns = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { turns: { id: string; prompt: string }[] }).turns.filter((x) => x.prompt === "hypothesize.v1").map((x) => x.id);
  assert.deepEqual([...llm.consumedIds()].sort(), [...hypothesizeTurns].sort());

  const file = JSON.parse(readFileSync(join(out, "hypotheses.json"), "utf8"));
  assert.equal(file.provider, "fake");
  assert.equal(file.model, "fake");
  assert.equal(file.scenario, "legacy-billing");
  assert.equal(file.targetSha, map.targetSha);
  assert.ok(file.functions.every((f: { usage: { promptTokens: number } }) => f.usage.promptTokens > 0));
  const rules = file.functions.reduce((n: number, f: { output: { rules: unknown[] } }) => n + f.output.rules.length, 0);
  assert.ok(rules >= 12 && rules <= 20, `about 15 rules, got ${rules}`);

  assert.ok(r.planned.length > 40);
  assert.ok(!JSON.stringify(r.planned).includes("prediction"));
  assert.equal(lines.filter((l) => l.event === "input_rejected").length, r.hypotheses.rejected.length);
  const withRejections = traceLines.map((l) => JSON.parse(l)).filter((e) => e.rejected.length > 0);
  assert.equal(withRejections.reduce((n, e) => n + e.rejected.length, 0), r.hypotheses.rejected.length);
  for (const id of ids(map)) assert.ok(r.planned.some((c) => c.functionId === id), id);
});

test("[HYP-01] --only limits the calls to the listed functions", async (t) => {
  const out = tmpDir(t);
  const { logger } = capture();
  const { map, files, allFunctionIds } = runMapStage({ targetReal: BILLING, outDir: out, only: ["billing.js#roundMoney"], logger });
  const llm = createFakeProvider({ fixturePath: FIXTURE, targetSha: map.targetSha, functionIds: allFunctionIds });
  const r = await runHypothesizeStage({ map, files, provider: { kind: "llm", llm, name: "fake", model: "fake", scenario: "legacy-billing" }, outDir: out, logger, secrets: [] });
  assert.deepEqual(llm.consumedIds(), ["hyp-roundMoney"]);
  assert.deepEqual(r.hypotheses.functions.map((f) => f.functionId), ["billing.js#roundMoney"]);
  assert.ok(r.planned.every((c) => c.functionId === "billing.js#roundMoney"));
  assert.equal(readFileSync(join(out, "llm-trace.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("[HYP-06] with provider none every function gets baseline proposals, rules are empty, the trace is empty and two runs are byte-identical", async (t) => {
  const texts: string[] = [];
  for (let i = 0; i < 2; i++) {
    const out = tmpDir(t);
    const { lines, logger } = capture();
    const { map, files } = runMapStage({ targetReal: BILLING, outDir: out, logger });
    const r = await runHypothesizeStage({ map, files, provider: { kind: "none" }, outDir: out, logger, secrets: [] });
    assert.equal(r.hypotheses.provider, "none");
    assert.equal(r.hypotheses.model, "none");
    assert.equal("scenario" in r.hypotheses, false);
    assert.equal(r.hypotheses.functions.length, 7);
    assert.ok(r.hypotheses.functions.every((f) => f.output.rules.length === 0 && f.output.partitions[0]!.label === "base vector"));
    assert.ok(r.hypotheses.functions.every((f) => f.usage.promptTokens === 0 && f.usage.completionTokens === 0));
    assert.equal(readFileSync(join(out, "llm-trace.jsonl"), "utf8"), "");
    assert.ok(r.planned.every((c) => c.origin === "baseline" || c.origin === "boundary-expansion"));
    assert.ok(r.planned.filter((c) => c.functionId === "billing.js#prorate").length === 40, "the baseline cap is 40 cases per function");
    assert.ok(r.hypotheses.rejected.some((x) => x.reason === "CAP_CASES") && r.hypotheses.rejected.some((x) => x.reason === "DUPLICATE"));
    assert.equal(lines.filter((l) => l.event === "llm_call").length, 0);
    texts.push(readFileSync(join(out, "hypotheses.json"), "utf8"));
  }
  assert.equal(texts[0], texts[1]);
});

test("[LLM-01] a fixture whose targetSha drifted fails with FIXTURE_TARGET_DRIFT before any call", (t) => {
  const target = join(tmpDir(t), "legacy-billing");
  cpSync(BILLING, target, { recursive: true });
  appendFileSync(join(target, "billing.js"), "\n// a later edit\n");
  const { logger } = capture();
  const { map } = runMapStage({ targetReal: target, outDir: tmpDir(t), logger });
  assert.throws(() => createFakeProvider({ fixturePath: FIXTURE, targetSha: map.targetSha, functionIds: ids(map) }), (err: unknown) => err instanceof LaError && err.code === "FIXTURE_TARGET_DRIFT");
});

// ---- oversize and malformed output (Task 31) ----

async function oversizeRun(t: import("node:test").TestContext) {
  const out = tmpDir(t);
  const target = tmpTarget(t, "threshold");
  const { lines, logger } = capture();
  const { map, files } = runMapStage({ targetReal: target, outDir: out, logger });
  const llm = createFakeProvider({ fixturePath: join(PROJECT_ROOT, "tests/fixtures/llm/oversize-inputs.json"), targetSha: map.targetSha, functionIds: ids(map) });
  const r = await runHypothesizeStage({ map, files, provider: { kind: "llm", llm, name: "fake", model: "fake", scenario: "oversize-inputs" }, outDir: out, logger, secrets: [] });
  llm.assertAllConsumed();
  return { out, lines, r };
}

test("[LLM-04] oversize and malformed output is rejected by Zod and repaired once", async (t) => {
  const { out } = await oversizeRun(t);
  const trace = readFileSync(join(out, "llm-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(trace.length, 1);
  assert.equal(trace[0].validation, "repaired");
  const issues: string[] = trace[0].issues;
  assert.ok(issues.some((i) => /^rules: /.test(i)), "30 rules exceed the cap");
  assert.ok(issues.some((i) => /^partitions\.0\.label: /.test(i)), "a 5,000-character label");
  assert.ok(issues.some((i) => /^partitions\.1\.steps\.0\.args\.0/.test(i)), "a 101-key object");
  assert.ok(issues.some((i) => /^partitions\.2\.steps\.0\.args\.0/.test(i)), "a bogus tag");
  assert.ok(trace[0].raw.length > 5000 && trace[0].repairRaw.length > 0);
});

test("[HYP-04] inputs that pass Zod but exceed arity or nesting are rejected by the planner with reasons, and none reaches the child", async (t) => {
  const { out, lines, r } = await oversizeRun(t);
  assert.deepEqual(r.hypotheses.rejected.map((x) => [x.label, x.reason]), [["three arguments for one parameter", "ARITY"], ["nested six deep", "DEPTH"]]);
  assert.deepEqual(r.planned.map((c) => c.steps.map((s) => s.args)), [[[20]], [[19]], [[21]]], "only the valid input and its expansions are planned");
  assert.deepEqual(lines.filter((l) => l.event === "input_rejected").map((l) => l.reason), ["ARITY", "DEPTH"]);
  const trace = JSON.parse(readFileSync(join(out, "llm-trace.jsonl"), "utf8").trim());
  assert.deepEqual(trace.rejected, [{ label: "three arguments for one parameter", reason: "ARITY" }, { label: "nested six deep", reason: "DEPTH" }]);
});
