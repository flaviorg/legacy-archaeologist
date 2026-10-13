// Runs planned cases in the isolated recorder child (spec 5.4).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { outcomesEqual, taggedEqual } from "../contracts/outcomes.ts";
import type { Outcome } from "../contracts/outcomes.ts";
import type { CaseId, Instability, RecordedCase, TimingsFile } from "../contracts/records.ts";
import { CHILD_CAPS } from "../contracts/limits.ts";
import { DEFAULT_TAGGED_LIMITS } from "../contracts/tagged.ts";
import type { Tagged } from "../contracts/tagged.ts";
import { LaError } from "../infra/errors.ts";
import { CONTRACTS_DIR } from "../infra/paths.ts";
import { redactSecrets } from "../infra/redact.ts";
import { parseChildLine } from "./protocol.ts";
import type { ChildJob, JobCase } from "./protocol.ts";

export type BatchOptions = {
  harnessDir: string;
  targetDir: string;
  modulePath: string;
  moduleKind: "commonjs" | "module";
  clockNow: number;
  seed: number;
  caseTimeoutMs: number;
  watchdogMarginMs: number;
  spawnTimeoutMs: number;
  replayTimeoutsMs?: Record<CaseId, number>;
};

export type BatchCaseResult = { caseId: CaseId; steps: { args: Tagged[]; outcome: Outcome }[]; stateAfter: Tagged | null; consoleLines: number; durationsMs: number[] };

export type BatchResult = { cases: BatchCaseResult[]; loadError: string | null; strayStdoutBytes: number; strayStderrBytes: number; forgedLines: number; respawns: number };

type TimeoutReason = "watchdog" | "child-exit" | "output-cap";

// How one child run ended: every case answered, a load error, or a failure on cases[index].
// `schema` marks a nonce-correct line of the wrong shape (a tool bug; CHILD_PROTOCOL when it repeats).
type ChildRun = {
  results: BatchCaseResult[];
  loadError: string | null;
  failure: { index: number; reason: TimeoutReason; elapsedMs: number; schema: boolean } | null;
  strayStdoutBytes: number;
  strayStderrBytes: number;
  forgedLines: number;
};

const MAX_SPAWN_DETAIL = 500;
const NEWLINE = 0x0a;

// The fixed child environment (SAFE-05): nothing from the parent's environment, plus the per-spawn nonce.
function childEnv(nonce: string): Record<string, string> {
  return { TZ: "UTC", LANG: "C", LC_ALL: "C", NODE_OPTIONS: "", PATH: "", LA_NONCE: nonce };
}

function childArgs(opts: BatchOptions): string[] {
  return [
    "--permission",
    `--allow-fs-read=${opts.harnessDir}`,
    `--allow-fs-read=${CONTRACTS_DIR}`,
    `--allow-fs-read=${opts.targetDir}`,
    "--import",
    pathToFileURL(join(opts.harnessDir, "net-guard-entry.ts")).href,
    join(opts.harnessDir, "main.ts"),
  ];
}

function buildJob(cases: JobCase[], opts: BatchOptions): ChildJob {
  const job: ChildJob = {
    kind: opts.replayTimeoutsMs ? "replay" : "probe",
    modulePath: opts.modulePath,
    moduleKind: opts.moduleKind,
    targetRoot: opts.targetDir,
    exportNames: [...new Set(cases.map((c) => c.exportName))],
    cases,
    world: { clockNow: opts.clockNow, seed: opts.seed },
    caseTimeoutMs: opts.caseTimeoutMs,
    limits: DEFAULT_TAGGED_LIMITS,
  };
  if (opts.replayTimeoutsMs) job.caseTimeoutsMs = opts.replayTimeoutsMs;
  return job;
}

// The parent's per-case watchdog: steps × caseTimeoutMs (or the replay budget) plus the margin (spec 5.4).
function watchdogMs(c: JobCase, opts: BatchOptions): number {
  const budget = opts.replayTimeoutsMs?.[c.id];
  const base = typeof budget === "number" ? budget : c.steps.length * opts.caseTimeoutMs;
  return base + opts.watchdogMarginMs;
}

// The result recorded for a case the parent had to give up on: every step gets the same timeout outcome.
function timeoutResult(c: JobCase, reason: TimeoutReason, elapsedMs: number): BatchCaseResult {
  const per = c.steps.length > 0 ? elapsedMs / c.steps.length : 0;
  return {
    caseId: c.id,
    steps: c.steps.map((s) => ({ args: s.args, outcome: { kind: "timeout", reason } })),
    stateAfter: null,
    consoleLines: 0,
    durationsMs: c.steps.map(() => per),
  };
}

