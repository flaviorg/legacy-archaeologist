import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch } from "../../src/harness/run-batch.ts";
import { stageTarget } from "../../src/harness/stage.ts";
import type { Outcome } from "../../src/contracts/outcomes.ts";
import { LaError } from "../../src/infra/errors.ts";
import { batchOpts, jobCase, stageTmp } from "../helpers/cases.ts";
import { tmpDir, tmpTarget } from "../helpers/tmp-target.ts";

// ---- stage (Task 12) ----

test("[SAFE-06] a symlink inside the walked tree is refused with TARGET_SYMLINK", (t) => {
  const dir = tmpTarget(t, "cjs-styles");
  symlinkSync("/etc/hosts", join(dir, "hosts.txt"));
  assert.throws(() => stageTarget({ targetReal: dir, outDir: tmpDir(t) }), (e: unknown) => e instanceof LaError && e.code === "TARGET_SYMLINK" && /hosts\.txt is a symbolic link/.test(e.message));
});

test("[SAFE-06] node_modules, .git and other dot-directories are skipped, so npm .bin symlinks are not refused", (t) => {
  const dir = tmpTarget(t, "cjs-styles");
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dep.js"), "module.exports = 1;\n");
  symlinkSync("../dep.js", join(dir, "node_modules", ".bin", "dep"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "x"), "x");
  mkdirSync(join(dir, ".cache"));
  symlinkSync("/etc/hosts", join(dir, ".cache", "hosts"));
  const staged = stageTarget({ targetReal: dir, outDir: tmpDir(t) });
  assert.deepEqual(staged.files, ["package.json", "styles.js"]);
  assert.ok(!existsSync(join(staged.dir, "node_modules")));
  assert.ok(!existsSync(join(staged.dir, ".git")));
});

test("dot-files next to the target (.env, .npmrc) are neither staged nor hashed into targetSha", (t) => {
  const dir = tmpTarget(t, "cjs-styles");
  const clean = stageTarget({ targetReal: dir, outDir: tmpDir(t) });
  writeFileSync(join(dir, ".env"), "LLM_API_KEY=not-a-real-value\n");
  writeFileSync(join(dir, ".npmrc"), "registry=http://localhost/\n");
  const staged = stageTarget({ targetReal: dir, outDir: tmpDir(t) });
  assert.deepEqual(staged.files, ["package.json", "styles.js"]);
  assert.deepEqual(readdirSync(staged.dir).sort(), ["package.json", "styles.js"]);
  assert.equal(staged.targetSha, clean.targetSha);
});

test("[SAFE-01] a .env next to the target is not readable by the child, which only sees the staged copy", async (t) => {
  const dir = tmpDir(t);
  writeFileSync(join(dir, ".env"), "LLM_API_KEY=not-a-real-value\n");
  writeFileSync(join(dir, "index.js"), 'var fs = require("fs");\nfunction readDotEnv() { return fs.readFileSync(__dirname + "/.env", "utf8"); }\nmodule.exports = { readDotEnv: readDotEnv };\n');
  const staged = stageTarget({ targetReal: dir, outDir: tmpDir(t) });
  const r = await runBatch([jobCase("c01", "readDotEnv", [[]])], batchOpts(staged, "index.js"));
  const [outcome] = r.cases.map((c) => c.steps[0]!.outcome);
  assert.equal(outcome!.kind, "threw");
  assert.ok(!JSON.stringify(r).includes("not-a-real-value"));
});

test("[SAFE-06] a target reached through the macOS tmpdir symlink is staged from its real path", (t) => {
  const real = tmpTarget(t, "cjs-styles");
  const out = tmpDir(t);
  const staged = stageTarget({ targetReal: real, outDir: out });
  assert.equal(staged.root, join(out, "stage"));
  assert.equal(staged.dir, realpathSync(join(out, "stage", "original")));
  assert.equal(readFileSync(join(staged.dir, "styles.js"), "utf8"), readFileSync(join(real, "styles.js"), "utf8"));
  assert.match(staged.targetSha, /^sha256:[0-9a-f]{64}$/);
  // tmpdir() itself is a symlink on macOS; the stage never works from the unresolved path.
  if (realpathSync(tmpdir()) !== tmpdir()) assert.ok(!staged.dir.startsWith(tmpdir() + "/"));
});

