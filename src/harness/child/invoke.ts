// Runs one case's steps on one module instance (spec 5.4). Imports only node:* and the two child-safe contracts.
import { stateAfterOf } from "../../contracts/outcomes.ts";
import type { Outcome } from "../../contracts/outcomes.ts";
import { revive, toTagged } from "../../contracts/tagged.ts";
import type { Tagged, TaggedLimits } from "../../contracts/tagged.ts";
import type { CaseResult, ChildCase } from "./job.ts";
import type { RealTimers } from "./timers.ts";

export type CaseContext = {
  caseTimeoutMs: number;
  caseBudgetMs: number | null;   // replay jobs: the deadline for the whole case
  kind: "commonjs" | "module";
  limits: TaggedLimits;
  normalize(message: string): string;
  now(): number;                 // the real monotonic clock
  timers: RealTimers;            // the real timers, for the harness's own waits
};

// Error tags carry normalized messages, so records do not depend on the staging folder (REC-07, delta 10).
function normalizeTagged(value: Tagged, normalize: (message: string) => string): Tagged {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => normalizeTagged(v, normalize));
  const tag = (value as { $t?: unknown }).$t;
  if (tag === "Error") {
    const e = value as { $t: "Error"; name: string; message: string; code?: string | number };
    const out: { $t: "Error"; name: string; message: string; code?: string | number } = { $t: "Error", name: e.name, message: normalize(e.message) };
    if (e.code !== undefined) out.code = e.code;
    return out;
  }
  if (typeof tag === "string" && tag !== "object") return value;
  const out: Record<string, Tagged> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, { value: normalizeTagged((value as Record<string, Tagged>)[key] as Tagged, normalize), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function tagValue(value: unknown, ctx: CaseContext): Tagged {
  return normalizeTagged(toTagged(value, ctx.limits), ctx.normalize);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

// Resolves with `onTimeout` after waitMs on a real timer, unless `settled` wins first.
function race(settled: Promise<Outcome>, waitMs: number, onTimeout: Outcome, ctx: CaseContext): Promise<Outcome> {
  return new Promise((resolve) => {
    const timer = ctx.timers.setTimeout(() => resolve(onTimeout), Math.max(0, waitMs));
    settled.then((o) => {
      ctx.timers.clearTimeout(timer);
      resolve(o);
    });
  });
}

async function callbackStep(fn: Function, mod: Record<string, unknown>, args: unknown[], index: number, waitMs: number, ctx: CaseContext): Promise<Outcome> {
  let called: Outcome | null = null;
  let done = false;
  let deliver: (o: Outcome) => void = () => {};
  const settled = new Promise<Outcome>((resolve) => { deliver = resolve; });
  const recorder = function recordCallback(...cbArgs: unknown[]): void {
    if (done || called) return; // the first call wins
    called = { kind: "callback", args: cbArgs.map((a) => tagValue(a, ctx)) };
    deliver(called);
  };
  const full = [...args];
  while (full.length < index) full.push(undefined);
  full.splice(index, 0, recorder);
  try {
    Reflect.apply(fn, mod, full);
  } catch (err) {
    if (!called) {
      done = true;
      return { kind: "threw", value: tagValue(err, ctx) };
    }
  }
  if (called) return called;
  const outcome = await race(settled, waitMs, { kind: "no-callback" }, ctx);
  done = true;
  return outcome;
}

async function plainStep(fn: Function, mod: Record<string, unknown>, args: unknown[], waitMs: number, ctx: CaseContext): Promise<Outcome> {
  let value: unknown;
  try {
    value = Reflect.apply(fn, mod, args);
  } catch (err) {
    return { kind: "threw", value: tagValue(err, ctx) };
  }
  if (!isThenable(value)) return { kind: "returned", value: tagValue(value, ctx) };
  const settled = Promise.resolve(value).then(
    (v): Outcome => ({ kind: "promise", status: "fulfilled", value: tagValue(v, ctx) }),
    (e: unknown): Outcome => ({ kind: "promise", status: "rejected", value: tagValue(e, ctx) }),
  );
  return race(settled, waitMs, { kind: "timeout", reason: "case-timeout" }, ctx);
}

/**
 * Runs the steps in order on `mod`. Each callback or promise wait is bounded by caseTimeoutMs, or by what is left of
 * caseBudgetMs in a replay job, whichever is smaller. stateAfter is taken right after the last step.
 */
export async function runCase(mod: Record<string, unknown>, c: ChildCase, ctx: CaseContext): Promise<CaseResult> {
  const steps: CaseResult["steps"] = [];
  const durationsMs: number[] = [];
  const caseStart = ctx.now();
  let fn: unknown;
  try {
    fn = mod[c.exportName];
  } catch {
    fn = undefined;
  }
  for (const step of c.steps) {
    const started = ctx.now();
    const waitMs = ctx.caseBudgetMs === null ? ctx.caseTimeoutMs : Math.min(ctx.caseTimeoutMs, ctx.caseBudgetMs - (started - caseStart));
    let outcome: Outcome;
    if (typeof fn !== "function") {
      outcome = { kind: "threw", value: { $t: "Error", name: "TypeError", message: `${c.exportName} is not a function` } };
    } else {
      const args = step.args.map((a) => revive(a));
      outcome = c.style === "callback" && c.callbackIndex !== null
        ? await callbackStep(fn, mod, args, c.callbackIndex, waitMs, ctx)
        : await plainStep(fn, mod, args, waitMs, ctx);
    }
    steps.push({ args: step.args, outcome });
    durationsMs.push(Math.max(0, ctx.now() - started));
  }
  let stateAfter: Tagged | null;
  try {
    stateAfter = stateAfterOf(mod, ctx.kind, ctx.limits);
    if (stateAfter !== null) stateAfter = normalizeTagged(stateAfter, ctx.normalize);
  } catch (err) {
    stateAfter = { $t: "unserializable", type: err instanceof Error ? err.name : "unknown" };
  }
  return { steps, stateAfter, durationsMs };
}
