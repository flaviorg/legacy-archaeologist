import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relativeToProject } from "../../src/infra/paths.ts";
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
