// The recorder child (spec 5.4). Started by src/harness/run-batch.ts under --permission with the network guard
// imported first. Protocol: one JSON job on stdin; NDJSON lines on fd 3, each carrying the spawn nonce.
// Imports only node:*, the child-safe contracts and its own folder.
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DEFAULT_TAGGED_LIMITS } from "../../contracts/tagged.ts";
import { installWorld } from "./freeze.ts";
import { runCase } from "./invoke.ts";
import type { CaseContext } from "./invoke.ts";
import type { ChildJobIn } from "./job.ts";
import { kindOf, loadModule, registerQueryHook } from "./load.ts";
import { installTimerTracking } from "./timers.ts";

// Read and delete the nonce before anything else, so no target code can see it (SAFE-05).
const NONCE = process.env.LA_NONCE ?? "";
delete process.env.LA_NONCE;

const VERSION = "1";
const PROTOCOL_FD = 3;

function writeLine(line: Record<string, unknown>): void {
  const bytes = Buffer.from(JSON.stringify({ nonce: NONCE, ...line }) + "\n", "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(PROTOCOL_FD, bytes, offset, bytes.length - offset);
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EAGAIN") throw err;
    }
  }
}

function readJob(): Promise<ChildJobIn> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { text += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(text) as ChildJobIn);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The staged (or mutant) real path and its file:// URL become <target>; the ?la=<n> query is stripped (delta 10).
function makeNormalize(targetRoot: string): (message: string) => string {
  const href = pathToFileURL(targetRoot).href;
  const forms = [href, targetRoot].map((f) => new RegExp(escapeRegExp(f), "g"));
  return (message: string): string => {
    let out = message;
    for (const re of forms) out = out.replace(re, "<target>");
    return out.replace(/\?la=\d+/g, "");
  };
}

// Console output is counted, never printed (spec 5.4).
let consoleLines = 0;
for (const method of ["log", "info", "warn", "error", "debug"] as const) {
  console[method] = function captured(): void {
    consoleLines += 1;
  };
}

writeLine({ hello: "legacy-archaeologist-child", version: VERSION });

// An uncaught error or unhandled rejection while a case is active (or during its flush) is that case's (delta 11).
const leak = { active: false, leaked: false };
process.on("uncaughtException", () => { if (leak.active) leak.leaked = true; });
process.on("unhandledRejection", () => { if (leak.active) leak.leaked = true; });

const job = await readJob();
const world = installWorld(job.world);
const tracker = installTimerTracking();
const hook = registerQueryHook();
const kind = kindOf(job.modulePath, job.moduleKind);
const normalize = makeNormalize(job.targetRoot);
const limits = job.limits ?? DEFAULT_TAGGED_LIMITS;

let loadIndex = 0;
let written = 0;
// Stray output written by the case reaches the parent before the case line, so a cap is charged to this case.
function drained(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength === 0) return Promise.resolve();
  return new Promise((resolve) => { stream.once("drain", () => resolve()); });
}

// One flush after the last step: a 0 ms timeout created now fires after the target's own 0 ms timeouts,
// then one setImmediate lets pending rejections surface.
function flush(): Promise<void> {
  return new Promise((resolve) => { tracker.real.setTimeout(() => tracker.real.setImmediate(resolve), 0); });
}

for (const c of job.cases) {
  world.reseed();
  consoleLines = 0;
  loadIndex += 1;
  tracker.startCase();
  leak.active = true;
  leak.leaked = false;
  let mod: Record<string, unknown>;
  try {
    mod = await loadModule({ modulePath: job.modulePath, kind, targetRoot: job.targetRoot, loadIndex, hook });
  } catch (err) {
    leak.active = false;
    tracker.endCase();
    const message = err instanceof Error ? err.message : String(err);
    writeLine({ caseId: c.id, loadError: normalize(`${err instanceof Error ? err.name : "Error"}: ${message}`).slice(0, 500) });
    written += 1;
    break;
  }
  const budget = job.caseTimeoutsMs?.[c.id];
  const ctx: CaseContext = { caseTimeoutMs: job.caseTimeoutMs, caseBudgetMs: typeof budget === "number" ? budget : null, kind, limits, normalize, now: world.realNow, timers: tracker.real };
  const result = await runCase(mod, c, ctx);
  await flush();
  leak.active = false;
  tracker.endCase();
  await drained(process.stdout);
  await drained(process.stderr);
  const last = result.steps.at(-1);
  if (leak.leaked && last) last.outcome = { kind: "timeout", reason: "leaked-error" };
  writeLine({ caseId: c.id, steps: result.steps, stateAfter: result.stateAfter, consoleLines, durationsMs: result.durationsMs });
  written += 1;
}

writeLine({ done: true, cases: written });
world.realExit(0);
