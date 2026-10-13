// The mutation runner (spec 5.12, MUT-04, MUT-08): one copy of the staged target per mutant under <out>/mutants,
// a replay of the characterized cases of the mutant's module, one re-run with the full budget before a timeout is
// kept, and the copy removed again. Only the staged copy is ever copied and spliced, never the user's target.
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FunctionInfo, StaticMap } from "../contracts/map.ts";
import type { Mutant, MutantStatus } from "../contracts/mutation.ts";
import { isCharacterized } from "../contracts/outcomes.ts";
import type { CaseId, RecordedCase, TimingsFile } from "../contracts/records.ts";
import { replayCasesBudget, replayMutant } from "../harness/run-batch.ts";
import type { BatchOptions, ReplayCase, ReplayResult } from "../harness/run-batch.ts";
import type { StagedTarget } from "../harness/stage.ts";
import { LaError } from "../infra/errors.ts";
import type { Logger } from "../infra/logger.ts";
import { HARNESS_DIR } from "../infra/paths.ts";
import { applyMutant } from "./mutator.ts";

export const MUTANTS_MARKER = ".legacy-archaeologist-mutants";
const SPAWN_TIMEOUT_MS = 10_000;

export type MutantVerdict = { status: MutantStatus; killedBy: string | null };

/**
 * <out>/mutants, empty, with the marker file. A leftover directory is removed only when it holds the marker (RF-5);
 * without it the run stops with MUTANT_COPY instead of deleting a folder the tool may not own.
 */
export function prepareMutantsDir(outDir: string): string {
  const dir = join(outDir, "mutants");
  if (existsSync(dir)) {
    if (!existsSync(join(dir, MUTANTS_MARKER))) throw new LaError("MUTANT_COPY", `refusing to delete ${dir}: marker file missing`);
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MUTANTS_MARKER), "Mutant copies made by legacy-archaeologist; removed when the run ends.\n");
  } catch (err) {
    throw new LaError("MUTANT_COPY", `could not create ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return realpathSync(dir);
}

/** Removes the mutants directory, only when it holds the marker (MUT-08). */
export function removeMutantsDir(dir: string): void {
  if (existsSync(join(dir, MUTANTS_MARKER))) rmSync(dir, { recursive: true, force: true });
}

function callbackIndexOf(fn: FunctionInfo | undefined, c: RecordedCase): number | null {
  if (!fn || c.style !== "callback" || fn.callbackParam === null) return null;
  const index = fn.params.indexOf(fn.callbackParam);
  return index >= 0 ? index : null;
}

function toReplayCase(c: RecordedCase, fn: FunctionInfo | undefined): ReplayCase {
  const { steps, stateAfter, consoleLines, determinism, instability, ...planned } = c;
  void consoleLines;
  void determinism;
  void instability;
  return {
    ...planned,
    steps: steps.map((s) => ({ args: s.args })),
    callbackIndex: callbackIndexOf(fn, c),
    expected: { steps: steps.map((s) => s.outcome), stateAfter },
  };
}

/**
 * Round 0 (the default): a mutant whose function has no characterized case in `cases` is `no-coverage` without a
 * replay. Later rounds (the survivor loop) pass only the new cases: a mutant whose module has none of them keeps
 * `survived` without a replay. Otherwise the characterized cases of the mutant's module are replayed in case-ID order.
 */
export async function replayMutants(opts: {
  mutants: readonly Mutant[];
  cases: readonly RecordedCase[];
  files: ReadonlyMap<string, string>;
  map: StaticMap;
  staged: StagedTarget;
  durations: Record<CaseId, number[]>;
  world: { clockNow: number; seed: number };
  caseTimeoutMs: number;
  watchdogMarginMs: number;
  mutantsDir: string;
  logger: Logger;
  round?: number;
}): Promise<{ statuses: Record<string, MutantVerdict>; replayedCases: CaseId[]; batches: TimingsFile["batches"] }> {
  const round = opts.round ?? 0;
  const functions = new Map(opts.map.modules.flatMap((m) => m.functions.map((f) => [f.id, f] as const)));
  const characterized = opts.cases.filter((c) => isCharacterized(c)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const statuses: Record<string, MutantVerdict> = {};
  const replayed = new Set<CaseId>();
  const batches: TimingsFile["batches"] = [];

  for (const m of opts.mutants) {
    const moduleCases = characterized.filter((c) => c.moduleFile === m.file);
    if (round === 0 && !moduleCases.some((c) => c.functionId === m.functionId)) {
      statuses[m.id] = { status: "no-coverage", killedBy: null };
      opts.logger.info("mutant_result", { mutantId: m.id, round, status: "no-coverage", killedBy: null });
      continue;
    }
    if (moduleCases.length === 0) {
      statuses[m.id] = { status: "survived", killedBy: null };
      continue;
    }
    const text = opts.files.get(m.file);
    if (text === undefined) throw new LaError("MUTANT_COPY", `no source text for ${m.file}`);
    const dir = join(opts.mutantsDir, m.id);
    try {
      rmSync(dir, { recursive: true, force: true });
      cpSync(opts.staged.dir, dir, { recursive: true });
      writeFileSync(join(dir, ...m.file.split("/")), applyMutant(text, m));
    } catch (err) {
      throw new LaError("MUTANT_COPY", `could not prepare the copy for ${m.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const copy = realpathSync(dir);
      const batch: BatchOptions = {
        harnessDir: HARNESS_DIR,
        targetDir: copy,
        modulePath: join(copy, ...m.file.split("/")),
        moduleKind: opts.staged.moduleType,
        clockNow: opts.world.clockNow,
        seed: opts.world.seed,
        caseTimeoutMs: opts.caseTimeoutMs,
        watchdogMarginMs: opts.watchdogMarginMs,
        spawnTimeoutMs: SPAWN_TIMEOUT_MS,
      };
      const replayCases = moduleCases.map((c) => toReplayCase(c, functions.get(c.functionId)));
      for (const c of replayCases) replayed.add(c.id);
      const budgets = Object.fromEntries(moduleCases.map((c) => [c.id, replayCasesBudget(c.steps.length, (opts.durations[c.id] ?? []).reduce((n, d) => n + d, 0), opts.caseTimeoutMs)]));
      let result: ReplayResult = await replayMutant(replayCases, { ...batch, caseTimeoutsMs: budgets });
      batches.push({ kind: "replay", mutantId: m.id, durationMs: result.durationMs, respawns: 0 });
      if (result.status === "timeout") {
        // A slow moment is not a detection: the timeout stands only if a re-run with the full budget times out too.
        const full = Object.fromEntries(moduleCases.map((c) => [c.id, c.steps.length * opts.caseTimeoutMs]));
        result = await replayMutant(replayCases, { ...batch, caseTimeoutsMs: full });
        batches.push({ kind: "replay", mutantId: m.id, durationMs: result.durationMs, respawns: 0 });
      }
      statuses[m.id] = { status: result.status, killedBy: result.killedBy };
      opts.logger.info("mutant_result", { mutantId: m.id, round, status: result.status, killedBy: result.killedBy });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { statuses, replayedCases: [...replayed].sort(), batches };
}
