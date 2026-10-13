// Mutate stage (spec 5.5, 5.12): mutants of the parsed JS files, round 0 against every characterized case, the
// bounded survivor loop, the score, mutation.json and the replay batches in timings.json. Runs before generate, so
// the emitted tests and the score cover the same cases (DEMO-06).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RejectedInput } from "../contracts/hypotheses.ts";
import type { StaticMap } from "../contracts/map.ts";
import type { MutantEntry, MutationReport, OperatorId } from "../contracts/mutation.ts";
import type { CaseId, RecordsFile, TimingsFile } from "../contracts/records.ts";
import { writeJsonText } from "../contracts/stable-json.ts";
import type { StagedTarget } from "../harness/stage.ts";
import type { Logger } from "../infra/logger.ts";
import { TOOL_INFO } from "../infra/version.ts";
import type { TraceWriter } from "../llm/trace.ts";
import { listMutants } from "../mutation/mutator.ts";
import { prepareMutantsDir, removeMutantsDir, replayMutants } from "../mutation/run-mutants.ts";
import { computeScore } from "../mutation/score.ts";
import { runSurvivorLoop } from "../mutation/survivor-loop.ts";
import { parseSource } from "../static/parser.ts";
import type { ProviderChoice } from "./hypothesize.ts";

export async function runMutateStage(opts: {
  map: StaticMap;
  files: { path: string; text: string }[];
  staged: StagedTarget;
  records: RecordsFile;
  timings: TimingsFile;
  durations: Record<CaseId, number[]>;
  provider: ProviderChoice;
  operators: readonly OperatorId[];
  maxMutants: number;
  maxRounds: number;
  survivorsPerRound: number;
  inputsPerSurvivor: number;
  world: { clockNow: number; seed: number };
  caseTimeoutMs: number;
  watchdogMarginMs: number;
  outDir: string;
  logger: Logger;
  trace: TraceWriter;
  secrets: readonly string[];
}): Promise<{ mutation: MutationReport; records: RecordsFile; timings: TimingsFile; survivorRejected: RejectedInput[] }> {
  const started = performance.now();
  const parsed = opts.files.map((f) => parseSource(f.path, f.text));
  const functions = opts.map.modules.flatMap((m) => m.functions);
  const { mutants, invalid, truncated } = listMutants(parsed, functions, opts.operators, opts.maxMutants);
  opts.logger.info("stage_start", { stage: "mutate", mutants: mutants.length, invalid, truncated });
  const files = new Map(opts.files.map((f) => [f.path, f.text] as const));
  const mutantsDir = prepareMutantsDir(opts.outDir);
  let records = opts.records;
  let timings = opts.timings;
  try {
    const round0 = await replayMutants({
      mutants,
      cases: records.cases,
      files,
      map: opts.map,
      staged: opts.staged,
      durations: opts.durations,
      world: opts.world,
      caseTimeoutMs: opts.caseTimeoutMs,
      watchdogMarginMs: opts.watchdogMarginMs,
      mutantsDir,
      logger: opts.logger,
    });
    const roundKilled: Record<string, number> = {};
    for (const [id, v] of Object.entries(round0.statuses)) if (v.status === "killed" || v.status === "timeout") roundKilled[id] = 0;

    let loop;
    try {
      loop = await runSurvivorLoop({
        provider: opts.provider,
        maxRounds: opts.maxRounds,
        survivorsPerRound: opts.survivorsPerRound,
        inputsPerSurvivor: opts.inputsPerSurvivor,
        mutants,
        statuses: round0.statuses,
        map: opts.map,
        files,
        staged: opts.staged,
        records,
        durations: opts.durations,
        world: opts.world,
        caseTimeoutMs: opts.caseTimeoutMs,
        watchdogMarginMs: opts.watchdogMarginMs,
        mutantsDir,
        logger: opts.logger,
        trace: opts.trace,
        secrets: opts.secrets,
      });
    } finally {
      // The survivor calls are in the trace even when one of them fails (LLM-04 keeps both raw texts).
      writeFileSync(join(opts.outDir, "llm-trace.jsonl"), opts.trace.text());
    }
    const statuses = loop.statuses;
    Object.assign(roundKilled, loop.roundKilled);
    const replayed = new Set([...round0.replayedCases, ...loop.replayedCases]);
    const batches = [...round0.batches, ...loop.batches];
    records = loop.records;

    const entries: MutantEntry[] = mutants.map((m) => ({
      id: m.id,
      functionId: m.functionId,
      file: m.file,
      line: m.line,
      column: m.column,
      operator: m.operator,
      original: m.original,
      replacement: m.replacement,
      status: statuses[m.id]?.status ?? "survived",
      killedBy: statuses[m.id]?.killedBy ?? null,
      roundKilled: roundKilled[m.id] ?? null,
      llmSuggestedEquivalent: loop.llmSuggestedEquivalent[m.id] ?? null,
    }));
    const mutation: MutationReport = {
      schemaVersion: 1,
      tool: TOOL_INFO,
      targetSha: opts.map.targetSha,
      operators: [...opts.operators],
      truncated,
      invalid,
      replayedCases: [...replayed].sort(),
      mutants: entries,
      rounds: loop.rounds,
      score: computeScore(entries),
    };
    timings = {
      ...timings,
      cases: Object.fromEntries(records.cases.map((c) => [c.id, { stepDurationsMs: loop.durations[c.id] ?? [] }])),
      batches: [...timings.batches, ...batches],
    };
    if (records !== opts.records) writeFileSync(join(opts.outDir, "records.json"), writeJsonText(records));
    writeFileSync(join(opts.outDir, "mutation.json"), writeJsonText(mutation));
    writeFileSync(join(opts.outDir, "timings.json"), writeJsonText(timings));
    opts.logger.info("stage_done", {
      stage: "mutate",
      durationMs: Math.round(performance.now() - started),
      mutants: mutants.length,
      mutationScore: mutation.score.mutationScore,
      detected: mutation.score.detected,
      valid: mutation.score.valid,
    });
    return { mutation, records, timings, survivorRejected: loop.rejected };
  } finally {
    removeMutantsDir(mutantsDir);
  }
}
