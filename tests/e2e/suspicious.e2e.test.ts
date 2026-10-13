import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HypothesesFile, HypothesisOutput } from "../../src/contracts/hypotheses.ts";
import { DEFAULT_CASE_LIMITS } from "../../src/contracts/limits.ts";
import type { ReportFile } from "../../src/contracts/report.ts";
import { stageTarget } from "../../src/harness/stage.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { TOOL_INFO } from "../../src/infra/version.ts";
import { runGenerateStage } from "../../src/pipeline/generate.ts";
import { runMapStage } from "../../src/pipeline/map.ts";
import { planCases } from "../../src/pipeline/plan-cases.ts";
import { runRecordStage } from "../../src/pipeline/record.ts";
import { runNode } from "../helpers/run-cli.ts";
import { tmpDir, tmpTarget } from "../helpers/tmp-target.ts";

test("[SUS-01] a hand-written hypothesis that disagrees with the code becomes SB-01 with predicted, observed, source and the pinning test", async (t) => {
  const logger = createLogger({ level: "error", write: () => {} });
  const targetReal = tmpTarget(t, "discount");
  const outDir = join(tmpDir(t), "out");
  const { map } = runMapStage({ targetReal, outDir, logger });
  const fn = map.modules[0]!.functions[0]!;
  assert.equal(fn.id, "index.js#discount");
  const output: HypothesisOutput = {
    rules: [{ key: "over-fifty", statement: "Totals of 50 or more get 10% off.", relatedConstants: [50], probes: [{ label: "exactly fifty", steps: [{ args: [50] }], prediction: { kind: "returns", value: 45 } }, { label: "eighty", steps: [{ args: [80] }], prediction: { kind: "returns", value: 72 } }] }],
    partitions: [{ label: "small total", steps: [{ args: [10] }] }],
  };
  const { cases: planned, rejected } = planCases(fn, output, DEFAULT_CASE_LIMITS, []);
  assert.deepEqual(rejected, []);
  const hypotheses: HypothesesFile = { schemaVersion: 1, tool: TOOL_INFO, targetSha: map.targetSha, provider: "fake", model: "fake", scenario: "hand-written", functions: [{ functionId: fn.id, output, usage: { promptTokens: 0, completionTokens: 0 } }], rejected: [] };
  const staged = stageTarget({ targetReal, outDir });
  const { records } = await runRecordStage({ map, staged, planned, world: { clockNow: 1700000000000, seed: 42 }, caseTimeoutMs: 2000, watchdogMarginMs: 1000, outDir, logger });
  const { report, specPath, testFiles } = runGenerateStage({ map, targetReal, hypotheses, records, mutation: null, outDir, testsDir: join(outDir, "tests"), world: { clockNow: 1700000000000, seed: 42 }, caseTimeoutMs: 2000, logger });

  assert.equal(report.suspicious.length, 1);
  assert.equal(report.rules[0]!.status, "contradicted");
  const sb = report.suspicious[0]!;
  assert.deepEqual([sb.id, sb.functionId, sb.ruleId, sb.observed], ["SB-01", "index.js#discount", "BR-01", { kind: "returned", value: 50 }]);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, "report.json"), "utf8")) as ReportFile, report);

  const spec = readFileSync(specPath, "utf8");
  const testFile = readFileSync(testFiles[0]!, "utf8");
  const line = testFile.split("\n").findIndex((l) => l.startsWith(`test("[${sb.caseId}]`)) + 1;
  assert.ok(line > 0);
  for (const text of [
    "### SB-01 · index.js#discount · BR-01",
    "- Hypothesis (LLM): Totals of 50 or more get 10% off.",
    "- Predicted for `discount(50)`: returns 45.",
    "- Observed (recorded, run twice, stable): returned 50.",
    "- Source: index.js:",
    `- Test that pins the observed behavior: [${sb.caseId}](tests/index.characterization.test.mts#L${line}).`,
    "**contradicted** → SB-01",
  ]) assert.ok(spec.includes(text), text);
  assert.ok(!testFile.includes("Totals of 50"), "the statement never reaches the test file");

  const r = await runNode(["--test", "--test-reporter=tap", testFiles[0]!]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
});
