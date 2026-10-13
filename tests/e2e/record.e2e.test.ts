import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Outcome } from "../../src/contracts/outcomes.ts";
import { stableStringify } from "../../src/contracts/stable-json.ts";
import type { Tagged } from "../../src/contracts/tagged.ts";
import type { PlannedCase } from "../../src/contracts/records.ts";
import type { JobCase } from "../../src/harness/protocol.ts";
import { recordCases, runBatch } from "../../src/harness/run-batch.ts";
import { stageTarget } from "../../src/harness/stage.ts";
import { LaError } from "../../src/infra/errors.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { runMapStage } from "../../src/pipeline/map.ts";
import { appendRecords, runRecordStage } from "../../src/pipeline/record.ts";
import { batchOpts, jobCase, stageTmp } from "../helpers/cases.ts";
import { tmpDir, tmpTarget } from "../helpers/tmp-target.ts";

const R = (value: Tagged): Outcome => ({ kind: "returned", value });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// What a batch recorded, without the measured durations (those vary run to run).
const recorded = (r: { cases: { durationsMs: number[] }[] }) => stableStringify(r.cases.map((c) => ({ ...c, durationsMs: c.durationsMs.length })));
const outcomes = (r: { cases: { steps: { outcome: Outcome }[] }[] }) => r.cases.map((c) => c.steps.map((s) => s.outcome));

// ---- the child world, fresh loads and the batch happy path (Task 13) ----

test("[REC-01] the CommonJS child sees the frozen clock, seeded random, counters and seeded crypto, identically in two batches", async (t) => {
  const s = stageTmp(t, "nondeterministic");
  const c = [jobCase("c01", "snapshot", [[]])];
  const a = await runBatch(c, batchOpts(s, "index.js"));
  const b = await runBatch(c, batchOpts(s, "index.js"));
  const v = (a.cases[0]!.steps[0]!.outcome as { value: Record<string, Tagged> }).value;
  assert.equal(v.now, 1700000000000);
  assert.equal(v.iso, "2023-11-14T22:13:20.000Z");
  assert.equal(v.random, 0.6011037519201636);
  assert.deepEqual([v.perf1, v.perf2], [1, 2]);
  assert.equal(v.hrBig, "1000000");
  assert.deepEqual(v.hr, [0, 2000000]);
  assert.match(String(v.uuid), UUID_V4);
  assert.match(String(v.webUuid), UUID_V4);
  assert.notEqual(v.uuid, v.webUuid);
  assert.match(String(v.bytes), /^[0-9a-f]{8}$/);
  assert.equal((v.web as number[]).length, 4);
  assert.equal(recorded(a), recorded(b));
  assert.equal(a.loadError, null);
  assert.equal(a.respawns, 0);
});

test("[REC-01] the ESM child with named node:crypto imports and web crypto gets the same stubs", async (t) => {
  const cjs = await runBatch([jobCase("c01", "snapshot", [[]])], batchOpts(stageTmp(t, "nondeterministic"), "index.js"));
  const esm = await runBatch([jobCase("c01", "snapshot", [[]], { moduleFile: "index.mjs" })], batchOpts(stageTmp(t, "nondeterministic-esm"), "index.mjs"));
  assert.equal(esm.loadError, null);
  assert.equal(stableStringify(esm.cases[0]!.steps), stableStringify(cjs.cases[0]!.steps));
});

