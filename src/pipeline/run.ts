// `run` (spec 5.5): map → hypothesize → record → mutate → generate.
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HypothesesFile } from "../contracts/hypotheses.ts";
import type { StaticMap } from "../contracts/map.ts";
import { OPERATOR_IDS } from "../contracts/mutation.ts";
import type { MutationReport, OperatorId } from "../contracts/mutation.ts";
import type { RecordsFile } from "../contracts/records.ts";
import type { ReportFile } from "../contracts/report.ts";
import { writeJsonText } from "../contracts/stable-json.ts";
import { stageTarget } from "../harness/stage.ts";
import type { Config } from "../infra/config.ts";
import { LaError } from "../infra/errors.ts";
import type { Logger } from "../infra/logger.ts";
import { PROJECT_ROOT, isInsideOrEqual, resolveOutDir, resolveTarget } from "../infra/paths.ts";
import { createFakeProvider } from "../llm/fake-provider.ts";
import type { FakeProvider } from "../llm/fake-provider.ts";
import { createOpenAiCompatibleProvider } from "../llm/openai-compatible.ts";
import { runGenerateStage } from "./generate.ts";
import { runHypothesizeStage } from "./hypothesize.ts";
import type { ProviderChoice } from "./hypothesize.ts";
import { runMapStage } from "./map.ts";
import { runMutateStage } from "./mutate.ts";
import { runRecordStage } from "./record.ts";

export const OPERATOR_NAMES: readonly OperatorId[] = OPERATOR_IDS;

export type RunOptions = {
  target: string;
  cwd: string;
  out?: string;
  only?: string[];
  provider: "none" | "fake" | "openai-compatible";
  scenario?: string;
  seed: number;
  clockNow: number;
  caseTimeoutMs: number;
  watchdogMarginMs: number;
  maxMutants: number;
  maxRounds: number;
  survivorsPerRound: number;
  inputsPerSurvivor: number;
  operators: readonly OperatorId[];
  testsDir?: string;
  strictFixture: boolean;
  config: Config;
  logger: Logger;
  onProgress?: (line: string) => void;
};

export type RunResult = {
  outDir: string;
  map: StaticMap;
  hypotheses: HypothesesFile;
  records: RecordsFile;
  mutation: MutationReport;
  report: ReportFile;
  testFiles: string[];
};

// The artifacts this milestone writes; removed before a run so a failed re-run never leaves a stale one behind.
// Stale test files are removed by the generate stage itself (RF-5).
const RUN_ARTIFACTS = ["map.json", "hypotheses.json", "llm-trace.jsonl", "records.json", "timings.json", "mutation.json", "report.json", "SPEC.md"] as const;
const SCENARIO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** fixtures/llm/<scenario>.json, then tests/fixtures/llm/<scenario>.json; null when neither exists. */
export function resolveScenarioPath(scenario: string): string | null {
  if (!SCENARIO_NAME.test(scenario)) return null;
  for (const dir of ["fixtures/llm", "tests/fixtures/llm"]) {
    const path = join(PROJECT_ROOT, ...dir.split("/"), `${scenario}.json`);
    if (existsSync(path)) return path;
  }
  return null;
}

export function defaultScenario(targetReal: string): string {
  return basename(targetReal);
}

/** The real target and --out, refusing a target that is a file and any overlap between the two (SUS-03). */
export function resolveRunPaths(target: string, out: string | undefined, cwd: string): { targetReal: string; outDir: string } {
  const targetReal = resolveTarget(target, cwd);
  if (!statSync(targetReal).isDirectory()) {
    throw new LaError("USAGE", `--target must be a directory; pass the folder that contains ${basename(targetReal)} and use --only to pick functions`);
  }
  const outDir = resolveOutDir(out ?? join("artifacts", basename(targetReal)), cwd);
  if (isInsideOrEqual(outDir, targetReal) || isInsideOrEqual(targetReal, outDir)) {
    throw new LaError("USAGE", "--out must not be inside, equal to or contain the target");
  }
  return { targetReal, outDir };
}

/** --tests-dir (default <out>/tests), refused like --out when it overlaps the target (SUS-03). */
function resolveTestsDir(testsDir: string | undefined, outDir: string, targetReal: string, cwd: string): string {
  const dir = testsDir === undefined ? join(outDir, "tests") : resolveOutDir(testsDir, cwd);
  if (isInsideOrEqual(dir, targetReal) || isInsideOrEqual(targetReal, dir)) {
    throw new LaError("USAGE", "--tests-dir must not be inside, equal to or contain the target");
  }
  return dir;
}