// `stop` sees every accepted case line; returning true ends the run there (replay's early exit): the child is killed
// and the rest of its output ignored, without a failure.
function runChild(cases: JobCase[], opts: BatchOptions, stop?: (r: BatchCaseResult) => boolean): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(16).toString("hex");
    const child = spawn(process.execPath, childArgs(opts), { cwd: opts.targetDir, env: childEnv(nonce), stdio: ["pipe", "pipe", "pipe", "pipe"] });
    const run: ChildRun = { results: [], loadError: null, failure: null, strayStdoutBytes: 0, strayStderrBytes: 0, forgedLines: 0 };
    let helloSeen = false;
    let done = false;
    let settled = false;
    let stderrHead = "";
    let parts: Buffer[] = [];
    let partsBytes = 0;
    let caseStarted = performance.now();
    let caseTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(spawnTimer);
      clearTimeout(caseTimer);
      if (err) reject(err);
      else resolve(run);
    };
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const fail = (reason: TimeoutReason, schema = false): void => {
      if (run.failure || done) return;
      clearTimeout(caseTimer);
      run.failure = { index: run.results.length, reason, elapsedMs: performance.now() - caseStarted, schema };
      kill();
    };
    // Armed for cases[results.length] when the child is ready, re-armed on every accepted case line.
    const armWatchdog = (): void => {
      clearTimeout(caseTimer);
      caseStarted = performance.now();
      const next = cases[run.results.length];
      if (next) caseTimer = setTimeout(() => fail("watchdog"), watchdogMs(next, opts));
    };

    const spawnTimer = setTimeout(() => {
      if (helloSeen) return;
      kill();
      finish(new LaError("CHILD_SPAWN", `the recorder child sent no hello within ${opts.spawnTimeoutMs} ms`));
    }, opts.spawnTimeoutMs);

    const onLine = (text: string): void => {
      if (run.failure || done) return;
      const parsed = parseChildLine(text, nonce);
      if (!parsed.ok) {
        if (parsed.reason === "schema") fail("child-exit", true);
        else run.forgedLines += 1;
        return;
      }
      const line = parsed.line;
      if ("hello" in line) {
        if (helloSeen) return;
        helloSeen = true;
        clearTimeout(spawnTimer);
        armWatchdog();
        return;
      }
      if ("done" in line) {
        done = true;
        clearTimeout(caseTimer);
        return;
      }
      const expected = cases[run.results.length];
      if (!expected || line.caseId !== expected.id) {
        fail("child-exit", true);
        return;
      }
      if ("loadError" in line) {
        run.loadError = line.loadError;
        clearTimeout(caseTimer);
        return;
      }
      const result: BatchCaseResult = { caseId: line.caseId, steps: line.steps, stateAfter: line.stateAfter, consoleLines: line.consoleLines, durationsMs: line.durationsMs };
      run.results.push(result);
      if (stop?.(result)) {
        done = true;
        clearTimeout(caseTimer);
        kill();
        return;
      }
      armWatchdog();
    };

    // fd 3: NDJSON; a line longer than the cap (newline or not) kills the child with output-cap (SAFE-04).
    const fd3 = child.stdio[3] as Readable;
    fd3.on("data", (chunk: Buffer) => {
      let start = 0;
      let nl = chunk.indexOf(NEWLINE, start);
      while (nl !== -1) {
        const segment = chunk.subarray(start, nl);
        if (partsBytes + segment.length > CHILD_CAPS.fd3LineBytes) {
          fail("output-cap");
          return;
        }
        const text = Buffer.concat([...parts, segment]).toString("utf8");
        parts = [];
        partsBytes = 0;
        onLine(text);
        start = nl + 1;
        nl = chunk.indexOf(NEWLINE, start);
      }
      const rest = chunk.subarray(start);
      if (rest.length > 0) {
        parts.push(rest);
        partsBytes += rest.length;
        if (partsBytes > CHILD_CAPS.fd3LineBytes) fail("output-cap");
      }
    });
    // stdout and stderr are not the protocol: counted, capped, never parsed (SAFE-04, SAFE-08).
    child.stdout.on("data", (chunk: Buffer) => {
      run.strayStdoutBytes += chunk.length;
      if (run.strayStdoutBytes > CHILD_CAPS.stdoutBytes) fail("output-cap");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      run.strayStderrBytes += chunk.length;
      if (!helloSeen && stderrHead.length < MAX_SPAWN_DETAIL) stderrHead += chunk.toString("utf8");
      if (run.strayStderrBytes > CHILD_CAPS.stderrBytes) fail("output-cap");
    });
    child.stdin.on("error", () => { /* the child may die before reading its job */ });
    child.on("error", (err) => finish(new LaError("CHILD_SPAWN", `could not start the recorder child: ${err.message}`)));
    child.on("close", () => {
      if (!helloSeen) {
        const detail = redactSecrets(stderrHead).replace(/\s+/g, " ").trim().slice(0, MAX_SPAWN_DETAIL);
        finish(new LaError("CHILD_SPAWN", `the recorder child exited before its hello${detail ? `: ${detail}` : ""}`));
        return;
      }
      if (!done && !run.failure && run.loadError === null) {
        run.failure = { index: run.results.length, reason: "child-exit", elapsedMs: performance.now() - caseStarted, schema: false };
      }
      finish();
    });

    child.stdin.end(JSON.stringify(buildJob(cases, opts)) + "\n");
  });
}