test("[REC-01] Math.random restarts at every case", async (t) => {
  const s = stageTmp(t, "nondeterministic");
  const r = await runBatch([jobCase("c01", "rand", [[], []]), jobCase("c02", "rand", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(outcomes(r), [[R(0.6011037519201636), R(0.44829055899754167)], [R(0.6011037519201636)]]);
});

test("[REC-02] each case gets a fresh CommonJS instance and steps share one instance in order", async (t) => {
  const s = stageTmp(t, "sequence");
  const r = await runBatch([jobCase("c01", "next", [[], [], []]), jobCase("c02", "next", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(outcomes(r), [[R(1001), R(1002), R(1003)], [R(1001)]]);
  assert.deepEqual(r.cases.map((c) => c.stateAfter), [null, null]);
  assert.deepEqual(r.cases.map((c) => c.steps.map((st) => st.args)), [[[], [], []], [[]]]);
});

test("[REC-02] each case gets a fresh ESM instance, also for state in a statically imported file", async (t) => {
  const seq = await runBatch([jobCase("c01", "next", [[], []], { moduleFile: "index.mjs" }), jobCase("c02", "next", [[]], { moduleFile: "index.mjs" })], batchOpts(stageTmp(t, "sequence-esm"), "index.mjs"));
  assert.deepEqual(outcomes(seq), [[R(1001), R(1002)], [R(1001)]]);
  const two = await runBatch([jobCase("c01", "next", [[], []], { moduleFile: "index.mjs" }), jobCase("c02", "next", [[]], { moduleFile: "index.mjs" })], batchOpts(stageTmp(t, "esm-two-files"), "index.mjs"));
  assert.deepEqual(outcomes(two), [[R(1), R(2)], [R(1)]]);
  assert.deepEqual(two.cases.map((c) => c.stateAfter), [{ count: 2 }, { count: 1 }]);
});

test("[RF-1] a target under a directory whose name contains a space records normally", async (t) => {
  const s = stageTmp(t, "sequence", { parentName: "with space" });
  assert.match(s.dir, / /);
  const r = await runBatch([jobCase("c01", "next", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(r.cases[0]!.steps[0]!.outcome, R(1001));
});

test("a missing export records threw TypeError on every step", async (t) => {
  const s = stageTmp(t, "sequence");
  const r = await runBatch([jobCase("c01", "nope", [[1], []])], batchOpts(s, "index.js"));
  const threw: Outcome = { kind: "threw", value: { $t: "Error", name: "TypeError", message: "nope is not a function" } };
  assert.deepEqual(outcomes(r), [[threw, threw]]);
});

// ---- invocation styles: callbacks, promises, thrown values and leaked timers (Task 14) ----

const cbCase = (suffix: string, name: string, steps: Tagged[][], callbackIndex: number) => jobCase(suffix, name, steps, { style: "callback", callbackIndex });
const err = (name: string, message: string, code?: string): Tagged => (code === undefined ? { $t: "Error", name, message } : { $t: "Error", name, message, code });

test("[REC-04] callback arguments are recorded, error-first included, sync and async", async (t) => {
  const s = stageTmp(t, "callbacks");
  const r = await runBatch([
    cbCase("c01", "syncCb", [[3]], 1),
    cbCase("c02", "asyncCb", [[4], [10]], 1),
    cbCase("c03", "errCb", [[]], 0),
    cbCase("c04", "twice", [[]], 0),
    cbCase("c05", "throwsFirst", [[1]], 1),
    cbCase("c06", "syncCb", [[]], 1),
  ], batchOpts(s, "index.js"));
  assert.deepEqual(outcomes(r), [
    [{ kind: "callback", args: [null, 6] }],
    [{ kind: "callback", args: [null, 5] }, { kind: "callback", args: [null, 11] }],
    [{ kind: "callback", args: [err("Error", "bad")] }],
    [{ kind: "callback", args: [1] }],
    [{ kind: "threw", value: err("Error", "before 1") }],
    [{ kind: "callback", args: [null, { $t: "NaN" }] }],
  ]);
  assert.deepEqual(r.cases[1]!.steps.map((st) => st.args), [[4], [10]]);
});

test("[REC-04] a callback-style function that never calls back records no-callback", async (t) => {
  const s = stageTmp(t, "callback-never");
  const r = await runBatch([cbCase("c01", "never", [[1]], 1), cbCase("c02", "never", [[-1]], 1)], batchOpts(s, "index.js", { caseTimeoutMs: 300 }));
  assert.deepEqual(outcomes(r), [[{ kind: "no-callback" }], [{ kind: "callback", args: [null, -1] }]]);
});

test("[REC-04] a thenable return records promise fulfilled or rejected; one that never settles is a case-timeout", async (t) => {
  const s = stageTmp(t, "promise-returning");
  const r = await runBatch([
    jobCase("c01", "resolves", [[2]]),
    jobCase("c02", "rejects", [[]]),
    jobCase("c03", "never", [[]]),
    jobCase("c04", "thenable", [[]]),
    jobCase("c05", "later", [["x"]]),
  ], batchOpts(s, "index.js"));
  assert.deepEqual(outcomes(r), [
    [{ kind: "promise", status: "fulfilled", value: 4 }],
    [{ kind: "promise", status: "rejected", value: err("RangeError", "no") }],
    [{ kind: "timeout", reason: "case-timeout" }],
    [{ kind: "promise", status: "fulfilled", value: 5 }],
    [{ kind: "promise", status: "fulfilled", value: "x" }],
  ]);
});

test("[REC-05] thrown non-errors are recorded as what they are", async (t) => {
  const s = stageTmp(t, "throws-non-error");
  const r = await runBatch(["str", "num", "nul", "obj"].map((name, i) => jobCase(`c0${i + 1}`, name, [[]])), batchOpts(s, "index.js"));
  assert.deepEqual(outcomes(r), [
    [{ kind: "threw", value: "boom" }],
    [{ kind: "threw", value: 42 }],
    [{ kind: "threw", value: null }],
    [{ kind: "threw", value: { code: "E1" } }],
  ]);
});

test("[REC-04] errors are recorded with name, message and code", async (t) => {
  const s = stageTmp(t, "throws");
  const r = await runBatch([jobCase("c01", "typeErr", [[null]]), jobCase("c02", "custom", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(outcomes(r), [
    [{ kind: "threw", value: err("TypeError", "Cannot read properties of null (reading 'y')") }],
    [{ kind: "threw", value: err("Error", "custom failure", "E_CUSTOM") }],
  ]);
});

test("[REC-07] error messages are normalized to <target> so records do not depend on the staging folder", async (t) => {
  const s = stageTmp(t, "missing-file", { parentName: "with space" });
  const r = await runBatch([jobCase("c01", "readMissing", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(outcomes(r), [[{ kind: "threw", value: err("Error", "ENOENT: no such file or directory, open '<target>/nope.txt'", "ENOENT") }]]);
});

test("[REC-04] a timer left running by one case is cleared and does not touch the next case", async (t) => {
  const s = stageTmp(t, "leaky-timer");
  const r = await runBatch([jobCase("c01", "startInterval", [[]]), cbCase("c02", "ticksDuring", [[]], 0)], batchOpts(s, "index.js"));
  assert.deepEqual(outcomes(r), [[R("started")], [{ kind: "callback", args: [null, 0] }]]);
});

test("[REC-04] an error thrown by a leaked timeout is attributed to the case that scheduled it", async (t) => {
  const s = stageTmp(t, "leaky-timer");
  const r = await runBatch([jobCase("c01", "throwLater", [[], []]), jobCase("c02", "ok", [[]]), jobCase("c03", "rejectLater", [[]]), jobCase("c04", "ok", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(outcomes(r), [
    [R("scheduled"), { kind: "timeout", reason: "leaked-error" }],
    [R("ok")],
    [{ kind: "timeout", reason: "leaked-error" }],
    [R("ok")],
  ]);
});

// ---- watchdog and re-spawn (Task 15) ----

test("[REC-03] synchronous loops are killed by the per-case watchdog, re-run once, and the batch continues", async (t) => {
  const s = stageTmp(t, "infinite-loop");
  const r = await runBatch([jobCase("c01", "spin", [[]]), jobCase("c02", "ok", [[]]), jobCase("c03", "spin", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(r.cases.map((c) => c.caseId), ["index.js#spin#c01", "index.js#ok#c02", "index.js#spin#c03"]);
  assert.deepEqual(r.cases.map((c) => c.steps.at(-1)!.outcome.kind), ["timeout", "returned", "timeout"]);
  assert.equal((r.cases[0]!.steps[0]!.outcome as { reason?: string }).reason, "watchdog");
  assert.equal((r.cases[2]!.steps[0]!.outcome as { reason?: string }).reason, "watchdog");
  // c01 killed, re-run alone and killed again; c02 and c03 in a fresh child; c03 re-run alone: 4 children.
  assert.equal(r.respawns, 3);
});

test("[REC-03] a 3-step case whose steps each finish within caseTimeoutMs is never killed", async (t) => {
  const s = stageTmp(t, "slow-callback");
  const r = await runBatch([jobCase("c01", "slow", [[], [], []], { style: "callback", callbackIndex: 0 })], batchOpts(s, "index.js", { caseTimeoutMs: 300, watchdogMarginMs: 100 }));
  const cb: Outcome = { kind: "callback", args: [null, "done"] };
  assert.deepEqual(outcomes(r), [[cb, cb, cb]]);
  assert.equal(r.respawns, 0);
});

test("[SAFE-08] a target that kills its own process records timeout child-exit and the next case still runs", async (t) => {
  const s = stageTmp(t, "self-killer");
  const r = await runBatch([jobCase("c01", "killSelf", [[]]), jobCase("c02", "ok", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(outcomes(r), [[{ kind: "timeout", reason: "child-exit" }], [R("ok")]]);
  assert.equal(r.respawns, 1);
});

// ---- recordCases and the record stage (Task 17) ----

const silent = createLogger({ level: "debug", write: () => {} });
const planned = (c: JobCase): PlannedCase => {
  const { callbackIndex, ...rest } = c;
  void callbackIndex;
  return rest;
};

// Maps and stages a copied target, as `run` does, and plans the given cases.
function prepare(t: TestContext, name: string, edit?: (dir: string) => void) {
  const target = tmpTarget(t, name);
  edit?.(target);
  const out = tmpDir(t);
  const { map } = runMapStage({ targetReal: target, outDir: out, logger: silent });
  const staged = stageTarget({ targetReal: target, outDir: out });
  return { map, staged, out };
}

const stageOpts = (p: ReturnType<typeof prepare>, cases: PlannedCase[], logger = silent) => ({
  map: p.map, staged: p.staged, planned: cases, world: { clockNow: 1700000000000, seed: 42 }, caseTimeoutMs: 300, watchdogMarginMs: 200, outDir: p.out, logger,
});

test("[REC-06] a case whose two runs disagree is unstable, keeps both outcomes and the differing step", async (t) => {
  const s = stageTmp(t, "pid-reader");
  const r = await recordCases([jobCase("c01", "one", [[]]), jobCase("c02", "pid", [[], []])], batchOpts(s, "index.js"));
  assert.deepEqual(r.cases.map((c) => c.determinism), ["stable", "unstable"]);
  const inst = r.cases[1]!.instability!;
  assert.equal(inst.step, 1);
  assert.equal(inst.firstRun.kind, "returned");
  assert.notDeepEqual(inst.firstRun, inst.secondRun);
  assert.deepEqual(r.cases[1]!.steps[0]!.outcome, inst.firstRun);
  assert.equal(r.cases[0]!.instability, undefined);
  assert.ok(!("callbackIndex" in r.cases[0]!));
  assert.equal(r.batches.length, 2);
  assert.deepEqual(r.durationsMs[r.cases[1]!.id]!.length, 2);
});

test("[REC-06] a case whose steps agree but whose stateAfter differs is unstable at step 0", async (t) => {
  const s = stageTmp(t, "pid-reader");
  const r = await recordCases([jobCase("c01", "one", [[]], { moduleFile: "state.js" })], batchOpts(s, "state.js"));
  assert.equal(r.cases[0]!.determinism, "unstable");
  assert.equal(r.cases[0]!.instability!.step, 0);
});

test("[REC-07] records.json carries no duration and two recordings of the same job are byte-identical; durations go to timings.json", async (t) => {
  const a = prepare(t, "sequence");
  const b = prepare(t, "sequence");
  const cases = [planned(jobCase("c01", "next", [[], [], []])), planned(jobCase("c02", "next", [[]]))];
  const ra = await runRecordStage(stageOpts(a, cases));
  await runRecordStage(stageOpts(b, cases));
  const ta = readFileSync(join(a.out, "records.json"), "utf8");
  const tb = readFileSync(join(b.out, "records.json"), "utf8");
  assert.equal(ta, tb);
  assert.ok(!/duration/i.test(ta));
  assert.ok(!ta.includes(a.out) && !ta.includes(a.staged.dir));
  assert.deepEqual(ra.records.cases.map((c) => c.steps.map((st) => st.outcome)), [[R(1001), R(1002), R(1003)], [R(1001)]]);
  assert.deepEqual(ra.records.world, { clockNow: 1700000000000, seed: 42, tz: "UTC" });
  const timings = JSON.parse(readFileSync(join(a.out, "timings.json"), "utf8"));
  assert.equal(timings.cases["index.js#next#c01"].stepDurationsMs.length, 3);
  assert.equal(timings.batches.length, 2);
  assert.deepEqual(Object.keys(ra.durations).sort(), ["index.js#next#c01", "index.js#next#c02"]);
});

test("[MAP-01] a module with external specifiers is skipped before recording with EXTERNAL_DEPENDENCY naming leftpad and ../shared.js", async (t) => {
  const p = prepare(t, "requires-dep", (dir) => {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    symlinkSync("../leftpad/index.js", join(dir, "node_modules", ".bin", "leftpad"));
  });
  const cases = [planned(jobCase("c01", "pad", [["x"]], { moduleFile: "uses-dep.js" })), planned(jobCase("c01", "ok", [[]], { moduleFile: "ok.js" }))];
  const { records } = await runRecordStage(stageOpts(p, cases));
  assert.deepEqual(records.loadErrors.map((e) => [e.module, e.code]), [["uses-dep.js", "EXTERNAL_DEPENDENCY"]]);
  assert.match(records.loadErrors[0]!.error, /leftpad/);
  assert.match(records.loadErrors[0]!.error, /\.\.\/shared\.js/);
  assert.match(records.loadErrors[0]!.error, /modules with npm or out-of-folder dependencies are not loaded in v1$/);
  assert.deepEqual(records.cases.map((c) => [c.id, c.steps[0]!.outcome]), [["ok.js#ok#c01", R("ok")]]);
});

test("a target whose only module is external fails with EXTERNAL_DEPENDENCY", async (t) => {
  const p = prepare(t, "requires-dep", (dir) => rmSync(join(dir, "ok.js")));
  const cases = [planned(jobCase("c01", "pad", [["x"]], { moduleFile: "uses-dep.js" }))];
  await assert.rejects(runRecordStage(stageOpts(p, cases)), (e: unknown) => e instanceof LaError && e.code === "EXTERNAL_DEPENDENCY" && /uses-dep\.js/.test(e.message));
});

test("a module that throws at load time is listed with CHILD_LOAD and skipped", async (t) => {
  const p = prepare(t, "throws-at-load");
  const cases = [planned(jobCase("c01", "good", [[]], { moduleFile: "good.js" }))];
  // bad.js exports no function, so the map has none for it; plan a case against it by hand.
  const bad: PlannedCase = { ...planned(jobCase("c01", "nothing", [[]], { moduleFile: "bad.js" })) };
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
  const { records } = await runRecordStage(stageOpts(p, [bad, ...cases], logger));
  assert.deepEqual(records.loadErrors, [{ module: "bad.js", code: "CHILD_LOAD", error: "Error: cannot load <target>/bad.js" }]);
  assert.deepEqual(records.cases.map((c) => c.id), ["good.js#good#c01"]);
});

test("the record stage logs case_unstable and appendRecords keeps function order then case number", async (t) => {
  const p = prepare(t, "pid-reader");
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
  const { records } = await runRecordStage(stageOpts(p, [planned(jobCase("c02", "one", [[]])), planned(jobCase("c01", "pid", [[]])), planned(jobCase("c01", "one", [[]]))], logger));
  // map order: pid before one (source order of index.js), then state.js (no cases planned)
  assert.deepEqual(records.cases.map((c) => c.id), ["index.js#pid#c01", "index.js#one#c01", "index.js#one#c02"]);
  assert.ok(lines.some((l) => JSON.parse(l).event === "case_unstable" && JSON.parse(l).caseId === "index.js#pid#c01"));
  const extra = { ...records.cases[1]!, id: "index.js#one#c03" };
  const extraPid = { ...records.cases[0]!, id: "index.js#pid#c02" };
  const appended = appendRecords(records, [extra, extraPid]);
  assert.deepEqual(appended.cases.map((c) => c.id), ["index.js#pid#c01", "index.js#pid#c02", "index.js#one#c01", "index.js#one#c02", "index.js#one#c03"]);
  assert.equal(records.cases.length, 3);
});
