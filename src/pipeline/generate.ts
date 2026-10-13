// Generate stage (spec 5.5, 5.11): the characterization tests, support.mts, report.json and SPEC.md. It is the last
// writer of all four, so the emitted file and the mutation score cover the same cases (DEMO-06).
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { HypothesesFile } from "../contracts/hypotheses.ts";
import type { StaticMap } from "../contracts/map.ts";
import type { MutationReport } from "../contracts/mutation.ts";
import type { CaseId, RecordsFile } from "../contracts/records.ts";
import type { ReportFile } from "../contracts/report.ts";
import { writeJsonText } from "../contracts/stable-json.ts";
import { emitTests } from "../generate/emit-tests.ts";
import { supportFile } from "../generate/support-template.ts";
import { listNotCharacterized, writeSpec } from "../generate/write-spec.ts";
import type { Logger } from "../infra/logger.ts";
import { TOOL_INFO } from "../infra/version.ts";
import { evaluateRules } from "./evaluate-rules.ts";

export const TEST_FILE_SUFFIX = ".characterization.test.mts";
const SUPPORT_FILE = "support.mts";

const toPosix = (p: string): string => p.split(sep).join("/");

// The files a previous generate wrote into the tests directory (RF-5); nothing else there is touched.
function removeStale(testsDir: string): void {
  if (!existsSync(testsDir)) return;
  for (const name of readdirSync(testsDir)) {
    if (name.endsWith(TEST_FILE_SUFFIX) || name === SUPPORT_FILE) rmSync(join(testsDir, name), { force: true });
  }
}

// `<module base>.characterization.test.mts`; a second module with the same base name gets its path in the name.
function testFileNames(files: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const file of files) {
    const noExt = file.replace(/\.[^./]*$/, "");
    const base = noExt.split("/").at(-1) ?? noExt;
    let name = base + TEST_FILE_SUFFIX;
    if (used.has(name)) name = noExt.split("/").join("__") + TEST_FILE_SUFFIX;
    used.add(name);
    names.set(file, name);
  }
  return names;
}

export function runGenerateStage(opts: {
  map: StaticMap;
  targetReal: string;
  hypotheses: HypothesesFile;
  records: RecordsFile;
  mutation: MutationReport | null;
  outDir: string;
  testsDir: string;
  world: { clockNow: number; seed: number };
  caseTimeoutMs: number;
  logger: Logger;
}): { report: ReportFile; testFiles: string[]; specPath: string } {
  const started = performance.now();
  opts.logger.info("stage_start", { stage: "generate", cases: opts.records.cases.length });
  removeStale(opts.testsDir);

  const testFiles: string[] = [];
  const testLinks: Record<CaseId, { file: string; line: number }> = {};
  const tests: ReportFile["tests"] = [];
  const names = testFileNames(opts.map.modules.map((m) => m.file));
  for (const mod of opts.map.modules) {
    const moduleNoExt = join(opts.targetReal, ...mod.file.replace(/\.[^./]*$/, "").split("/"));
    const { testFile, testLines } = emitTests({
      module: mod,
      cases: opts.records.cases.filter((c) => c.moduleFile === mod.file),
      moduleRelNoExt: toPosix(relative(opts.testsDir, moduleNoExt)),
      targetDir: opts.map.targetDir,
      clockNow: opts.world.clockNow,
      seed: opts.world.seed,
      caseTimeoutMs: opts.caseTimeoutMs,
      version: TOOL_INFO.version,
      targetSha: opts.map.targetSha,
    });
    const caseIds = Object.keys(testLines);
    if (caseIds.length === 0) continue;
    const path = join(opts.testsDir, names.get(mod.file) as string);
    mkdirSync(opts.testsDir, { recursive: true });
    writeFileSync(path, testFile);
    testFiles.push(path);
    const fromOut = toPosix(relative(opts.outDir, path));
    for (const id of caseIds) testLinks[id] = { file: fromOut, line: testLines[id] as number };
    tests.push({ module: mod.file, file: fromOut, count: caseIds.length });
  }
  if (testFiles.length > 0) writeFileSync(join(opts.testsDir, SUPPORT_FILE), supportFile());

  const { rules, suspicious } = evaluateRules(opts.hypotheses.functions, opts.records.cases);
  const report: ReportFile = {
    schemaVersion: 1,
    tool: TOOL_INFO,
    targetSha: opts.map.targetSha,
    provider: opts.hypotheses.provider,
    model: opts.hypotheses.model,
    ...(opts.hypotheses.scenario !== undefined ? { scenario: opts.hypotheses.scenario } : {}),
    rules,
    suspicious,
    notCharacterized: listNotCharacterized(opts.records.cases),
    loadErrors: opts.records.loadErrors,
    tests,
    mutation: opts.mutation ? { mutationScore: opts.mutation.score.mutationScore, detected: opts.mutation.score.detected, valid: opts.mutation.score.valid } : null,
  };
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "report.json"), writeJsonText(report));
  const specPath = join(opts.outDir, "SPEC.md");
  writeFileSync(specPath, writeSpec({ map: opts.map, hypotheses: opts.hypotheses, records: opts.records, report, mutation: opts.mutation, testLinks, world: opts.world }));
  opts.logger.info("stage_done", {
    stage: "generate",
    durationMs: Math.round(performance.now() - started),
    testFiles: testFiles.length,
    tests: tests.reduce((n, t) => n + t.count, 0),
    rules: rules.length,
    suspicious: suspicious.length,
    notCharacterized: report.notCharacterized.length,
  });
  return { report, testFiles, specPath };
}