/**
 * Runs the cases one child at a time (spec 5.4). A case the child could not finish is recorded as a timeout and the
 * batch continues in a fresh child from the next case; a watchdog case is first re-run once alone and keeps the
 * timeout only if the re-run fires too. Each case run costs at most one kill.
 */
export async function runBatch(cases: JobCase[], opts: BatchOptions): Promise<BatchResult> {
  const result: BatchResult = { cases: [], loadError: null, strayStdoutBytes: 0, strayStderrBytes: 0, forgedLines: 0, respawns: 0 };
  let spawns = 0;
  const spawnChild = async (list: JobCase[]): Promise<ChildRun> => {
    spawns += 1;
    const run = await runChild(list, opts);
    result.strayStdoutBytes += run.strayStdoutBytes;
    result.strayStderrBytes += run.strayStderrBytes;
    result.forgedLines += run.forgedLines;
    return run;
  };

  let remaining = cases;
  while (remaining.length > 0) {
    const run = await spawnChild(remaining);
    result.cases.push(...run.results);
    if (run.loadError !== null) {
      result.loadError = run.loadError;
      break;
    }
    if (!run.failure) break;
    const failed = remaining[run.failure.index];
    if (!failed) break;
    let outcome = timeoutResult(failed, run.failure.reason, run.failure.elapsedMs);
    if (run.failure.reason === "watchdog" || run.failure.schema) {
      const again = await spawnChild([failed]);
      if (again.loadError !== null) {
        result.loadError = again.loadError;
        break;
      }
      if (run.failure.schema && again.failure?.schema) {
        throw new LaError("CHILD_PROTOCOL", `the recorder child sent a malformed protocol line twice for ${failed.id}`);
      }
      const rerun = again.results[0];
      if (rerun) outcome = rerun;
      else if (again.failure) outcome = timeoutResult(failed, again.failure.reason, again.failure.elapsedMs);
    }
    result.cases.push(outcome);
    remaining = remaining.slice(run.failure.index + 1);
  }
  result.respawns = Math.max(0, spawns - 1);
  return result;
}

export type RecordResult = {
  cases: RecordedCase[];
  durationsMs: Record<CaseId, number[]>;
  batches: TimingsFile["batches"];
  loadError: string | null;
};

const LOST_IN_SECOND_RUN: Outcome = { kind: "timeout", reason: "child-exit" };

// The first difference between two runs of a case: the first differing step (1-based), or 0 for stateAfter, whose
// two values are stored as `returned` outcomes so the type stays one Outcome.
function firstDifference(a: BatchCaseResult, b: BatchCaseResult | undefined): Instability | null {
  if (!b) return { step: 1, firstRun: a.steps[0]?.outcome ?? LOST_IN_SECOND_RUN, secondRun: LOST_IN_SECOND_RUN };
  for (let i = 0; i < a.steps.length; i++) {
    const first = a.steps[i]!.outcome;
    const second = b.steps[i]?.outcome ?? LOST_IN_SECOND_RUN;
    if (!outcomesEqual(first, second)) return { step: i + 1, firstRun: first, secondRun: second };
  }
  const sa = a.stateAfter, sb = b.stateAfter;
  const same = sa === null || sb === null ? sa === sb : taggedEqual(sa, sb);
  if (!same) return { step: 0, firstRun: { kind: "returned", value: sa }, secondRun: { kind: "returned", value: sb } };
  return null;
}

function toRecorded(c: JobCase, first: BatchCaseResult, instability: Instability | null): RecordedCase {
  const { callbackIndex, steps, ...planned } = c;
  void callbackIndex;
  void steps;
  const recorded: RecordedCase = { ...planned, steps: first.steps, stateAfter: first.stateAfter, consoleLines: first.consoleLines, determinism: instability ? "unstable" : "stable" };
  if (instability) recorded.instability = instability;
  return recorded;
}

