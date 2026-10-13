import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../src/infra/logger.ts";
import { relativeToProject } from "../../src/infra/paths.ts";
import { runVerify } from "../../src/pipeline/verify.ts";
import type { VerifyReport } from "../../src/pipeline/verify.ts";
import { pipelineOn } from "../helpers/cases.ts";
import { runCli } from "../helpers/run-cli.ts";
import { tmpDir, tmpTarget } from "../helpers/tmp-target.ts";

const verify = (t: Parameters<typeof tmpDir>[0], testsDir: string, against: string, extra: string[] = []) => {
  const out = join(tmpDir(t), "verify-out");
  return runCli(["verify", "--tests-dir", testsDir, "--out", out, "--against", against, "--i-trust-this-code", "--log-level", "warn", ...extra]).then((r) => ({ ...r, out, reportPath: join(out, "verify.json") }));
};
const readReport = (path: string) => JSON.parse(readFileSync(path, "utf8")) as VerifyReport;

test("[GEN-08] tests recorded on a .js CommonJS original pass against a .ts ESM copy, one --permission child per file", async (t) => {
  const { out } = await pipelineOn(t, "cjs-state");
  const against = tmpTarget(t, "esm-state");
  const r = await verify(t, join(out, "tests"), against);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const report = readReport(r.reportPath);
  assert.equal(report.files.length, 1);
  const [file] = report.files;
  assert.ok(file!.tests >= 3);
  assert.deepEqual([file!.passed, file!.failed, file!.timedOut, file!.failures], [file!.tests, 0, false, []]);
  assert.equal(report.target, relativeToProject(against));
  assert.match(r.stdout, new RegExp(`^verify: ${file!.tests} tests, ${file!.tests} passed, 0 failed {2}\\(target: ${relativeToProject(against).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&")}\\)$`, "m"));
  assert.ok(!readFileSync(r.reportPath, "utf8").includes('"durationMs"'));
});

test("[GEN-09] tests from a target that exports values assert stateAfter and pass against the CJS original and its ESM copy", async (t) => {
  const { out } = await pipelineOn(t, "cjs-state");
  const text = readFileSync(join(out, "tests/index.characterization.test.mts"), "utf8");
  assert.ok(text.includes("taggedEqual(stateAfterOf(m), "), text);
  assert.ok(text.includes('{"label":"state","total":1}'));
  for (const name of ["cjs-state", "esm-state"]) {
    const r = await verify(t, join(out, "tests"), tmpTarget(t, name));
    assert.equal(r.code, 0, `${name}: ${r.stdout}${r.stderr}`);
  }
});

test("[GEN-08] a missing module in --against is MODULE_NOT_FOUND_IN_AGAINST, exit 2, before any spawn", async (t) => {
  const { out } = await pipelineOn(t, "sequence");
  const empty = tmpDir(t);
  writeFileSync(join(empty, "package.json"), '{"type":"commonjs"}\n');
  const r = await verify(t, join(out, "tests"), empty, ["--log-level", "info"]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes('"event":"trust_gate"'), "info events are logged");
  assert.match(r.stderr, /^error: MODULE_NOT_FOUND_IN_AGAINST: .+\/index \(tried \.js, \.cjs, \.mjs, \.ts, \.mts\)$/m);
  assert.equal(r.stdout, "");
  assert.ok(!existsSync(r.reportPath));
  assert.ok(!r.stderr.includes('"event":"verify_file"'));
});

test("[GEN-08] a file whose target loops forever is killed by the file watchdog, reported as TIMEOUT and exits 3", async (t) => {
  const { out } = await pipelineOn(t, "sequence");
  const started = performance.now();
  const r = await verify(t, join(out, "tests"), tmpTarget(t, "loops-forever"), ["--file-timeout-ms", "1500"]);
  assert.ok(performance.now() - started < 20_000);
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^ {2}TIMEOUT .*index\.characterization\.test\.mts \(killed after 1\.5 s\)$/m);
  assert.match(r.stderr, /^error: VERIFY_FAILED: \d+ failing tests$/m);
  const [file] = readReport(r.reportPath).files;
  assert.equal(file!.timedOut, true);
  assert.equal(file!.passed, 0);
  assert.equal(file!.failed, file!.tests);
});