test("TARGET_TOO_LARGE above 200 files or 2 MiB in total", (t) => {
  const many = tmpDir(t);
  for (let i = 0; i < 201; i++) writeFileSync(join(many, `f${i}.js`), "x");
  assert.throws(() => stageTarget({ targetReal: many, outDir: tmpDir(t) }), (e: unknown) => e instanceof LaError && e.code === "TARGET_TOO_LARGE" && e.message === "201 files, 201 bytes (limit 200 files, 2 MiB)");
  const big = tmpDir(t);
  writeFileSync(join(big, "big.js"), "x".repeat(Math.round(2.1 * 1024 * 1024)));
  assert.throws(() => stageTarget({ targetReal: big, outDir: tmpDir(t) }), (e: unknown) => e instanceof LaError && e.code === "TARGET_TOO_LARGE" && /^1 files, 2202010 bytes/.test(e.message));
});

test("the staged package.json carries the type resolved from the nearest ancestor", (t) => {
  const parent = tmpDir(t);
  writeFileSync(join(parent, "package.json"), JSON.stringify({ type: "module" }));
  const dir = join(parent, "legacy");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.js"), "export const f = () => 1;\n");
  const staged = stageTarget({ targetReal: dir, outDir: tmpDir(t) });
  assert.equal(staged.moduleType, "module");
  assert.deepEqual(JSON.parse(readFileSync(join(staged.dir, "package.json"), "utf8")), { type: "module" });
  assert.deepEqual(staged.files, ["index.js"]);
});

test("staging twice into the same out leaves one copy", (t) => {
  const dir = tmpTarget(t, "cjs-styles");
  const out = tmpDir(t);
  const first = stageTarget({ targetReal: dir, outDir: out });
  writeFileSync(join(first.dir, "stale.js"), "x");
  const second = stageTarget({ targetReal: dir, outDir: out });
  assert.deepEqual(readdirSync(second.root), ["original"]);
  assert.ok(!existsSync(join(second.dir, "stale.js")));
  assert.equal(first.targetSha, second.targetSha);
});

// ---- child environment (Task 13) ----

test("[SAFE-05] the child env holds only the fixed set, LLM_API_KEY never reaches it and LA_NONCE is gone before the first case", async (t) => {
  process.env.LLM_API_KEY = "sk-or-v1-" + "k".repeat(40);
  t.after(() => { delete process.env.LLM_API_KEY; });
  const s = stageTmp(t, "env-reader");
  const r = await runBatch([jobCase("c01", "keys", [[]])], batchOpts(s, "index.js"));
  const keys = (r.cases[0]!.steps[0]!.outcome as { value: string[] }).value.filter((k) => !k.startsWith("__CF"));
  assert.deepEqual(keys.sort(), ["LANG", "LC_ALL", "NODE_OPTIONS", "PATH", "TZ"]);
});

// ---- output caps and stray output (Task 15) ----

test("[SAFE-04] more than 4 MiB on stdout, 64 KiB on stderr or a 1 MiB fd 3 line kills the child with output-cap and the batch continues", async (t) => {
  const s = stageTmp(t, "output-bomb");
  const r = await runBatch([jobCase("c01", "bigStdout", [[]]), jobCase("c02", "bigStderr", [[]]), jobCase("c03", "bigFd3", [[]]), jobCase("c04", "ok", [[]])], batchOpts(s, "index.js"));
  const cap: Outcome = { kind: "timeout", reason: "output-cap" };
  assert.deepEqual(r.cases.map((c) => c.steps.map((st) => st.outcome)), [[cap], [cap], [cap], [{ kind: "returned", value: "ok" }]]);
  assert.equal(r.respawns, 3);
  assert.ok(r.strayStdoutBytes > 4 * 1024 * 1024);
  assert.ok(r.strayStderrBytes > 64 * 1024);
});

