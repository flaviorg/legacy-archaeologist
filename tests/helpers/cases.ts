// Helpers for the harness and pipeline tests: a staged copy of a tiny target, job cases, batch options, an in-process
// pipeline run and the blocks of an emitted test file.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Tagged } from "../../src/contracts/tagged.ts";
import type { JobCase } from "../../src/harness/protocol.ts";
import type { BatchOptions } from "../../src/harness/run-batch.ts";
import { stageTarget } from "../../src/harness/stage.ts";
import type { StagedTarget } from "../../src/harness/stage.ts";
import { loadConfig } from "../../src/infra/config.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { HARNESS_DIR } from "../../src/infra/paths.ts";
import { OPERATOR_NAMES, runPipeline } from "../../src/pipeline/run.ts";
import type { RunResult } from "../../src/pipeline/run.ts";
import { tmpDir, tmpTarget } from "./tmp-target.ts";

// Copies tests/fixtures/targets/<name> to a temporary directory and stages it into another one.
export function stageTmp(t: TestContext, name: string, opts: { parentName?: string } = {}): StagedTarget {
  const target = tmpTarget(t, name, opts);
  const out = join(tmpDir(t), opts.parentName ?? "");
  return stageTarget({ targetReal: target, outDir: out });
}

export function jobCase(suffix: string, exportName: string, steps: Tagged[][], opts: { style?: "sync" | "callback"; callbackIndex?: number | null; moduleFile?: string } = {}): JobCase {
  const moduleFile = opts.moduleFile ?? "index.js";
  const functionId = `${moduleFile}#${exportName}`;
  return {
    id: `${functionId}#${suffix}`,
    functionId,
    moduleFile,
    exportName,
    style: opts.style ?? "sync",
    origin: "partition",
    ruleRefs: [],
    round: 0,
    label: "test",
    steps: steps.map((args) => ({ args })),
    callbackIndex: opts.callbackIndex ?? null,
  };
}

export function batchOpts(staged: StagedTarget, file: string, overrides: Partial<BatchOptions> = {}): BatchOptions {
  return {
    harnessDir: HARNESS_DIR,
    targetDir: staged.dir,
    modulePath: join(staged.dir, file),
    moduleKind: staged.moduleType,
    clockNow: 1700000000000,
    seed: 42,
    caseTimeoutMs: 300,
    watchdogMarginMs: 200,
    spawnTimeoutMs: 10_000,
    ...overrides,
  };
}

export type PipelineOpts = { provider?: "none" | "fake"; scenario?: string; outParent?: string; testsDir?: string; caseTimeoutMs?: number; maxRounds?: number; survivorsPerRound?: number; strictFixture?: boolean };

// Runs map → hypothesize → record → mutate → generate in-process on a temporary copy of tests/fixtures/targets/<name>.
export async function pipelineOn(t: TestContext, name: string, opts: PipelineOpts = {}): Promise<{ target: string; out: string; result: RunResult }> {
  const target = tmpTarget(t, name);
  const parent = join(tmpDir(t), opts.outParent ?? "");
  mkdirSync(parent, { recursive: true });
  const out = join(parent, "out");
  const result = await runPipeline({
    target,
    cwd: parent,
    out,
    provider: opts.provider ?? "none",
    ...(opts.scenario !== undefined ? { scenario: opts.scenario } : {}),
    seed: 42,
    clockNow: 1700000000000,
    caseTimeoutMs: opts.caseTimeoutMs ?? 2000,
    watchdogMarginMs: 1000,
    maxMutants: 200,
    maxRounds: opts.maxRounds ?? 1,
    survivorsPerRound: opts.survivorsPerRound ?? 10,
    inputsPerSurvivor: 5,
    operators: OPERATOR_NAMES,
    ...(opts.testsDir !== undefined ? { testsDir: opts.testsDir } : {}),
    strictFixture: opts.strictFixture ?? false,
    config: loadConfig({}),
    logger: createLogger({ level: "error", write: () => {} }),
  });
  return { target, out, result };
}

// The tests of an emitted file: each block runs from `test(` to the line before the next one (or the end).
export function testBlocks(text: string): { name: string; body: string }[] {
  const parts = text.split("\ntest(");
  return parts.slice(1).map((part) => {
    const body = "test(" + part.replace(/\n+$/, "");
    const m = /^test\((".*?"), async/.exec(body);
    return { name: m ? (JSON.parse(m[1] as string) as string) : "", body };
  });
}

// The same file with its tests in reverse order (the header is kept first).
export function reverseTests(text: string): string {
  const header = text.split("\ntest(")[0] as string;
  return header.replace(/\n+$/, "") + "\n\n" + testBlocks(text).reverse().map((b) => b.body).join("\n\n") + "\n";
}
