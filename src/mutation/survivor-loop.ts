// The bounded survivor loop (spec 5.12, MUT-06, MUT-07, MUT-09). The LLM only proposes inputs for a surviving
// mutant; the planner validates them, the recorder runs them on the ORIGINAL staged code (twice), and only the
// surviving mutants are replayed against the new characterized cases. A "likely equivalent" answer is stored and
// never changes a status or the score.
import { join } from "node:path";
import type { RejectedInput } from "../contracts/hypotheses.ts";
import { DEFAULT_CASE_LIMITS } from "../contracts/limits.ts";
import type { FunctionInfo, StaticMap } from "../contracts/map.ts";
import type { Mutant, MutationReport } from "../contracts/mutation.ts";
import type { CaseId, PlannedCase, RecordedCase, RecordsFile, TimingsFile } from "../contracts/records.ts";
import type { JobCase } from "../harness/protocol.ts";
import { recordCases } from "../harness/run-batch.ts";
import type { StagedTarget } from "../harness/stage.ts";
import type { Logger } from "../infra/logger.ts";
import { HARNESS_DIR } from "../infra/paths.ts";
import { callLlm } from "../llm/provider.ts";
import type { TraceWriter } from "../llm/trace.ts";
import type { ProviderChoice } from "../pipeline/hypothesize.ts";
import { planCases } from "../pipeline/plan-cases.ts";
import { appendRecords } from "../pipeline/record.ts";
import { buildSurvivorInput, survivorInputsPrompt } from "../prompts/v1/survivor-inputs.ts";
import { replayMutants } from "./run-mutants.ts";
import type { MutantVerdict } from "./run-mutants.ts";
import { computeScore } from "./score.ts";

const SPAWN_TIMEOUT_MS = 10_000;

export type SurvivorLoopResult = {
  statuses: Record<string, MutantVerdict>;
  roundKilled: Record<string, number>;
  records: RecordsFile;
  rounds: MutationReport["rounds"];
  replayedCases: CaseId[];
  llmSuggestedEquivalent: Record<string, { reason: string }>;
  batches: TimingsFile["batches"];
  durations: Record<CaseId, number[]>;
  rejected: RejectedInput[];          // the planner's rejections of survivor inputs (origin survivor-round, mutantRef)
};

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function callbackIndexOf(fn: FunctionInfo, c: PlannedCase): number | null {
  if (c.style !== "callback" || fn.callbackParam === null) return null;
  const index = fn.params.indexOf(fn.callbackParam);
  return index >= 0 ? index : null;
}