test("[GEN-08] a passing file whose target leaves a timer running exits 0 thanks to --test-force-exit", async (t) => {
  const { out } = await pipelineOn(t, "leaky-timer-verify");
  const started = performance.now();
  const r = await verify(t, join(out, "tests"), tmpTarget(t, "leaky-timer-verify"), ["--file-timeout-ms", "20000"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(performance.now() - started < 15_000, "the file exited on its own, before the watchdog");
  assert.equal(readReport(r.reportPath).files[0]!.timedOut, false);
});

test("[GEN-08] a missing export is reported as a failing test with its message, exit 3", async (t) => {
  const { out } = await pipelineOn(t, "sequence");
  const r = await verify(t, join(out, "tests"), tmpTarget(t, "missing-export"));
  assert.equal(r.code, 3, r.stdout + r.stderr);
  const report = readReport(r.reportPath);
  const failures = report.files.flatMap((f) => f.failures);
  assert.ok(failures.length >= 2);
  for (const f of failures) {
    assert.match(f.caseId ?? "", /^index\.js#next#c\d\d$/);
    assert.ok(f.name.startsWith(`[${f.caseId}] `));
    assert.match(f.message, /expected returned .+ {3}actual threw TypeError\("m\.next is not a function"\)/);
  }
  assert.match(r.stdout, /^verify: \d+ tests, 0 passed, \d+ failed {2}\(target: /m);
  assert.match(r.stdout, /^ {2}FAIL \[index\.js#next#c01\] baseline: /m);
  assert.match(r.stdout, /^ {7}(step 1: )?expected returned 1001 {3}actual threw TypeError/m);
  assert.match(r.stderr, new RegExp(`^error: VERIFY_FAILED: ${failures.length} failing tests$`, "m"));
});

test("verify refuses a missing --against, an --out inside the target and run-only options", async (t) => {
  const { out } = await pipelineOn(t, "sequence");
  const against = tmpTarget(t, "sequence");
  const missing = await runCli(["verify", "--tests-dir", join(out, "tests")]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^error: USAGE: verify needs --against <dir>/m);
  const inside = await runCli(["verify", "--tests-dir", join(out, "tests"), "--against", against, "--out", join(against, "v"), "--i-trust-this-code"]);
  assert.equal(inside.code, 1);
  assert.match(inside.stderr, /^error: USAGE: --out must not be inside, equal to or contain the --against directory$/m);
  const runOnly = await runCli(["verify", "--tests-dir", join(out, "tests"), "--against", against, "--provider", "none", "--i-trust-this-code"]);
  assert.equal(runOnly.code, 1);
  assert.match(runOnly.stderr, /^error: USAGE: --provider is not an option of verify$/m);
  const untrusted = await runCli(["verify", "--tests-dir", join(out, "tests"), "--against", against]);
  assert.equal(untrusted.code, 4);
});

test("[SAFE-07] verify runs --tests-dir code only from fixtures/ or artifacts/ unless --i-trust-this-code is given", async (t) => {
  const testsDir = tmpDir(t);
  writeFileSync(join(testsDir, "x.characterization.test.mts"), "export {};\n");
  const out = join(tmpDir(t), "v");
  const refused = await runCli(["verify", "--tests-dir", testsDir, "--against", "fixtures/refactors/modern", "--out", out]);
  assert.equal(refused.code, 4, refused.stderr);
  assert.match(refused.stderr, /^error: TRUST_REQUIRED: --tests-dir is outside fixtures\/ and artifacts\//m);
  assert.match(refused.stderr, /read grant covers everything in the target directory/);
  assert.equal(existsSync(join(out, "verify.json")), false);
  const trusted = await runCli(["verify", "--tests-dir", testsDir, "--against", "fixtures/refactors/modern", "--out", out, "--i-trust-this-code"]);
  assert.notEqual(trusted.code, 4, trusted.stderr);
});

// ---- A loaded machine: the parent reads the test file's stdout late (incident 2026-10-13, CI run 38382986246) ----

const silent = createLogger({ level: "error", write: () => {} });

/** A tests directory with one generated-looking file whose test bodies are `bodies`; --against is a copy of `sequence`. */
function syntheticFile(t: Parameters<typeof tmpDir>[0], bodies: string[]): { testsDir: string; against: string; reportPath: string } {
  const root = tmpDir(t);
  const testsDir = join(root, "tests");
  mkdirSync(testsDir);
  const tests = bodies.map((body, i) => `test("[index.js#next#c${String(i + 1).padStart(2, "0")}] baseline: case ${i + 1}", () => {${body}});\n`);
  writeFileSync(join(testsDir, "index.characterization.test.mts"), `import { test } from "node:test";\nimport { writeSync } from "node:fs";\nconst MODULE_NAME = "index";\n${tests.join("")}`);
  return { testsDir, against: tmpTarget(t, "sequence"), reportPath: join(root, "out", "verify.json") };
}

// The children of this process except `ps` itself, as their `ps` state (`ps -A -o` works on macOS and Linux).
function childStates(): string[] {
  const rows = execFileSync("ps", ["-A", "-o", "ppid=,stat=,comm="], { encoding: "utf8" }).split("\n").map((l) => l.trim().split(/\s+/));
  return rows.filter((r) => r[0] === String(process.pid) && !/(^|\/)\(?ps\)?$/.test(r.slice(2).join(" "))).map((r) => r[1] ?? "");
}

/**
 * What a loaded machine does to the parent: this process is not scheduled, so nothing reads the child's pipes, until
 * every child has exited (a zombie, `Z`) or `timeoutMs` passed. Blocks the event loop on purpose; returns how many
 * children it saw, so a stall that began before the spawn cannot pass unnoticed.
 */
function stallUntilChildrenExit(timeoutMs: number): number {
  const deadline = Date.now() + timeoutMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let seen = 0;
  for (;;) {
    const states = childStates();
    seen = Math.max(seen, states.length);
    if (states.every((s) => s.startsWith("Z")) || Date.now() > deadline) return seen;
    Atomics.wait(nap, 0, 0, 25);
  }
}

// The first test leaves the stdout channel full, as a parent that stopped reading would (bounded, so a channel that never
// fills cannot loop forever); then 20 tests pass and --test-force-exit ends the file.
const FILL_STDOUT = ` const block = Buffer.from(" ".repeat(4095) + "\\n"); try { for (let i = 0; i < 256; i++) writeSync(1, block); } catch (err) { if (err.code !== "EAGAIN") throw err; } `;

test("verify keeps every TAP result of a file that exits while the parent is not reading (a loaded machine)", async (t) => {
  const { testsDir, against, reportPath } = syntheticFile(t, [FILL_STDOUT, ...Array.from({ length: 20 }, () => "")]);
  const pending = runVerify({ testsDir, againstReal: against, fileTimeoutMs: 20_000, reportPath, logger: silent });
  const seen = stallUntilChildrenExit(20_000);
  const report = await pending;
  assert.ok(seen >= 1, "the test file's child was running when the stall began");
  const [file] = report.files;
  assert.deepEqual({ tests: file!.tests, passed: file!.passed, failed: file!.failed, timedOut: file!.timedOut }, { tests: 21, passed: 21, failed: 0, timedOut: false });
});

test("verify counts every test a file did not report as failed when the file exits 0 early", async (t) => {
  const body = (i: number): string => (i === 3 ? " process.exit(0); " : "");
  const { testsDir, against, reportPath } = syntheticFile(t, Array.from({ length: 6 }, (_, i) => body(i)));
  const report = await runVerify({ testsDir, againstReal: against, fileTimeoutMs: 20_000, reportPath, logger: silent });
  const [file] = report.files;
  assert.equal(file!.tests, 6);
  assert.ok(file!.passed <= 3, `${file!.passed} passed`);
  assert.equal(file!.failed, 6 - file!.passed);
  assert.deepEqual(file!.failures.map((f) => [f.caseId, f.message]), [[null, `the file reported ${file!.passed} of 6 test results before it exited`]]);
});

test("verify kills a file whose stdout passes 16 MiB and counts its tests as failed", async (t) => {
  // 1 MiB every 5 ms until killed (about 200 MiB/s), so the temporary stdout file stays modest while the size check catches up.
  const flood = ` const block = Buffer.alloc(1024 * 1024, 0x20); const nap = new Int32Array(new SharedArrayBuffer(4)); for (;;) { writeSync(1, block); Atomics.wait(nap, 0, 0, 5); } `;
  const { testsDir, against, reportPath } = syntheticFile(t, [flood, ""]);
  const report = await runVerify({ testsDir, againstReal: against, fileTimeoutMs: 20_000, reportPath, logger: silent });
  const [file] = report.files;
  assert.deepEqual({ tests: file!.tests, passed: file!.passed, failed: file!.failed, timedOut: file!.timedOut }, { tests: 2, passed: 0, failed: 2, timedOut: false });
  assert.deepEqual(file!.failures.map((f) => f.message), ["killed: stdout passed 16 MiB"]);
});