test("[SAFE-08] direct writes to stdout and stderr are counted as stray bytes and never parsed", async (t) => {
  const s = stageTmp(t, "stdout-writer");
  const r = await runBatch([jobCase("c01", "noisy", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(r.cases[0]!.steps[0]!.outcome, { kind: "returned", value: "quiet" });
  assert.ok(r.strayStdoutBytes >= 1000, String(r.strayStdoutBytes));
  assert.ok(r.strayStderrBytes >= 1000, String(r.strayStderrBytes));
});

test("[SAFE-08] an fd 3 line without the spawn nonce is ignored and counted; the real outcome is kept", async (t) => {
  const s = stageTmp(t, "fd3-forger");
  const r = await runBatch([jobCase("c01", "forge", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(r.cases[0]!.steps[0]!.outcome, { kind: "returned", value: 7 });
  assert.equal(r.forgedLines, 1);
  assert.equal(r.respawns, 0);
});

// ---- permission and network isolation (Task 16) ----

const threwCode = (o: Outcome): unknown => (o.kind === "threw" && typeof o.value === "object" && o.value !== null && "code" in o.value ? o.value.code : null);
const stepOutcomes = (r: { cases: { steps: { outcome: Outcome }[] }[] }) => r.cases.map((c) => c.steps[0]!.outcome);

test("[SAFE-01] reading a file outside the granted directories records threw ERR_ACCESS_DENIED; a read inside the target works", async (t) => {
  const s = stageTmp(t, "reads-outside");
  const r = await runBatch([jobCase("c01", "readHosts", [[]]), jobCase("c02", "readOwnData", [[]])], batchOpts(s, "index.js"));
  const [outside, inside] = stepOutcomes(r);
  assert.equal(threwCode(outside!), "ERR_ACCESS_DENIED");
  assert.deepEqual(inside, { kind: "returned", value: { rate: 0.0725 } });
});

test("[SAFE-02] writing a file, spawning a process and starting a worker record threw ERR_ACCESS_DENIED", async (t) => {
  const w = await runBatch([jobCase("c01", "write", [[]])], batchOpts(stageTmp(t, "fs-writer"), "index.js"));
  const sp = await runBatch([jobCase("c01", "exec", [[]]), jobCase("c02", "worker", [[]])], batchOpts(stageTmp(t, "spawner"), "index.js"));
  assert.deepEqual([...stepOutcomes(w), ...stepOutcomes(sp)].map(threwCode), ["ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED"]);
});

test("[SAFE-03] fetch, http.request, dns.lookup and a socket to 127.0.0.1 record threw NO_NETWORK in the child", async (t) => {
  const s = stageTmp(t, "net-caller");
  const r = await runBatch(["doFetch", "httpRequest", "dnsLookup", "loopbackSocket"].map((name, i) => jobCase(`c0${i + 1}`, name, [[]])), batchOpts(s, "index.js"));
  assert.deepEqual(stepOutcomes(r).map(threwCode), ["NO_NETWORK", "NO_NETWORK", "NO_NETWORK", "NO_NETWORK"]);
});

test("[SAFE-03] an ESM named import of dns.lookup records threw NO_NETWORK", async (t) => {
  const s = stageTmp(t, "net-caller-esm");
  const r = await runBatch([jobCase("c01", "look", [[]], { moduleFile: "index.mjs" })], batchOpts(s, "index.mjs"));
  assert.equal(threwCode(stepOutcomes(r)[0]!), "NO_NETWORK");
});

test("[SAFE-08] process.exit inside the target is recorded as a thrown ProcessExitCalled and the batch continues", async (t) => {
  const s = stageTmp(t, "exit-caller");
  const r = await runBatch([jobCase("c01", "exit3", [[]]), jobCase("c02", "ok", [[]])], batchOpts(s, "index.js"));
  assert.deepEqual(stepOutcomes(r), [
    { kind: "threw", value: { $t: "Error", name: "ProcessExitCalled", message: "process.exit(3) called" } },
    { kind: "returned", value: "ok" },
  ]);
  assert.equal(r.respawns, 0);
});