export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  const progress = (line: string): void => opts.onProgress?.(line);
  const { targetReal, outDir } = resolveRunPaths(opts.target, opts.out, opts.cwd);
  const testsDir = resolveTestsDir(opts.testsDir, outDir, targetReal, opts.cwd);
  for (const name of RUN_ARTIFACTS) rmSync(join(outDir, name), { force: true });
  const secrets = [opts.config.apiKey].filter((s) => s !== "");

  const { map, files, allFunctionIds } = runMapStage({ targetReal, outDir, ...(opts.only && opts.only.length > 0 ? { only: opts.only } : {}), logger: opts.logger });
  const functionCount = map.modules.reduce((n, m) => n + m.functions.length, 0);
  progress(`static map done · ${functionCount.toLocaleString("en-US")} functions`);
  const staged = stageTarget({ targetReal, outDir });

  let fake: FakeProvider | null = null;
  let choice: ProviderChoice;
  if (opts.provider === "fake") {
    const scenario = opts.scenario ?? defaultScenario(targetReal);
    const fixturePath = resolveScenarioPath(scenario);
    if (fixturePath === null) throw new LaError("FIXTURE_NOT_FOUND", `no fixture for scenario ${scenario} (looked for fixtures/llm/${scenario}.json and tests/fixtures/llm/${scenario}.json)`);
    fake = createFakeProvider({ fixturePath, targetSha: map.targetSha, functionIds: allFunctionIds });
    choice = { kind: "llm", llm: fake, name: "fake", model: "fake", scenario };
  } else if (opts.provider === "openai-compatible") {
    if (opts.config.apiKey === "") throw new LaError("LLM_AUTH", "LLM_API_KEY is required for the openai-compatible provider");
    const llm = createOpenAiCompatibleProvider({ baseUrl: opts.config.baseUrl, apiKey: opts.config.apiKey, model: opts.config.model, timeoutMs: opts.config.timeoutMs });
    choice = { kind: "llm", llm, name: "openai-compatible", model: opts.config.model };
  } else {
    choice = { kind: "none" };
  }

  const hypothesized = await runHypothesizeStage({ map, files, provider: choice, outDir, logger: opts.logger, secrets });
  const { planned, trace } = hypothesized;
  let hypotheses = hypothesized.hypotheses;
  progress(`inputs done · ${planned.length.toLocaleString("en-US")} accepted · ${hypotheses.rejected.length.toLocaleString("en-US")} rejected`);

  const recorded = await runRecordStage({
    map,
    staged,
    planned,
    world: { clockNow: opts.clockNow, seed: opts.seed },
    caseTimeoutMs: opts.caseTimeoutMs,
    watchdogMarginMs: opts.watchdogMarginMs,
    outDir,
    logger: opts.logger,
  });
  progress(`recording done · ${recorded.records.cases.length.toLocaleString("en-US")} cases`);

  const { mutation, records, survivorRejected } = await runMutateStage({
    map,
    files,
    staged,
    records: recorded.records,
    timings: recorded.timings,
    durations: recorded.durations,
    provider: choice,
    operators: opts.operators,
    maxMutants: opts.maxMutants,
    maxRounds: opts.maxRounds,
    survivorsPerRound: opts.survivorsPerRound,
    inputsPerSurvivor: opts.inputsPerSurvivor,
    world: { clockNow: opts.clockNow, seed: opts.seed },
    caseTimeoutMs: opts.caseTimeoutMs,
    watchdogMarginMs: opts.watchdogMarginMs,
    outDir,
    logger: opts.logger,
    trace,
    secrets,
  });
  progress(`mutation done · ${mutation.score.mutationScore.toFixed(1)}% (${mutation.score.detected.toLocaleString("en-US")}/${mutation.score.valid.toLocaleString("en-US")})`);

  if (survivorRejected.length > 0) {
    // Survivor inputs the planner refused are recorded with their reason and mutantRef, like round-0 ones (HYP-04).
    hypotheses = { ...hypotheses, rejected: [...hypotheses.rejected, ...survivorRejected] };
    writeFileSync(join(outDir, "hypotheses.json"), writeJsonText(hypotheses));
  }

  if (opts.strictFixture && fake) fake.assertAllConsumed();

  const { report, testFiles } = runGenerateStage({
    map,
    targetReal,
    hypotheses,
    records,
    mutation,
    outDir,
    testsDir,
    world: { clockNow: opts.clockNow, seed: opts.seed },
    caseTimeoutMs: opts.caseTimeoutMs,
    logger: opts.logger,
  });
  const emitted = report.tests.reduce((n, t) => n + t.count, 0);
  progress(`tests done · ${emitted.toLocaleString("en-US")} tests · ${report.suspicious.length.toLocaleString("en-US")} suspicious`);
  return { outDir, map, hypotheses, records, mutation, report, testFiles };
}
