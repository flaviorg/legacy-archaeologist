// Record stage: runs the planned cases module by module in the isolated child and writes records.json and
// timings.json (spec 5.1, 5.4).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CASE_LIMITS } from "../contracts/limits.ts";
import type { FunctionInfo, StaticMap } from "../contracts/map.ts";
import type { CaseId, LoadError, PlannedCase, RecordedCase, RecordsFile, TimingsFile } from "../contracts/records.ts";
import { writeJsonText } from "../contracts/stable-json.ts";
import type { JobCase } from "../harness/protocol.ts";
import { recordCases } from "../harness/run-batch.ts";
import type { BatchOptions } from "../harness/run-batch.ts";
import type { StagedTarget } from "../harness/stage.ts";
import { LaError } from "../infra/errors.ts";
import type { Logger } from "../infra/logger.ts";
import { HARNESS_DIR } from "../infra/paths.ts";
import { TOOL_INFO } from "../infra/version.ts";

const SPAWN_TIMEOUT_MS = 10_000;
const MAX_LOAD_ERROR = 500;

function caseNumber(id: CaseId): number {
  const m = /#c(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// Cases ordered by function (the order given), then case number, then ID.
function sortCases(cases: RecordedCase[], functionOrder: readonly string[]): RecordedCase[] {
  const rank = new Map(functionOrder.map((id, i) => [id, i]));
  const rankOf = (c: RecordedCase): number => rank.get(c.functionId) ?? Number.MAX_SAFE_INTEGER;
  return [...cases].sort((a, b) => rankOf(a) - rankOf(b) || caseNumber(a.id) - caseNumber(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function callbackIndexOf(fn: FunctionInfo | undefined, c: PlannedCase): number | null {
  if (!fn || c.style !== "callback" || fn.callbackParam === null) return null;
  const index = fn.params.indexOf(fn.callbackParam);
  return index >= 0 ? index : null;
}

/** Adds cases (the survivor loop's) to a records file, keeping its function order, then case number. */
export function appendRecords(file: RecordsFile, added: RecordedCase[]): RecordsFile {
  const order: string[] = [];
  for (const c of [...file.cases, ...added]) if (!order.includes(c.functionId)) order.push(c.functionId);
  return { ...file, cases: sortCases([...file.cases, ...added], order) };
}

export async function runRecordStage(opts: {
  map: StaticMap;
  staged: StagedTarget;
  planned: PlannedCase[];
  world: { clockNow: number; seed: number };
  caseTimeoutMs: number;
  watchdogMarginMs: number;
  outDir: string;
  logger: Logger;
}): Promise<{ records: RecordsFile; durations: Record<CaseId, number[]>; timings: TimingsFile }> {
  const started = performance.now();
  opts.logger.info("stage_start", { stage: "record", cases: opts.planned.length });
  const functions = new Map(opts.map.modules.flatMap((m) => m.functions.map((f) => [f.id, f] as const)));
  const moduleOrder = [...opts.map.modules.map((m) => m.file)];
  for (const c of opts.planned) if (!moduleOrder.includes(c.moduleFile)) moduleOrder.push(c.moduleFile);

  const loadErrors: LoadError[] = [];
  const cases: RecordedCase[] = [];
  const durations: Record<CaseId, number[]> = {};
  const batches: TimingsFile["batches"] = [];
  let attempted = 0;
  let recordedModules = 0;

  for (const file of moduleOrder) {
    const moduleCases = opts.planned.filter((c) => c.moduleFile === file);
    if (moduleCases.length === 0) continue;
    attempted += 1;
    const info = opts.map.modules.find((m) => m.file === file);
    if (info && info.externalSpecifiers.length > 0) {
      const error = `requires ${info.externalSpecifiers.join(", ")}; modules with npm or out-of-folder dependencies are not loaded in v1`;
      loadErrors.push({ module: file, code: "EXTERNAL_DEPENDENCY", error });
      opts.logger.warn("module_skipped", { module: file, code: "EXTERNAL_DEPENDENCY" });
      continue;
    }
    const jobCases: JobCase[] = moduleCases.map((c) => ({ ...c, callbackIndex: callbackIndexOf(functions.get(c.functionId), c) }));
    const batch: BatchOptions = {
      harnessDir: HARNESS_DIR,
      targetDir: opts.staged.dir,
      modulePath: join(opts.staged.dir, ...file.split("/")),
      moduleKind: opts.staged.moduleType,
      clockNow: opts.world.clockNow,
      seed: opts.world.seed,
      caseTimeoutMs: opts.caseTimeoutMs,
      watchdogMarginMs: opts.watchdogMarginMs,
      spawnTimeoutMs: SPAWN_TIMEOUT_MS,
    };
    const result = await recordCases(jobCases, batch);
    batches.push(...result.batches);
    if (result.loadError !== null) {
      loadErrors.push({ module: file, code: "CHILD_LOAD", error: result.loadError.slice(0, MAX_LOAD_ERROR) });
      opts.logger.warn("module_skipped", { module: file, code: "CHILD_LOAD" });
      continue;
    }
    recordedModules += 1;
    cases.push(...result.cases);
    Object.assign(durations, result.durationsMs);
  }

  if (attempted > 0 && recordedModules === 0) {
    const code = loadErrors.every((e) => e.code === "EXTERNAL_DEPENDENCY") ? "EXTERNAL_DEPENDENCY" : "CHILD_LOAD";
    throw new LaError(code, `no module could be recorded: ${loadErrors.map((e) => `${e.module} (${e.code}: ${e.error})`).join("; ")}`);
  }

  const functionOrder = [...opts.map.modules.flatMap((m) => m.functions.map((f) => f.id))];
  for (const c of cases) if (!functionOrder.includes(c.functionId)) functionOrder.push(c.functionId);
  const sorted = sortCases(cases, functionOrder);
  for (const c of sorted) {
    if (c.determinism === "unstable") opts.logger.warn("case_unstable", { caseId: c.id, step: c.instability?.step ?? null });
  }

  const records: RecordsFile = {
    schemaVersion: 1,
    tool: TOOL_INFO,
    targetSha: opts.map.targetSha,
    world: { clockNow: opts.world.clockNow, seed: opts.world.seed, tz: "UTC" },
    limits: DEFAULT_CASE_LIMITS,
    cases: sorted,
    loadErrors,
  };
  const timings: TimingsFile = {
    schemaVersion: 1,
    tool: TOOL_INFO,
    targetSha: opts.map.targetSha,
    cases: Object.fromEntries(sorted.map((c) => [c.id, { stepDurationsMs: durations[c.id] ?? [] }])),
    batches,
  };
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "records.json"), writeJsonText(records));
  writeFileSync(join(opts.outDir, "timings.json"), writeJsonText(timings));
  opts.logger.info("stage_done", {
    stage: "record",
    durationMs: Math.round(performance.now() - started),
    cases: sorted.length,
    unstable: sorted.filter((c) => c.determinism === "unstable").length,
    loadErrors: loadErrors.length,
  });
  return { records, durations, timings };
}
