import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReportFile } from "../../src/contracts/report.ts";
import { loadConfig } from "../../src/infra/config.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { HARNESS_DIR } from "../../src/infra/paths.ts";
import { OPERATOR_NAMES, runPipeline } from "../../src/pipeline/run.ts";
import { pipelineOn, reverseTests, testBlocks } from "../helpers/cases.ts";
import { runNode } from "../helpers/run-cli.ts";
import { tmpDir } from "../helpers/tmp-target.ts";

const runTests = (file: string, env: Record<string, string> = {}, cwd?: string) => runNode(["--test", "--test-reporter=tap", file], { env, ...(cwd ? { cwd } : {}) });
const tapCounts = (stdout: string) => ({ pass: Number(/^# pass (\d+)$/m.exec(stdout)?.[1] ?? -1), fail: Number(/^# fail (\d+)$/m.exec(stdout)?.[1] ?? -1) });

test("[GEN-01] tests from a target with two Math.random cases pass in file order and in reversed order", async (t) => {
  const { out, result } = await pipelineOn(t, "two-randoms");
  const file = join(out, "tests/index.characterization.test.mts");
  assert.deepEqual(result.testFiles, [file]);
  const text = readFileSync(file, "utf8");
  const blocks = testBlocks(text);
  assert.ok(blocks.filter((b) => b.body.includes("m.roll(")).length >= 2, "at least two roll cases");
  assert.ok(blocks.some((b) => b.body.includes("m.stamp(")));
  const first = await runTests(file);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(tapCounts(first.stdout), { pass: blocks.length, fail: 0 });
  writeFileSync(file, reverseTests(text));
  assert.notEqual(readFileSync(file, "utf8"), text);
  const reversed = await runTests(file);
  assert.equal(reversed.code, 0, reversed.stdout + reversed.stderr);
  assert.deepEqual(tapCounts(reversed.stdout), { pass: blocks.length, fail: 0 });
});

test("[GEN-01] an ESM target whose state lives in a statically imported file passes in both orders", async (t) => {
  const { out } = await pipelineOn(t, "esm-two-files");
  const file = join(out, "tests/index.characterization.test.mts");
  const text = readFileSync(file, "utf8");
  const [only] = testBlocks(text);
  assert.ok(only && only.body.includes("m.next()") && only.body.includes("taggedEqual(stateAfterOf(m), {\"count\":1})"), text);
  // A second copy of the same test: without the query-propagating resolve hook it would see count 2.
  const again = only.body.replace(/^test\("(\[[^\]]+\])/, 'test("$1 again');
  writeFileSync(file, text.replace(/\n$/, "") + "\n\n" + again + "\n");
  const forward = await runTests(file);
  assert.equal(forward.code, 0, forward.stdout + forward.stderr);
  assert.deepEqual(tapCounts(forward.stdout), { pass: 2, fail: 0 });
  writeFileSync(file, reverseTests(readFileSync(file, "utf8")));
  const backward = await runTests(file);
  assert.equal(backward.code, 0, backward.stdout + backward.stderr);
  const state = join(out, "tests/state.characterization.test.mts");
  assert.ok(existsSync(state));
  writeFileSync(state, reverseTests(readFileSync(state, "utf8")));
  const stateRun = await runTests(state);
  assert.equal(stateRun.code, 0, stateRun.stdout + stateRun.stderr);
});

test("[GEN-01] a date-dependent target passes with TZ=Asia/Kolkata in the environment", async (t) => {
  const { out } = await pipelineOn(t, "local-date");
  const file = join(out, "tests/index.characterization.test.mts");
  const text = readFileSync(file, "utf8");
  // Recorded in UTC: the frozen clock is the 14th at 22:13, which is the 15th at 03:43 in Kolkata.
  assert.ok(text.includes('m.dayOf(revive({"$t":"Date","v":"2023-11-14T22:13:20.000Z"}))'), text);
  assert.ok(text.includes('"value":14'));
  const r = await runTests(file, { TZ: "Asia/Kolkata" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(tapCounts(r.stdout).fail, 0);
});

test("support.mts reproduces the recorder's world (D-08): the same probes print the same values from both children", async (t) => {
  const { out } = await pipelineOn(t, "sequence");
  const dir = tmpDir(t);
  cpSync(join(out, "tests/support.mts"), join(dir, "support.mts"));
  writeFileSync(join(dir, "trivial.js"), "module.exports = { one: function () { return 1; } };\n");
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}\n');
  const probes = [
    "const crypto = (await import(\"node:crypto\")).default;",
    "const out = [];",
    "const probe = () => { out.push(Date.now(), new Date().toISOString(), Math.random(), Math.random(), Math.random(), performance.now(), performance.now(), JSON.stringify(process.hrtime()), String(process.hrtime.bigint()), crypto.randomUUID(), crypto.randomBytes(4).toString(\"hex\"), globalThis.crypto.randomUUID(), Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4))).join(\",\")); };",
    "probe();",
  ].join("\n");
  writeFileSync(join(dir, "a.mts"), [
    'import { configureWorld, loadFresh } from "./support.mts";',
    "configureWorld({ clockNow: 1700000000000, seed: 42 });",
    probes,
    'await loadFresh("./trivial", "trivial", import.meta.url);',
    "probe();",
    "console.log(JSON.stringify(out));",
  ].join("\n") + "\n");
  writeFileSync(join(dir, "b.mts"), [
    `import { installWorld } from ${JSON.stringify(pathToFileURL(join(HARNESS_DIR, "freeze.ts")).href)};`,
    "const world = installWorld({ clockNow: 1700000000000, seed: 42 });",
    probes,
    "world.reseed();",
    "probe();",
    "console.log(JSON.stringify(out));",
  ].join("\n") + "\n");
  const a = await runNode([join(dir, "a.mts")], { cwd: dir });
  const b = await runNode([join(dir, "b.mts")], { cwd: dir });
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const values = JSON.parse(a.stdout) as unknown[];
  assert.equal(values.length, 26);
  assert.equal(values[0], 1700000000000);
  assert.equal(values[2], 0.6011037519201636);
  assert.equal(values[5], 1);
  assert.deepEqual(values.slice(13), values.slice(0, 13), "the second probe after the re-seed repeats the first");
  assert.equal(a.stdout, b.stdout);
});

test("[GEN-04] a sandbox-only NO_NETWORK case is listed under Not characterized and not emitted", async (t) => {
  const { out, result } = await pipelineOn(t, "net-caller");
  const spec = readFileSync(join(out, "SPEC.md"), "utf8");
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as ReportFile;
  const sandbox = report.notCharacterized.filter((n) => n.reason === "sandbox-only outcome");
  assert.ok(sandbox.length >= 3, JSON.stringify(report.notCharacterized));
  for (const n of sandbox) assert.ok(spec.includes(`| ${n.caseId} | sandbox-only outcome (${n.detail}) |`), n.caseId);
  assert.ok(sandbox.some((n) => n.detail === "NO_NETWORK"));
  const emitted = result.testFiles.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const n of sandbox) assert.ok(!emitted.includes(`[${n.caseId}]`), n.caseId);
});

test("[GEN-05] support.mts imports only node:* and the emitted files run inside a type: commonjs package", async (t) => {
  const { target, out } = await pipelineOn(t, "two-randoms");
  const support = readFileSync(join(out, "tests/support.mts"), "utf8");
  const specs = [...support.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(specs.length >= 3);
  assert.deepEqual(specs.filter((s) => !s!.startsWith("node:")), []);
  const pkg = join(tmpDir(t), "pkg");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), '{"name":"consumer","type":"commonjs"}\n');
  cpSync(join(out, "tests"), join(pkg, "tests"), { recursive: true });
  const r = await runTests(join(pkg, "tests/index.characterization.test.mts"), { LA_TARGET_DIR: target }, pkg);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(tapCounts(r.stdout).fail, 0);
});

test("[RF-1] tests generated into an out directory with a space run green", async (t) => {
  const { out } = await pipelineOn(t, "sequence", { outParent: "with space" });
  assert.ok(out.includes("with space"));
  const file = join(out, "tests/index.characterization.test.mts");
  assert.ok(readFileSync(file, "utf8").includes("const MODULE_REL = \"../../../"));
  const r = await runTests(file);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(tapCounts(r.stdout).pass >= 2);
});

test("[RF-5] generate removes stale test files and rewrites identical ones; report.json and SPEC.md carry no absolute path", async (t) => {
  const { target, out, result } = await pipelineOn(t, "sequence");
  const testsDir = join(out, "tests");
  writeFileSync(join(testsDir, "old.characterization.test.mts"), "stale\n");
  writeFileSync(join(testsDir, "keep-me.txt"), "not ours\n");
  const before = readFileSync(join(testsDir, "index.characterization.test.mts"), "utf8");
  await runPipeline({ target, cwd: out, out, provider: "none", seed: 42, clockNow: 1700000000000, caseTimeoutMs: 2000, watchdogMarginMs: 1000, maxMutants: 200, maxRounds: 1, survivorsPerRound: 10, inputsPerSurvivor: 5, operators: OPERATOR_NAMES, strictFixture: false, config: loadConfig({}), logger: createLogger({ level: "error", write: () => {} }) });
  assert.deepEqual(readdirSync(testsDir).sort(), ["index.characterization.test.mts", "keep-me.txt", "support.mts"]);
  assert.equal(readFileSync(join(testsDir, "index.characterization.test.mts"), "utf8"), before);
  for (const f of ["report.json", "SPEC.md", "tests/index.characterization.test.mts", "tests/support.mts"]) {
    const text = readFileSync(join(out, f), "utf8");
    // targetDir is project-relative ("../../private/var/..."), so only an occurrence not preceded by ".." is absolute.
    const absolute = (p: string) => new RegExp("(?<!\\.\\.)" + p.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&")).test(text);
    assert.ok(!absolute(out) && !absolute(target), `${f} has an absolute path`);
  }
  assert.equal(result.report?.tests[0]?.file, "tests/index.characterization.test.mts");
});