/**
 * Runs the batch twice (REC-06). A case whose steps differ (outcomesEqual) or whose stateAfter differs (taggedEqual)
 * is unstable and keeps the first run's steps; durations come from the first run and never reach the records.
 */
export async function recordCases(cases: JobCase[], opts: BatchOptions): Promise<RecordResult> {
  const t1 = performance.now();
  const first = await runBatch(cases, opts);
  const batches: TimingsFile["batches"] = [{ kind: "probe", mutantId: null, durationMs: Math.round(performance.now() - t1), respawns: first.respawns }];
  if (first.loadError !== null) return { cases: [], durationsMs: {}, batches, loadError: first.loadError };
  const t2 = performance.now();
  const second = await runBatch(cases, opts);
  batches.push({ kind: "probe", mutantId: null, durationMs: Math.round(performance.now() - t2), respawns: second.respawns });
  const firstById = new Map(first.cases.map((c) => [c.caseId, c]));
  const secondById = new Map(second.cases.map((c) => [c.caseId, c]));
  const recorded: RecordedCase[] = [];
  const durationsMs: Record<CaseId, number[]> = {};
  for (const c of cases) {
    const a = firstById.get(c.id);
    if (!a) continue;
    recorded.push(toRecorded(c, a, firstDifference(a, secondById.get(c.id))));
    durationsMs[c.id] = a.durationsMs;
  }
  return { cases: recorded, durationsMs, batches, loadError: null };
}

// ---- Replay (spec 5.4 "Replay watchdog", 5.12 statuses) ----

export type ReplayCase = JobCase & { expected: { steps: Outcome[]; stateAfter: Tagged | null } };

export type ReplayResult = { status: "killed" | "survived" | "timeout" | "error"; killedBy: string | null; durationMs: number };

/** The replay budget of one case: clamp(10 × recorded duration, 2,000, steps × caseTimeoutMs), whole milliseconds. */
export function replayCasesBudget(steps: number, recordedMs: number, caseTimeoutMs: number): number {
  const full = steps * caseTimeoutMs;
  return Math.min(full, Math.max(2000, Math.ceil(10 * recordedMs)));
}

// "timeout" when a replayed step timed out (the recorded cases never did: they are characterized), "killed" at the
// first step whose outcome differs (outcomesEqual) or when stateAfter differs (taggedEqual), "equal" otherwise.
function compareReplay(expected: ReplayCase["expected"], got: BatchCaseResult): "equal" | "killed" | "timeout" {
  if (got.steps.length !== expected.steps.length) return "killed";
  for (let i = 0; i < expected.steps.length; i++) {
    const outcome = got.steps[i]!.outcome;
    if (outcome.kind === "timeout") return "timeout";
    if (!outcomesEqual(expected.steps[i]!, outcome)) return "killed";
  }
  const a = expected.stateAfter, b = got.stateAfter;
  const same = a === null || b === null ? a === b : taggedEqual(a, b);
  return same ? "equal" : "killed";
}

/**
 * Replays recorded cases on a mutant copy in one child (a `replay` job): every case line is compared at once and the
 * first difference kills the child (`killed`, killedBy that case); a timed-out step or a parent-side failure (watchdog,
 * child exit, output cap) is `timeout`; a load error is `error`; all equal is `survived`. The child uses
 * caseTimeoutsMs[caseId] as the deadline of the whole case; the parent's watchdog is that budget plus the margin.
 */
export async function replayMutant(cases: ReplayCase[], opts: BatchOptions & { caseTimeoutsMs: Record<CaseId, number> }): Promise<ReplayResult> {
  const started = performance.now();
  const expected = new Map(cases.map((c) => [c.id, c.expected] as const));
  const jobCases: JobCase[] = cases.map(({ expected: _expected, ...c }) => c);
  const { caseTimeoutsMs, ...batch } = opts;
  let verdict: { status: "killed" | "timeout"; caseId: string } | null = null;
  const run = await runChild(jobCases, { ...batch, replayTimeoutsMs: caseTimeoutsMs }, (r) => {
    const exp = expected.get(r.caseId);
    if (!exp) return false;
    const v = compareReplay(exp, r);
    if (v === "equal") return false;
    verdict = { status: v, caseId: r.caseId };
    return true;
  });
  const durationMs = Math.round(performance.now() - started);
  const found = verdict as { status: "killed" | "timeout"; caseId: string } | null;
  if (run.loadError !== null) return { status: "error", killedBy: null, durationMs };
  if (found) return { status: found.status, killedBy: found.status === "killed" ? found.caseId : null, durationMs };
  if (run.failure) return { status: "timeout", killedBy: null, durationMs };
  return { status: "survived", killedBy: null, durationMs };
}
