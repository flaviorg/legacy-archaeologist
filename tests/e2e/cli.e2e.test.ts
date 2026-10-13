import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCli, runNode } from "../helpers/run-cli.ts";
import { tmpDir, tmpTarget } from "../helpers/tmp-target.ts";
import { PROJECT_ROOT, relativeToProject } from "../../src/infra/paths.ts";
import { computeTargetSha, walkTarget } from "../../src/infra/target-files.ts";

const errorLines = (stderr: string) => stderr.split("\n").filter((l) => l.startsWith("error: "));
const shaOf = (dir: string) => computeTargetSha(walkTarget(dir).map((e) => ({ relPath: e.relPath, bytes: readFileSync(e.absPath) })));
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("[MAP-01] map on the billing fixture prints 7 functions and writes map.json with a relative targetDir", async (t) => {
  const out = tmpDir(t);
  const r = await runCli(["map", "--target", "fixtures/legacy-billing", "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^map: 7 exported functions · 1 callback-style · hotspots: calculateInvoice \(5\), prorate \(5\), applyDiscount \(4\)/m);
  assert.match(r.stdout, /side effects: .*Date ×\d.*Math\.random ×1.*global-write ×1.*module-state-write ×1/);
  assert.match(r.stdout, /· unresolved calls: 0$/m);
  const map = JSON.parse(readFileSync(join(out, "map.json"), "utf8"));
  assert.equal(map.targetDir, "fixtures/legacy-billing");
  assert.match(map.targetSha, /^sha256:[0-9a-f]{64}$/);
  assert.equal(map.modules[0].functions.length, 7);
  assert.ok(!readFileSync(join(out, "map.json"), "utf8").includes(out), "no absolute path in map.json");
});

test("[MAP-01] --only keeps the selected functions and the summary counts them", async (t) => {
  const out = tmpDir(t);
  const r = await runCli(["map", "--target", "fixtures/legacy-billing", "--out", out, "--only", "billing.js#applyDiscount,roundMoney"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^map: 2 exported functions · 0 callback-style/m);
  const map = JSON.parse(readFileSync(join(out, "map.json"), "utf8"));
  assert.deepEqual(map.modules[0].functions.map((f: { name: string }) => f.name), ["roundMoney", "applyDiscount"]);
  const bad = await runCli(["map", "--target", "fixtures/legacy-billing", "--out", out, "--only", "nope"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /^error: USAGE: --only names unknown functions: nope/m);
});

test("[MAP-01] a target where no file parses exits 2 with PARSE_FAILED", async (t) => {
  const target = join(tmpDir(t), "broken");
  mkdirSync(target);
  writeFileSync(join(target, "bad.js"), "function (");
  writeFileSync(join(target, "package.json"), '{"type":"commonjs"}\n');
  const out = join(tmpDir(t), "out");
  const r = await runCli(["map", "--target", target, "--out", out, "--i-trust-this-code"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^error: PARSE_FAILED: no file could be parsed \(bad\.js: Unexpected token/m);
  assert.equal(existsSync(join(out, "map.json")), false);
});

test("[SAFE-07] a target outside fixtures/ without the trust flag prints the threat summary and exits 4", async (t) => {
  const target = tmpTarget(t, "cjs-styles");
  const r = await runCli(["map", "--target", target]);
  assert.equal(r.code, 4);
  assert.match(r.stdout + r.stderr, /read grant covers everything in the target directory except dot-files/);
  const documented = /The summary printed by the trust gate:\n\n```text\n([\s\S]*?)```/.exec(readFileSync(join(PROJECT_ROOT, "docs/threat-model.md"), "utf8"))![1]!;
  assert.ok(r.stderr.includes(documented), "docs/threat-model.md shows the summary the CLI prints");
  assert.match(r.stderr, /^error: TRUST_REQUIRED: /m);
  assert.equal(errorLines(r.stderr).length, 1);
  assert.equal(existsSync(join(target, "map.json")), false);
});

test("[SAFE-06] a target given through a symlinked directory is resolved to its real path and mapped", async (t) => {
  const target = tmpTarget(t, "cjs-styles");
  const link = join(tmpDir(t), "link to target");
  symlinkSync(target, link, "dir");
  const out = join(tmpDir(t), "out dir");
  const r = await runCli(["map", "--target", link, "--out", out, "--i-trust-this-code"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(out, "map.json"), "utf8")).targetDir, relativeToProject(target));
});

test("[SAFE-06] a symlink inside the target tree is refused with TARGET_SYMLINK", async (t) => {
  const target = tmpTarget(t, "cjs-styles");
  symlinkSync(join(target, "styles.js"), join(target, "alias.js"));
  const r = await runCli(["map", "--target", target, "--out", join(tmpDir(t), "out"), "--i-trust-this-code"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^error: TARGET_SYMLINK: alias\.js/m);
});

test("[REP-06] an unknown command and an unknown option exit 1 with one error line and no stack", async () => {
  for (const args of [["frobnicate"], ["map", "--target", "fixtures/legacy-billing", "--json"], ["mutate", "--target", "fixtures/legacy-billing"], [], ["map"]]) {
    const r = await runCli(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.equal(errorLines(r.stderr).length, 1, args.join(" "));
    assert.match(errorLines(r.stderr)[0]!, /^error: USAGE: /);
    assert.ok(!/\n\s+at /.test(r.stderr));
  }
});

test("[REP-06] an error line never carries the API key", async () => {
  const key = "sk-or-v1-" + "a".repeat(40);
  const r = await runCli(["map", "--target", key], { env: { LLM_API_KEY: key } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^error: TARGET_NOT_FOUND: /m);
  assert.ok(!r.stderr.includes(key) && !r.stdout.includes(key));
});

test("[RF-2] --target pointing at a file exits 1 with USAGE naming the folder to pass", async () => {
  const r = await runCli(["map", "--target", "fixtures/legacy-billing/billing.js"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /error: USAGE: --target must be a directory; pass the folder that contains billing\.js and use --only to pick functions/);
});

test("[RF-2] a directory with only .ts files exits 2 with NO_FUNCTIONS saying no .js, .cjs or .mjs file was found", async (t) => {
  const target = join(tmpDir(t), "ts-only");
  mkdirSync(target);
  writeFileSync(join(target, "index.ts"), "export function f(a: number): number { return a }\n");
  const r = await runCli(["map", "--target", target, "--out", join(tmpDir(t), "out"), "--i-trust-this-code"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^error: NO_FUNCTIONS: no \.js, \.cjs or \.mjs file found \(TypeScript input is not supported in v1\)/m);
});

test("--out inside the target is refused with USAGE", async (t) => {
  const target = tmpTarget(t, "cjs-styles");
  const r = await runCli(["map", "--target", target, "--out", join(target, "artifacts"), "--i-trust-this-code"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: USAGE: --out must not be inside, equal to or contain the target/m);
  assert.equal(existsSync(join(target, "artifacts")), false);
});

// ---- run up to record and the provider rule (Task 23) ----

// These tests are about recording and the provider rule: one mutant and no survivor round keep them fast (M5).
const CHEAP_MUTATION = ["--max-mutants", "1", "--max-rounds", "0"];

test("[LLM-01] with LLM_PROVIDER unset the CLI picks the fake when a fixture exists and none otherwise, logging the choice", async (t) => {
  const a = await runCli(["run", "--target", "fixtures/legacy-billing", "--out", tmpDir(t), ...CHEAP_MUTATION], { env: { LOG_LEVEL: "info" } });
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stderr, /"event":"provider_defaulted".*"provider":"fake"/);
  const b = await runCli(["run", "--target", tmpTarget(t, "sequence"), "--out", tmpDir(t), "--i-trust-this-code"], { env: { LOG_LEVEL: "info" } });
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stderr, /"event":"provider_defaulted".*"provider":"none"/);
  const explicit = await runCli(["run", "--target", tmpTarget(t, "sequence"), "--out", tmpDir(t), "--i-trust-this-code", "--provider", "none"], { env: { LOG_LEVEL: "info" } });
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.ok(!explicit.stderr.includes("provider_defaulted"));
});

test("[LLM-01] an explicit fake without a fixture is NO_PROVIDER, exit 2", async (t) => {
  const target = tmpTarget(t, "sequence");
  for (const [args, env] of [[[], { LLM_PROVIDER: "fake" }], [["--provider", "fake"], {}], [["--provider", "fake", "--scenario", "no-such-scenario"], {}]] as const) {
    const out = tmpDir(t);
    const r = await runCli(["run", "--target", target, "--out", out, "--i-trust-this-code", ...args], { env });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /^error: NO_PROVIDER: /m);
    assert.equal(errorLines(r.stderr).length, 1);
    assert.ok(!existsSync(join(out, "records.json")));
  }
});

test("run writes records.json for the seven billing functions with the fake and with none", async (t) => {
  for (const provider of ["fake", "none"]) {
    const out = tmpDir(t);
    const r = await runCli(["run", "--target", "fixtures/legacy-billing", "--out", out, "--provider", provider, ...CHEAP_MUTATION]);
    assert.equal(r.code, 0, r.stderr);
    const records = readJson(join(out, "records.json"));
    const hypotheses = readJson(join(out, "hypotheses.json"));
    assert.equal(hypotheses.provider, provider);
    assert.equal(new Set(records.cases.map((c: { functionId: string }) => c.functionId)).size, 7, provider);
    assert.deepEqual(records.loadErrors, []);
    assert.equal(records.targetSha, hypotheses.targetSha);
    assert.ok(existsSync(join(out, "map.json")) && existsSync(join(out, "timings.json")) && existsSync(join(out, "llm-trace.jsonl")));
    const stable = records.cases.filter((c: { determinism: string }) => c.determinism === "stable").length;
    const label = provider === "fake" ? "fake \\(legacy-billing\\)" : "none";
    assert.match(r.stdout, new RegExp(`^run: 7 functions · ${records.cases.length} cases \\(${stable} stable\\) · provider ${label} · artifacts `, "m"));
    assert.ok(!readFileSync(join(out, "records.json"), "utf8").includes(out), "no absolute path in records.json");
  }
});

test("[LLM-04] the garbage-output fixture exits 2 with LLM_OUTPUT_INVALID and writes no records.json", async (t) => {
  const out = tmpDir(t);
  const r = await runCli(["run", "--target", "fixtures/legacy-billing", "--out", out, "--provider", "fake", "--scenario", "garbage-output"]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /^error: LLM_OUTPUT_INVALID: hypothesize\.v1 output failed validation twice: /m);
  assert.ok(!existsSync(join(out, "records.json")));
  const trace = readFileSync(join(out, "llm-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(trace.length, 1);
  assert.equal(trace[0].validation, "invalid");
  assert.ok(trace[0].raw.length > 0 && trace[0].repairRaw.length > 0);
});

test("[REP-06] usage errors exit 1, pipeline errors 2, the trust gate 4, each with one error line, no stack and no key", async (t) => {
  const key = "sk-or-v1-" + "q".repeat(40);
  for (const [args, code] of [[["run"], 1], [["mutate", "--target", "fixtures/legacy-billing"], 1], [["run", "--target", "fixtures/legacy-billing", "--keep-mutants"], 1], [["run", "--target", "fixtures/legacy-billing", "--seed", "x"], 1], [["run", "--target", "fixtures/legacy-billing", "--operators", "AOR,XYZ"], 1], [["run", "--target", "fixtures/legacy-billing", "--provider", "anthropic"], 1], [["run", "--target", "/no/such/dir", "--i-trust-this-code"], 2], [["run", "--target", tmpTarget(t, "sequence")], 4]] as const) {
    const r = await runCli([...args], { env: { LLM_API_KEY: key } });
    assert.equal(r.code, code, args.join(" "));
    assert.equal(r.stderr.split("\n").filter((l) => l.startsWith("error: ")).length, 1, args.join(" "));
    assert.ok(!r.stderr.includes(key) && !r.stdout.includes(key));
    assert.ok(!/\n\s+at /.test(r.stderr));
  }
});

test("[REP-06] openai-compatible against a closed loopback port fails with LLM_UNAVAILABLE and never prints the key", async (t) => {
  const key = "sk-or-v1-" + "w".repeat(40);
  const out = tmpDir(t);
  const r = await runCli(["run", "--target", "fixtures/legacy-billing", "--out", out], { env: { LLM_PROVIDER: "openai-compatible", LLM_API_KEY: key, LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_TIMEOUT_MS: "1000", LOG_LEVEL: "debug" } });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /^error: LLM_UNAVAILABLE: /m);
  assert.equal(errorLines(r.stderr).length, 1);
  assert.ok(!r.stderr.includes(key) && !r.stdout.includes(key));
  assert.ok(!existsSync(join(out, "records.json")));
  const flag = await runCli(["run", "--target", "fixtures/legacy-billing", "--out", tmpDir(t), "--provider", "openai-compatible"]);
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /^error: LLM_AUTH: /m);
});

test("[SUS-03] --out inside the target, or the target inside --out, is USAGE and the target is unchanged", async (t) => {
  const target = tmpTarget(t, "sequence");
  const before = shaOf(target);
  const inside = await runCli(["run", "--target", target, "--out", join(target, "out"), "--i-trust-this-code"]);
  assert.equal(inside.code, 1);
  assert.match(inside.stderr, /^error: USAGE: --out must not be inside, equal to or contain the target/m);
  assert.equal((await runCli(["run", "--target", target, "--out", dirname(target), "--i-trust-this-code"])).code, 1);
  assert.equal((await runCli(["run", "--target", target, "--out", target, "--i-trust-this-code"])).code, 1);
  assert.equal(shaOf(target), before);
  assert.ok(!existsSync(join(target, "out")));
});

test("[RF-5] run twice into the same --out yields identical records.json and a single stage copy", async (t) => {
  const target = tmpTarget(t, "sequence");
  const out = join(tmpDir(t), "out with space");
  const texts: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await runCli(["run", "--target", target, "--out", out, "--i-trust-this-code", "--provider", "none"]);
    assert.equal(r.code, 0, r.stderr);
    texts.push(readFileSync(join(out, "records.json"), "utf8"));
    assert.deepEqual(readdirSync(join(out, "stage")), ["original"]);
  }
  assert.equal(texts[0], texts[1]);
  assert.ok(readJson(join(out, "records.json")).cases.length >= 2);
});

test("npm run la loads ./.env only when it exists and prints no warning when it does not", async (t) => {
  assert.equal(JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).scripts.la, "node src/bin.ts");
  const bin = join(PROJECT_ROOT, "src/bin.ts");
  const bare = tmpDir(t);
  const quiet = await runNode([bin, "map"], { cwd: bare });
  assert.equal(quiet.code, 1);
  assert.doesNotMatch(quiet.stderr, /not found|Continuing without it/);
  assert.match(quiet.stderr, /^error: USAGE: map needs --target <dir>/m);
  const withEnv = tmpDir(t);
  writeFileSync(join(withEnv, ".env"), "LOG_LEVEL=loud\n");
  const loaded = await runNode([bin, "map"], { cwd: withEnv });
  assert.equal(loaded.code, 1);
  assert.match(loaded.stderr, /LOG_LEVEL/);
  const overridden = await runNode([bin, "map"], { cwd: withEnv, env: { LOG_LEVEL: "warn" } });
  assert.match(overridden.stderr, /^error: USAGE: map needs --target <dir>/m, "the environment wins over .env");
});
