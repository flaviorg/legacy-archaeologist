// The only test file that runs the demo target end to end (D-12). The `before` hook runs the real demo
// (scripts/demo.ts: passes A, B and C and the two verifies) with LLM_PROVIDER and LLM_API_KEY set in its environment
// (DEMO-02 and LLM-06 in the same run), then the lying run through the CLI. With UPDATE_GOLDEN=1 (npm run regen) it
// writes every golden and the two README regions, then asserts as usual.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StaticMap } from "../../src/contracts/map.ts";
import type { MutationReport } from "../../src/contracts/mutation.ts";
import { isCharacterized, outcomesEqual } from "../../src/contracts/outcomes.ts";
import type { Outcome } from "../../src/contracts/outcomes.ts";
import type { RecordsFile } from "../../src/contracts/records.ts";
import type { ReportFile } from "../../src/contracts/report.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";
import { computeTargetSha, walkTarget } from "../../src/infra/target-files.ts";
import type { VerifyReport } from "../../src/pipeline/verify.ts";
import { testBlocks } from "../helpers/cases.ts";
import { GOLDEN_DIR, assertGoldenFile, assertGoldenText } from "../helpers/golden.ts";
import { readRegion, replaceRegion } from "../helpers/readme-regions.ts";
import { runCli, runNode } from "../helpers/run-cli.ts";
import type { ChildResult } from "../helpers/run-cli.ts";
import { tmpDir } from "../helpers/tmp-target.ts";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T;
const fixtureSha = (): string => computeTargetSha(walkTarget(join(PROJECT_ROOT, "fixtures/legacy-billing")).map((e) => ({ relPath: e.relPath, bytes: readFileSync(e.absPath) })));
const TEST_FILE = "artifacts/demo/tests/billing.characterization.test.mts";
// Built at run time so no key-shaped literal is versioned.
const KEY = "sk-or-v1-" + "d".repeat(40);
const PASS_DIRS = ["artifacts/demo-baseline", "artifacts/demo", "artifacts/demo-third-party"] as const;

let shaBefore = "";
let demo: ChildResult;
let lying: ChildResult;
let brokenCli: ChildResult;
let hero = "";
let summary = "";

/** The hero is everything up to the first blank line; the summary (which opens with that blank line) is the rest. */
function splitHero(stdout: string): [string, string] {
  const at = stdout.indexOf("\n\n");
  assert.ok(at > 0, "the demo prints the hero, a blank line, then the summary");
  return [stdout.slice(0, at + 1), stdout.slice(at + 1)];
}

function filesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(PROJECT_ROOT, dir), { withFileTypes: true })) {
      const child = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push(child);
    }
  };
  walk(rel);
  return out.sort();
}