export async function runSurvivorLoop(opts: {
  provider: ProviderChoice;
  maxRounds: number;
  survivorsPerRound: number;
  inputsPerSurvivor: number;
  mutants: readonly Mutant[];
  statuses: Record<string, MutantVerdict>;
  map: StaticMap;
  files: ReadonlyMap<string, string>;
  staged: StagedTarget;
  records: RecordsFile;
  durations: Record<CaseId, number[]>;
  world: { clockNow: number; seed: number };
  caseTimeoutMs: number;
  watchdogMarginMs: number;
  mutantsDir: string;
  logger: Logger;
  trace: TraceWriter;
  secrets: readonly string[];
}): Promise<SurvivorLoopResult> {
  const statuses: Record<string, MutantVerdict> = { ...opts.statuses };
  const result: SurvivorLoopResult = { statuses, roundKilled: {}, records: opts.records, rounds: [], replayedCases: [], llmSuggestedEquivalent: {}, batches: [], durations: { ...opts.durations }, rejected: [] };
  if (opts.provider.kind === "none" || opts.maxRounds <= 0) return result;
  const llm = opts.provider.llm;
  const functions = new Map(opts.map.modules.flatMap((m) => m.functions.map((f) => [f.id, f] as const)));
  const mutants = [...opts.mutants].sort(byId);
  const asked = new Set<string>();
  const replayed = new Set<CaseId>();
  const scoreNow = (): number => computeScore(mutants.map((m) => ({ operator: m.operator, status: statuses[m.id]?.status ?? "survived" }))).mutationScore;
  const isSurvivor = (m: Mutant): boolean => (statuses[m.id]?.status ?? "survived") === "survived";

  for (let round = 1; round <= opts.maxRounds; round++) {
    const survivors = mutants.filter(isSurvivor);
    const toAsk = survivors.filter((m) => !asked.has(m.id) && functions.has(m.functionId)).slice(0, opts.survivorsPerRound);
    if (toAsk.length === 0) break;
    const scoreBefore = scoreNow();
    const planned: PlannedCase[] = [];
    const rejectedCounts = new Map<string, number>();
    let inputsProposed = 0;

    for (const m of toAsk) {
      asked.add(m.id);
      const fn = functions.get(m.functionId)!;
      const text = opts.files.get(m.file) ?? "";
      const output = await callLlm(llm, survivorInputsPrompt, buildSurvivorInput(fn, text, m, round, result.records.cases), { trace: opts.trace, secrets: opts.secrets, logger: opts.logger });
      const seq = opts.trace.lastSeq();
      if (output.likelyEquivalent) result.llmSuggestedEquivalent[m.id] = { reason: output.reason };
      const inputs = output.inputs.slice(0, opts.inputsPerSurvivor);
      inputsProposed += inputs.length;
      const existing: PlannedCase[] = [...result.records.cases.filter((c) => c.functionId === fn.id), ...planned.filter((c) => c.functionId === fn.id)];
      const plan = planCases(fn, { rules: [], partitions: inputs }, DEFAULT_CASE_LIMITS, existing, { kind: "survivor", round, mutantRef: m.id });
      opts.trace.setRejected(seq, plan.rejected.map((r) => ({ label: r.label, reason: r.reason })));
      result.rejected.push(...plan.rejected);
      for (const r of plan.rejected) {
        rejectedCounts.set(r.reason, (rejectedCounts.get(r.reason) ?? 0) + 1);
        opts.logger.info("input_rejected", { functionId: r.functionId, label: r.label, reason: r.reason, mutantRef: m.id, round });
      }
      planned.push(...plan.cases);
      opts.logger.info("survivor_asked", { mutantId: m.id, round, proposed: inputs.length, accepted: plan.cases.length, likelyEquivalent: output.likelyEquivalent });
    }

    // Record the new inputs on the original staged code, module by module, twice (REC-06).
    const recorded: RecordedCase[] = [];
    const moduleOrder = opts.map.modules.map((m) => m.file);
    for (const file of moduleOrder) {
      const moduleCases = planned.filter((c) => c.moduleFile === file);
      if (moduleCases.length === 0) continue;
      const jobCases: JobCase[] = moduleCases.map((c) => ({ ...c, callbackIndex: callbackIndexOf(functions.get(c.functionId)!, c) }));
      const r = await recordCases(jobCases, {
        harnessDir: HARNESS_DIR,
        targetDir: opts.staged.dir,
        modulePath: join(opts.staged.dir, ...file.split("/")),
        moduleKind: opts.staged.moduleType,
        clockNow: opts.world.clockNow,
        seed: opts.world.seed,
        caseTimeoutMs: opts.caseTimeoutMs,
        watchdogMarginMs: opts.watchdogMarginMs,
        spawnTimeoutMs: SPAWN_TIMEOUT_MS,
      });
      result.batches.push(...r.batches);
      if (r.loadError !== null) {
        opts.logger.warn("module_skipped", { module: file, code: "CHILD_LOAD", round });
        continue;
      }
      recorded.push(...r.cases);
      Object.assign(result.durations, r.durationsMs);
    }
    result.records = appendRecords(result.records, recorded);

    // Replay only the surviving mutants of the modules that got new cases.
    const killed: string[] = [];
    const modules = new Set(recorded.map((c) => c.moduleFile));
    const targets = mutants.filter((m) => isSurvivor(m) && modules.has(m.file));
    if (targets.length > 0) {
      const replay = await replayMutants({
        mutants: targets,
        cases: recorded,
        files: opts.files,
        map: opts.map,
        staged: opts.staged,
        durations: result.durations,
        world: opts.world,
        caseTimeoutMs: opts.caseTimeoutMs,
        watchdogMarginMs: opts.watchdogMarginMs,
        mutantsDir: opts.mutantsDir,
        logger: opts.logger,
        round,
      });
      result.batches.push(...replay.batches);
      for (const id of replay.replayedCases) replayed.add(id);
      for (const [id, v] of Object.entries(replay.statuses)) {
        if (v.status !== "killed" && v.status !== "timeout") continue;
        statuses[id] = v;
        result.roundKilled[id] = round;
        killed.push(id);
      }
    }

    result.rounds.push({
      round,
      survivorsConsidered: toAsk.map((m) => m.id),
      inputsProposed,
      inputsAccepted: planned.length,
      inputsRejected: [...rejectedCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([reason, count]) => ({ reason, count })),
      newCases: recorded.map((c) => c.id).sort(),
      killed: killed.sort(),
      scoreBefore,
      scoreAfter: scoreNow(),
    });
  }
  result.replayedCases = [...replayed].sort();
  return result;
}