function emittedIds(testFile: string): string[] {
  return [...read(testFile).matchAll(/test\("\[([^\]]+)\]/g)].map((m) => m[1] as string).sort();
}

before(async () => {
  shaBefore = fixtureSha();
  demo = await runNode(["scripts/demo.ts"], { env: { LLM_PROVIDER: "openai-compatible", LLM_API_KEY: KEY }, timeoutMs: 600_000 });
  assert.equal(demo.code, 0, demo.stdout + demo.stderr);
  [hero, summary] = splitHero(demo.stdout);
  lying = await runCli(["run", "--target", "fixtures/legacy-billing", "--out", "artifacts/test-demo-lying", "--provider", "fake", "--scenario", "lying-hypotheses", "--log-level", "warn"], { timeoutMs: 300_000 });
  assert.equal(lying.code, 0, lying.stdout + lying.stderr);
  brokenCli = await runCli(["verify", "--tests-dir", "artifacts/demo/tests", "--out", "artifacts/test-demo-verify-broken", "--against", "fixtures/refactors/broken", "--log-level", "warn"]);
  if (process.env.UPDATE_GOLDEN === "1") {
    const readme = read("README.md");
    writeFileSync(join(PROJECT_ROOT, "README.md"), replaceRegion(replaceRegion(readme, "demo-hero", hero), "demo-log", summary));
  }
});

test("[DEMO-01] the demo exits 0 with no key in use and no network, and writes the three passes", () => {
  assert.equal(demo.code, 0);
  for (const d of PASS_DIRS) assert.ok(existsSync(join(PROJECT_ROOT, d, "mutation.json")), d);
  for (const h of ["── pass A · provider: none (no LLM", "── pass B · provider: fake (scripted) ──", "── pass C · fixtures/third-party/bytes"]) assert.ok(demo.stdout.includes(h), h);
  assert.match(demo.stderr, /done in \d+\.\d s · exit 0/);
  assert.ok(!demo.stdout.includes("done in"));
  for (const p of ["[pass A] recording done", "[pass B] mutation done", "[pass C] tests done"]) assert.ok(demo.stderr.includes(p), p);
  assert.ok(existsSync(join(PROJECT_ROOT, "artifacts/demo/verify-modern.json")) && existsSync(join(PROJECT_ROOT, "artifacts/demo/verify-broken.json")));
});

test("[DEMO-02] with LLM_API_KEY and LLM_PROVIDER set and no --live, pass B still uses the fake", () => {
  assert.ok(demo.stdout.includes("provider: fake (scripted)"));
  assert.equal(readJson<ReportFile>("artifacts/demo/report.json").provider, "fake");
  assert.equal(read("artifacts/demo/llm-trace.jsonl").includes('"model":"fake"'), true);
});

test("[LLM-06] the key set in the environment appears in no output and no artifact", () => {
  assert.ok(!demo.stdout.includes(KEY) && !demo.stderr.includes(KEY));
  const files = [...PASS_DIRS, "artifacts/test-demo-lying"].flatMap((d) => filesUnder(d));
  assert.ok(files.length > 20);
  assert.deepEqual(files.filter((f) => readFileSync(join(PROJECT_ROOT, f)).includes(KEY)), []);
});

test("[DEMO-03] the printed hero and summary equal their goldens, and the README regions equal both", () => {
  assertGoldenText(hero, "demo/demo-hero.txt");
  assertGoldenText(summary, "demo/demo-summary.txt");
  assert.ok(hero.trimEnd().split("\n").length <= 12);
  const readme = read("README.md");
  assert.equal(readRegion(readme, "demo-hero"), hero);
  assert.equal(readRegion(readme, "demo-log"), summary);
});

test("pass B artifacts equal the goldens", () => {
  for (const f of ["map.json", "hypotheses.json", "records.json", "mutation.json", "report.json", "SPEC.md", "llm-trace.jsonl", "tests/billing.characterization.test.mts", "tests/support.mts", "verify-broken.json"]) {
    assertGoldenFile(`artifacts/demo/${f}`, `demo/${f}`);
  }
});

test("[DEMO-04] the none runs on the fixture and on bytes equal their goldens and their SPEC.md says provider: none (no LLM) with no rules table", () => {
  for (const f of ["map.json", "hypotheses.json", "records.json", "mutation.json", "SPEC.md", "tests/billing.characterization.test.mts", "tests/support.mts"]) {
    assertGoldenFile(`artifacts/demo-baseline/${f}`, `demo-baseline/${f}`);
  }
  for (const f of ["map.json", "records.json", "mutation.json", "SPEC.md"]) assertGoldenFile(`artifacts/demo-third-party/${f}`, `third-party/bytes/${f}`);
  for (const d of ["artifacts/demo-baseline", "artifacts/demo-third-party"]) {
    const spec = read(`${d}/SPEC.md`);
    assert.ok(spec.includes("provider: none (no LLM)"), d);
    assert.ok(!spec.includes("| Rule |"), `${d}: no rules table`);
    assert.equal(readJson<ReportFile>(`${d}/report.json`).rules.length, 0, d);
  }
  assert.equal(read("artifacts/demo-third-party/llm-trace.jsonl"), "");
});

// After the artifact goldens, so a first `npm run regen` has written the mutation.json goldens it reads.
test("[DEMO-03] the scores in the hero equal the three mutation.json goldens", () => {
  const golden = (rel: string): number => (JSON.parse(readFileSync(join(GOLDEN_DIR, rel), "utf8")) as MutationReport).score.mutationScore;
  const fixture = /mutation score on the fixture · none (\d+\.\d)% · fake (\d+\.\d)% \(scripted/.exec(hero);
  assert.ok(fixture, hero);
  assert.equal(fixture[1], golden("demo-baseline/mutation.json").toFixed(1));
  assert.equal(fixture[2], golden("demo/mutation.json").toFixed(1));
  const third = /^bytes@3\.1\.2, code we did not write, no LLM: .* mutation score (\d+\.\d)% · /m.exec(hero);
  assert.ok(third, hero);
  assert.equal(third[1], golden("third-party/bytes/mutation.json").toFixed(1));
  const closing = /^mutation score · none (\d+\.\d)% · fake \(scripted: author-written survivor inputs\) (\d+\.\d)% · /m.exec(summary);
  assert.ok(closing, summary);
  assert.deepEqual([closing[1], closing[2]], [fixture[1], fixture[2]]);
});

test("[DEMO-06] in every pass the emitted case IDs equal mutation.json replayedCases", () => {
  const passes: [string, string][] = [
    ["artifacts/demo-baseline", "billing.characterization.test.mts"],
    ["artifacts/demo", "billing.characterization.test.mts"],
    ["artifacts/demo-third-party", "index.characterization.test.mts"],
  ];
  for (const [dir, file] of passes) {
    const ids = emittedIds(`${dir}/tests/${file}`);
    assert.ok(ids.length > 0, dir);
    assert.deepEqual(ids, [...readJson<MutationReport>(`${dir}/mutation.json`).replayedCases].sort(), dir);
  }
});

test("[GEN-06] every emitted test passes against the modern refactor, including the 3-step nextInvoiceNumber sequence", () => {
  const modern = readJson<VerifyReport>("artifacts/demo/verify-modern.json");
  assert.equal(modern.target, "fixtures/refactors/modern");
  const blocks = testBlocks(read(TEST_FILE));
  const seq = blocks.find((b) => b.name.includes("#nextInvoiceNumber#") && (b.body.match(/capture\(\(\) => m\.nextInvoiceNumber/g) ?? []).length === 3);
  assert.ok(seq, "a 3-step nextInvoiceNumber test is emitted");
  assert.equal(modern.files.length, 1);
  assert.equal(modern.files[0]!.failed, 0);
  assert.equal(modern.files[0]!.passed, blocks.length);
  assert.ok(summary.includes(`verify --against fixtures/refactors/modern   ${blocks.length} tests · ${blocks.length} passed · 0 failed   ✔ behavior preserved on recorded cases`));
});

test("[GEN-07] the broken refactor fails exactly the cases of verify-broken.json, with expected and actual, exit 3", () => {
  const broken = readJson<VerifyReport>("artifacts/demo/verify-broken.json");
  const failures = broken.files.flatMap((x) => x.failures);
  for (const f of failures) assert.match(f.message, /expected .+ {3}actual .+/);
  const ids = failures.map((f) => f.caseId);
  for (const id of ["billing.js#applyDiscount#c01", "billing.js#roundMoney#c01", "billing.js#calculateInvoice#c02"]) assert.ok(ids.includes(id), id);
  // The same tests through the CLI: exit 3, each failure with expected and actual, one VERIFY_FAILED line.
  assert.equal(brokenCli.code, 3, brokenCli.stdout + brokenCli.stderr);
  assert.equal(read("artifacts/test-demo-verify-broken/verify.json"), read("artifacts/demo/verify-broken.json"));
  assert.match(brokenCli.stdout, /^ {2}FAIL \[billing\.js#applyDiscount#c01\] probe BR-01: subtotal exactly 100\.00 with VIP$/m);
  assert.match(brokenCli.stdout, /^ {7}expected returned 100 {3}actual returned 90$/m);
  assert.match(brokenCli.stderr, new RegExp(`^error: VERIFY_FAILED: ${failures.length} failing tests$`, "m"));
});

test("[GEN-07] each of the two broken changes causes at least one listed failure", async (t) => {
  const source = read("fixtures/refactors/modern/billing.ts");
  const changes = {
    threshold: ["if (subtotal > 100) {", "if (subtotal >= 100) {"],
    rounding: ["Math.floor(n * 100 + 0.5) / 100;", "Math.sign(n) * Math.round(Math.abs(n) * 100) / 100;"],
  } as const;
  const union = new Set<string>();
  for (const [name, [from, to]] of Object.entries(changes)) {
    assert.equal(source.split(from).length, 2, `${name}: the line to change appears once`);
    const dir = join(tmpDir(t), name);
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(dir, "billing.ts"), source.replace(from, to));
    const out = join(tmpDir(t), "out");
    const r = await runCli(["verify", "--tests-dir", "artifacts/demo/tests", "--out", out, "--against", dir, "--i-trust-this-code", "--log-level", "warn"]);
    assert.equal(r.code, 3, `${name}: ${r.stdout}${r.stderr}`);
    const report = JSON.parse(readFileSync(join(out, "verify.json"), "utf8")) as VerifyReport;
    const ids = report.files.flatMap((f) => f.failures.map((x) => x.caseId as string));
    assert.ok(ids.length >= 1, `${name} flips at least one recorded case`);
    for (const id of ids) union.add(id);
  }
  const brokenIds = new Set(readJson<VerifyReport>("artifacts/demo/verify-broken.json").files.flatMap((f) => f.failures.map((x) => x.caseId as string)));
  assert.deepEqual([...union].sort(), [...brokenIds].sort());
});

test("[LLM-03] the lying run leaves records.json, the test file and support.mts byte-identical; SPEC.md differs; every checkable rule is contradicted", () => {
  for (const f of ["records.json", "mutation.json", "tests/billing.characterization.test.mts", "tests/support.mts"]) assert.equal(read(`artifacts/test-demo-lying/${f}`), read(`artifacts/demo/${f}`), f);
  for (const f of ["SPEC.md", "report.json", "hypotheses.json", "llm-trace.jsonl"]) assert.notEqual(read(`artifacts/test-demo-lying/${f}`), read(`artifacts/demo/${f}`), f);
  const rep = readJson<ReportFile>("artifacts/test-demo-lying/report.json");
  assert.ok(rep.rules.length > 0);
  for (const r of rep.rules.filter((x) => x.probesChecked > 0)) assert.equal(r.status, "contradicted", r.ruleId);
  assert.equal(rep.suspicious.length, rep.rules.reduce((n, r) => n + r.probesChecked, 0));
  assert.ok(!read("artifacts/test-demo-lying/tests/billing.characterization.test.mts").includes("It is not true"));
});

test("[HYP-05] every emitted expected value equals the recorded outcome of its case", () => {
  const records = readJson<RecordsFile>("artifacts/demo/records.json");
  const byId = new Map(records.cases.map((c) => [c.id, c]));
  const blocks = testBlocks(read(TEST_FILE));
  assert.equal(blocks.length, records.cases.filter((c) => isCharacterized(c)).length);
  for (const b of blocks) {
    const id = /^\[([^\]]+)\]/.exec(b.name)?.[1] ?? "";
    const c = byId.get(id);
    assert.ok(c, id);
    const literal = /^ {2}const expected = (.+);$/m.exec(b.body)?.[1] ?? "";
    const parsed: unknown = literal.startsWith("JSON.parse(") ? JSON.parse(JSON.parse(literal.slice(11, -1)) as string) : JSON.parse(literal);
    const expected = (Array.isArray(parsed) ? parsed : [parsed]) as Outcome[];
    assert.equal(expected.length, c.steps.length, id);
    c.steps.forEach((s, i) => assert.ok(outcomesEqual(expected[i]!, s.outcome) && outcomesEqual(s.outcome, expected[i]!), `${id} step ${i + 1}`));
    assert.ok(!b.body.includes("lying-prediction"));
  }
});

test("[SUS-03] the fixture's targetSha is unchanged after the runs", () => {
  const after = fixtureSha();
  assert.equal(after, shaBefore);
  assert.equal(readJson<StaticMap>("artifacts/demo/map.json").targetSha, after);
});

test("[MUT-07] the demo's survivor round adds survivor-round cases, raises the score and prints both scores", () => {
  const m = readJson<MutationReport>("artifacts/demo/mutation.json");
  assert.equal(m.rounds.length, 1);
  const round = m.rounds[0]!;
  assert.equal(round.survivorsConsidered.length, 10);
  assert.ok(round.scoreAfter > round.scoreBefore);
  const records = readJson<RecordsFile>("artifacts/demo/records.json");
  for (const id of round.newCases) assert.equal(records.cases.find((c) => c.id === id)?.origin, "survivor-round", id);
  const left = m.mutants.filter((x) => x.status === "survived").length;
  const flagged = m.mutants.filter((x) => x.llmSuggestedEquivalent !== null).length;
  assert.ok(flagged >= 1);
  // The CLI line (the lying run copies the survivor turns unchanged, so its mutation.json is the demo's) ...
  const line = `mutation: round 0 ${round.scoreBefore.toFixed(1)}% → round 1 ${round.scoreAfter.toFixed(1)}% (${left} survivors left, ${flagged} flagged "likely equivalent" by the LLM, advisory)`;
  assert.ok(lying.stdout.split("\n").includes(line), lying.stdout);
  // ... and the demo summary's round lines.
  assert.ok(summary.includes(`round 0: killed `) && summary.includes(`→ mutation score ${round.scoreBefore.toFixed(1)}%`));
  assert.ok(summary.includes(`${round.killed.length} more killed → ${round.scoreAfter.toFixed(1)}% (${left} survivors left, ${flagged} flagged "likely equivalent" by the LLM, advisory)`));
  const trace = read("artifacts/demo/llm-trace.jsonl").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(trace.filter((e) => e.prompt === "survivor-inputs.v1").length, 10);
  assert.equal(trace.filter((e) => e.validation === "repaired").length, 1);
});
