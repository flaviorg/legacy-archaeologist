import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanText } from "../../scripts/check-secrets.ts";
import { CONFIG_ENV_KEYS } from "../../src/infra/config.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";
import { VERSION } from "../../src/infra/version.ts";
import { readRegion, replaceRegion } from "../helpers/readme-regions.ts";
import { importSpecifiers, listRepoFiles, readRepoFile, resolveImport, testNames } from "../helpers/repo-files.ts";

// Built by concatenation so this file does not match itself.
const PENDING = new RegExp("\\b(" + ["TO", "DO"].join("") + "|" + ["TB", "D"].join("") + "|" + ["FIX", "ME"].join("") + "|" + ["place", "holder"].join("") + ")\\b", "i");
const srcFiles = (prefix: string) => listRepoFiles().filter((f) => f.startsWith(prefix) && /\.ts$/.test(f));
const deps = (f: string) => importSpecifiers(readRepoFile(f)).map((i) => ({ ...i, to: i.spec.startsWith(".") ? resolveImport(f, i.spec) : i.spec }));
const PURE = ["src/generate/", "src/mutation/mutator.ts", "src/mutation/score.ts", "src/mutation/operators.ts", "src/pipeline/plan-cases.ts", "src/pipeline/baseline-inputs.ts", "src/pipeline/evaluate-rules.ts", "src/pipeline/eval-llm.ts", "src/pipeline/demo-hero.ts", "src/pipeline/demo-summary.ts"];
const ENV_READERS = ["src/cli.ts", "src/infra/config.ts"];
// Delta 23: the child reads and deletes LA_NONCE (spec 5.4); support-template.ts holds the emitted file's text.
const ENV_ALLOWLIST = ["src/harness/child/main.ts", "src/generate/support-template.ts"];
// A read of process.env; the quoted side-effect kind name "process.env" (contracts/map.ts, static/side-effects.ts) is not one.
const READS_ENV = /(?<!["'`])\bprocess\.env(?!["'`])/;
const FS_OR_SPAWN = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises", "node:child_process", "child_process"]);

type Violation = { file: string; spec: string };
function violations(files: string[], allowed: (to: string, typeOnly: boolean, file: string) => boolean): Violation[] {
  return files.flatMap((file) => deps(file).filter((d) => !allowed(d.to, d.typeOnly, file)).map((d) => ({ file, spec: d.spec })));
}

test("[REP-04] the import scanner finds static, re-export, side-effect, type and dynamic imports", () => {
  assert.deepEqual(importSpecifiers('import a from "../x.ts";\nexport * from "./y.ts";\nimport "./s.ts";\nimport type { T } from "zod";\nawait import("./z.ts");').map((i) => [i.spec, i.typeOnly]),
    [["../x.ts", false], ["./y.ts", false], ["./s.ts", false], ["zod", true], ["./z.ts", false]]);
});

test("[REP-04] the import scanner handles multi-line clauses, namespaces, named re-exports and import.meta", () => {
  const source = [
    "import {",
    "  a,",
    "  type B,",
    "} from './multi.ts';",
    "import * as z from \"zod\";",
    "export { c } from \"./c.ts\";",
    "export type { D } from \"./d.ts\";",
    "const u = new URL(\"../\", import.meta.url);",
    "export const value = 1;",
  ].join("\n");
  assert.deepEqual(importSpecifiers(source).map((i) => [i.spec, i.typeOnly]), [["./multi.ts", false], ["zod", false], ["./c.ts", false], ["./d.ts", true]]);
});

test("[REP-04] resolveImport turns relative specifiers into repo-relative POSIX paths", () => {
  assert.equal(resolveImport("src/harness/child/main.ts", "../../contracts/tagged.ts"), "src/contracts/tagged.ts");
  assert.equal(resolveImport("src/contracts/outcomes.ts", "./tagged.ts"), "src/contracts/tagged.ts");
  assert.equal(resolveImport("src/cli.ts", "node:fs"), "node:fs");
});

test("[REP-04] listRepoFiles lists versioned text files and skips node_modules, .git and artifacts", () => {
  const files = listRepoFiles();
  for (const f of ["package.json", ".npmrc", ".nvmrc", ".gitignore", "tsconfig.json", "src/contracts/tagged.ts", "docs/api-notes.md"]) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => /(^|\/)(node_modules|\.git|artifacts|coverage)\//.test(f)));
  assert.deepEqual(files, [...files].sort());
});

test("[REP-04] rule 1: src/contracts imports only zod and other contracts; tagged.ts and outcomes.ts import nothing else", () => {
  const files = srcFiles("src/contracts/");
  assert.ok(files.includes("src/contracts/tagged.ts") && files.includes("src/contracts/outcomes.ts"));
  assert.deepEqual(violations(files, (to) => to === "zod" || to.startsWith("src/contracts/")), []);
  const pair = new Set(["src/contracts/tagged.ts", "src/contracts/outcomes.ts"]);
  assert.deepEqual(violations([...pair], (to) => pair.has(to)), []);
});

test("[REP-04] rule 2: src/static imports only acorn, acorn-walk, contracts and static; acorn values only in parser.ts", () => {
  assert.deepEqual(violations(srcFiles("src/static/"), (to) => to === "acorn" || to === "acorn-walk" || to.startsWith("src/contracts/") || to.startsWith("src/static/")), []);
  assert.deepEqual(violations(srcFiles("src/"), (to, typeOnly, file) => to !== "acorn" || typeOnly || file === "src/static/parser.ts"), []);
  assert.deepEqual(violations(srcFiles("src/"), (to, typeOnly, file) => to !== "acorn" || !typeOnly || file.startsWith("src/static/") || file.startsWith("src/mutation/")), []);
});

test("[REP-04] rule 3: src/harness/child imports only node:* and contracts/tagged.ts, contracts/outcomes.ts", () => {
  const files = srcFiles("src/harness/child/");
  assert.ok(files.includes("src/harness/child/net-guard.ts"));
  assert.deepEqual(violations(files, (to) => to.startsWith("node:") || to === "src/contracts/tagged.ts" || to === "src/contracts/outcomes.ts" || to.startsWith("src/harness/child/")), []);
});

test("[REP-04] rule 4: src/llm never imports src/harness or src/mutation", () => {
  assert.deepEqual(violations(srcFiles("src/llm/"), (to) => !to.startsWith("src/harness/") && !to.startsWith("src/mutation/")), []);
});

test("[REP-04] rule 5: pure modules import no node:fs, node:child_process and do not read process.env", () => {
  const pure = srcFiles("src/").filter((f) => PURE.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
  assert.deepEqual(violations(pure, (to) => !FS_OR_SPAWN.has(to)), []);
  assert.deepEqual(pure.filter((f) => f !== "src/generate/support-template.ts" && READS_ENV.test(readRepoFile(f))), []);
});

test("[REP-04] the process.env scan matches reads and skips the quoted side-effect kind name", () => {
  for (const src of ["const k = process.env.KEY;", "process.env[name]", "const { A } = process.env;", "delete process.env.LA_NONCE"]) assert.ok(READS_ENV.test(src), src);
  for (const src of ['kind: "process.env"', "'process.env'", "| \"process.env\""]) assert.ok(!READS_ENV.test(src), src);
});

test("[REP-04] rule 6: process.env is read only by src/cli.ts, src/infra/config.ts and scripts/", () => {
  const readers = srcFiles("src/").filter((f) => READS_ENV.test(readRepoFile(f)));
  assert.deepEqual(readers.filter((f) => !ENV_READERS.includes(f) && !ENV_ALLOWLIST.includes(f)), []);
});

test("[REP-04] rule 8: the emitter sees no rule status, hypothesis or LLM type", () => {
  const blind = ["src/generate/emit-tests.ts", "src/generate/support-template.ts"];
  const forbidden = (to: string): boolean => to === "src/pipeline/evaluate-rules.ts" || to === "src/contracts/hypotheses.ts" || to === "src/contracts/report.ts" || to.startsWith("src/llm/");
  for (const f of blind) assert.ok(listRepoFiles().includes(f), f);
  assert.deepEqual(violations(blind, (to) => !forbidden(to)), []);
  const source = readRepoFile("src/generate/emit-tests.ts");
  const start = source.indexOf("export function emitTests(");
  assert.ok(start >= 0);
  const declaration = source.slice(start, source.indexOf("{", source.indexOf(")", start)));
  for (const name of ["EvaluatedRule", "HypothesisOutput", "SuspiciousBehavior"]) assert.ok(!declaration.includes(name) && !source.includes(name), name);
});

test("[REP-05] no pending markers in versioned files", () => {
  // Vendored third-party code is copied unmodified (fixtures/third-party/*/VENDORED.md), so it is not scanned.
  const own = listRepoFiles().filter((f) => f !== "tests/unit/conventions.unit.test.ts" && !f.startsWith("fixtures/third-party/"));
  assert.ok(listRepoFiles().includes("fixtures/third-party/bytes/index.js"));
  // The REP-05 criterion in specs/006 is copied verbatim from the design and names the markers it forbids.
  const text = (f: string): string => readRepoFile(f).split("\n").filter((l) => !l.startsWith("- **REP-05** ")).join("\n");
  assert.deepEqual(own.filter((f) => PENDING.test(text(f))), []);
});

test("VERSION matches package.json", () => assert.equal(VERSION, JSON.parse(readRepoFile("package.json")).version));

test("goldens carry no wall-clock field and no absolute path (CS-7)", () => {
  const bad = /"ts"|"generatedAt"|"startedAt"|"durationMs"|done in |\/Users\/|\/private\/|\/var\/folders\//;
  const goldens = listRepoFiles().filter((f) => f.startsWith("tests/golden/"));
  assert.ok(goldens.length >= 20, "the demo goldens exist");
  assert.deepEqual(goldens.filter((f) => bad.test(readRepoFile(f)) || readRepoFile(f).includes(PROJECT_ROOT)), []);
});

test("[DEMO-03] the README has the hero region and the <details> log region, each with one text block", () => {
  const readme = readRepoFile("README.md");
  assert.ok(readme.includes("<details><summary>Full demo log</summary>"));
  assert.ok(readme.indexOf("<!-- demo-hero:end -->") < readme.indexOf("<details><summary>Full demo log</summary>"));
  assert.ok(readme.includes("<!-- demo-log:end -->\n\n</details>"));
  assert.ok(readRegion(readme, "demo-hero").length > 0);
  assert.ok(readRegion(readme, "demo-log").length > 0);
});

test("readRegion and replaceRegion round-trip and leave the rest of the README unchanged", () => {
  const readme = "# x\n\n<!-- demo-hero:start -->\n```text\nold\n```\n<!-- demo-hero:end -->\n\n<!-- demo-log:start -->\n```text\n```\n<!-- demo-log:end -->\ntail\n";
  assert.equal(readRegion(readme, "demo-hero"), "old\n");
  assert.equal(readRegion(readme, "demo-log"), "");
  const next = replaceRegion(replaceRegion(readme, "demo-hero", "new\nlines\n"), "demo-log", "\nlog\n");
  assert.equal(readRegion(next, "demo-hero"), "new\nlines\n");
  assert.equal(readRegion(next, "demo-log"), "\nlog\n");
  assert.ok(next.startsWith("# x\n\n<!-- demo-hero:start -->\n```text\nnew") && next.endsWith("<!-- demo-log:end -->\ntail\n"));
  assert.throws(() => readRegion("no markers", "demo-hero"));
  assert.throws(() => replaceRegion(readme, "demo-hero", "a ``` fence\n"));
});

const EARS_OUTSIDE_NPM_TEST: Record<string, string> = { "LLM-08": "tests/live/real-provider.live.ts" };
test("every EARS id in specs/ appears as [ID] in a test name (CS-3)", () => {
  const specFiles = listRepoFiles().filter((f) => /^specs\/\d{3}-[^/]+\/spec\.md$/.test(f));
  assert.equal(specFiles.length, 6);
  const ids = [...new Set(specFiles.flatMap((f) => [...readRepoFile(f).matchAll(/\*\*([A-Z]{3,4}-\d{2})\*\*/g)].map((m) => m[1]!)))];
  assert.equal(ids.length, 71);
  const names = listRepoFiles().filter((f) => f.startsWith("tests/") && f.endsWith(".test.ts")).flatMap((f) => testNames(readRepoFile(f)));
  const named = (id: string): boolean => (EARS_OUTSIDE_NPM_TEST[id] ? testNames(readRepoFile(EARS_OUTSIDE_NPM_TEST[id]!)) : names).some((n) => n.includes(`[${id}]`));
  assert.deepEqual(ids.filter((id) => !named(id)), []);
});

test("testNames reads only the first argument of test(...) calls, never comments or other strings", () => {
  const source = [
    "// [MUT-08] mentioned in a comment",
    'const label = "[MUT-09] in a string";',
    'test("[GEN-06] double quoted", () => {});',
    "test('[GEN-07][GEN-08] single quoted', () => {});",
    "test(\n  `[LLM-03] template ${1}`, async () => {});",
    'test("escaped \\" quote [SUS-03]", () => {});',
  ].join("\n");
  assert.deepEqual(testNames(source), ["[GEN-06] double quoted", "[GEN-07][GEN-08] single quoted", "[LLM-03] template ${1}", 'escaped \\" quote [SUS-03]']);
});

// Constitution rule 14: everything in English. Letters and pairs common in Portuguese and absent from English text
// (a-tilde, o-tilde, c-cedilla before a or o), escaped so this file does not match itself.
const PORTUGUESE = /[\u00e3\u00f5\u00c3\u00d5]|\u00e7[aoAO]/;
test("no Portuguese text in versioned files (constitution rule 14)", () => {
  assert.deepEqual(listRepoFiles().filter((f) => PORTUGUESE.test(readRepoFile(f))), []);
});

test("the README claims no CI or Ubuntu measurement while CI has not run", () => {
  const readme = readRepoFile("README.md");
  if (!/CI (?:\(Ubuntu\) )?not run yet/.test(readme)) return;
  assert.deepEqual(readme.split("\n").filter((l) => /Ubuntu/.test(l.replace("CI (Ubuntu) not run yet", ""))), []);
});

test("the README verify block says which lines of the real terminal output it leaves out", () => {
  const readme = readRepoFile("README.md");
  const at = readme.indexOf("`npm run la -- verify --tests-dir artifacts/demo/tests");
  assert.ok(at !== -1);
  assert.match(readme.slice(at, readme.indexOf("```text", at)), /JSON log lines on stderr are left out/);
});

// An export nothing else imports reads as a leftover; drop the keyword or test it (2026-10-13 review).
test("every exported function, const or class in src/ and scripts/ is used by another file", () => {
  const code = listRepoFiles().filter((f) => /^(src|scripts|tests)\//.test(f) && /\.m?ts$/.test(f) && !f.startsWith("tests/golden/"));
  const texts = new Map(code.map((f) => [f, readRepoFile(f)]));
  const unused: string[] = [];
  for (const f of code.filter((x) => /^(src|scripts)\//.test(x))) {
    for (const m of texts.get(f)!.matchAll(/^export (?:async )?(?:function|const|class|let) ([A-Za-z0-9_$]+)/gm)) {
      const word = new RegExp(`\\b${m[1]!.replace(/\$/g, "\\$")}\\b`);
      if (![...texts].some(([other, text]) => other !== f && word.test(text))) unused.push(`${f} ${m[1]}`);
    }
  }
  assert.deepEqual(unused, []);
});

test("specs/constitution.md has at most 60 lines and every spec says Status: implemented (v1)", () => {
  assert.ok(readRepoFile("specs/constitution.md").split("\n").length <= 60);
  for (const f of listRepoFiles().filter((x) => /^specs\/\d{3}-[^/]+\/spec\.md$/.test(x))) {
    const text = readRepoFile(f);
    assert.ok(text.includes("Status: implemented (v1)"), f);
    for (const h of ["## Context", "## Acceptance criteria", "## Non-goals", "## Decisions made during implementation", "## Test files"]) assert.ok(text.includes(h), `${f}: ${h}`);
  }
});

test("[REP-01] AGENTS.md has at most 100 lines", () => assert.ok(readRepoFile("AGENTS.md").split("\n").length <= 100));

test("[REP-02] .env.example lists every variable read by src/infra/config.ts", () => {
  const env = readRepoFile(".env.example");
  assert.deepEqual(CONFIG_ENV_KEYS.filter((k) => !new RegExp(`^${k}=`, "m").test(env)), []);
  assert.match(env, /^LLM_API_KEY=$/m);
});

test("[REP-05] the pre-commit hook exists, is executable and runs typecheck, test:unit and check:secrets", () => {
  const p = join(PROJECT_ROOT, ".githooks/pre-commit");
  assert.ok((statSync(p).mode & 0o111) !== 0);
  for (const s of ["npm run --silent typecheck", "npm run --silent test:unit", "npm run --silent check:secrets"]) assert.ok(readFileSync(p, "utf8").includes(s), s);
});

test("[REP-05] no key-shaped string in versioned files outside tests/", () => {
  assert.deepEqual(listRepoFiles().filter((f) => !f.startsWith("tests/")).flatMap((f) => scanText(readRepoFile(f), f)), []);
});

test("CI runs typecheck, tests and check:secrets offline, and the demo as its own 3-minute step (CS-8)", () => {
  const yml = readRepoFile(".github/workflows/ci.yml");
  for (const s of ["actions/checkout@v7", "actions/setup-node@v7", "node-version-file: .nvmrc", "npm ci", "npm run typecheck", "npm test", "npm run check:secrets", "npm run demo", "timeout-minutes: 3", "contents: read"]) assert.ok(yml.includes(s), s);
  assert.ok(!yml.includes("secrets."));
});

test("LICENSE is MIT", () => assert.match(readRepoFile("LICENSE"), /^MIT License/));

test("docs/mutation.md names exactly the six v1 operators and carries the comparability sentence", () => {
  const md = readRepoFile("docs/mutation.md");
  for (const op of ["AOR", "ROR", "LOR", "NEG", "NUM", "BLOCK"]) assert.ok(md.includes(`\`${op}\``), op);
  for (const op of ["BOOL", "STR"]) assert.ok(!md.includes(`| \`${op}\` |`), `${op} is not a v1 operator row`);
  assert.ok(md.includes("Same formula as Stryker so the definitions match; the scores are not comparable because the operator sets differ."));
});

test("every flowchart node label in docs/diagrams is quoted", () => {
  const diagrams = listRepoFiles().filter((f) => f.startsWith("docs/diagrams/") && f.endsWith(".mmd"));
  assert.deepEqual(diagrams, ["docs/diagrams/demo-sequence.mmd", "docs/diagrams/pipeline.mmd"]);
  const unquoted: string[] = [];
  for (const f of diagrams.filter((d) => readRepoFile(d).trimStart().startsWith("flowchart"))) {
    for (const line of readRepoFile(f).split("\n").slice(1).map((l) => l.replace(/"[^"]*"/g, '""'))) {
      // A node shape opens with [, ( or { right after an ID; its label must start with a double quote.
      for (const m of line.matchAll(/\b[A-Za-z0-9_]+[[({]+(?=[^[({"])/g)) unquoted.push(`${f}: ${line.trim()} (${m[0]})`);
    }
  }
  assert.deepEqual(unquoted, []);
  const sequence = readRepoFile("docs/diagrams/demo-sequence.mmd");
  assert.ok(sequence.startsWith("sequenceDiagram"));
  for (const line of sequence.split("\n")) {
    assert.ok(!/^\s*participant \S+ as "/.test(line), `participant aliases are not quoted: ${line}`);
    if (/->>|-->>/.test(line)) assert.ok(!line.slice(line.indexOf(":")).includes(";"), `no ; inside a message: ${line}`);
  }
});

test("there are eight ADRs with the five sections, at most 40 lines each", () => {
  const adrs = listRepoFiles().filter((f) => /^docs\/adr\/\d{4}-[a-z0-9-]+\.md$/.test(f));
  assert.equal(adrs.length, 8);
  adrs.forEach((f, i) => assert.ok(f.startsWith(`docs/adr/000${i + 1}-`), f));
  for (const f of adrs) {
    const text = readRepoFile(f);
    assert.ok(text.split("\n").length <= 40, f);
    let at = -1;
    for (const h of ["## Status", "## Context", "## Decision", "## Consequences", "## Alternatives"]) {
      const next = text.indexOf(h);
      assert.ok(next > at, `${f}: ${h} in order`);
      at = next;
    }
  }
});

test("the docs named by the spec exist", () => {
  for (const f of ["docs/architecture.md", "docs/threat-model.md", "docs/fake-provider.md", "docs/mutation.md", "docs/comparison.md", "docs/research.md", "docs/incidents/notes.md", "docs/api-notes.md", "scripts/check-diagrams.ts"]) assert.ok(listRepoFiles().includes(f), f);
});

const scoreRow = (): string[] => {
  const line = readRepoFile("README.md").split("\n").find((l) => l.startsWith("| Mutation score |"));
  assert.ok(line, "the README has the three-score table");
  return line.split("|").map((c) => c.trim());
};

test("[REP-07] the README real-model column reads not run while no tests/golden/real-run-* directory exists, and equals eval.md otherwise", () => {
  const runs = existsSync(join(PROJECT_ROOT, "tests/golden")) ? readdirSync(join(PROJECT_ROOT, "tests/golden")).filter((d) => d.startsWith("real-run-")) : [];
  const row = scoreRow();
  if (runs.length === 0) {
    assert.equal(row[3], "not run");
  } else {
    const evalMd = readRepoFile(`tests/golden/${runs[0]}/legacy-billing/eval.md`);
    assert.ok(evalMd.includes(row[3]!));
    const [, model, date] = /^real-run-(.+)-(\d{4}-\d{2}-\d{2})$/.exec(runs[0]!)!;
    assert.ok(readRepoFile("README.md").includes(model!) && readRepoFile("README.md").includes(date!));
  }
});

test("the README none and fake scores equal the goldens", () => {
  const golden = (rel: string): string => `${(JSON.parse(readRepoFile(rel)) as { score: { mutationScore: number } }).score.mutationScore.toFixed(1)}%`;
  const row = scoreRow();
  assert.equal(row[2], golden("tests/golden/demo-baseline/mutation.json"));
  assert.equal(row[4], golden("tests/golden/demo/mutation.json"));
});

test("the README Mermaid block is byte-identical to docs/diagrams/pipeline.mmd (CS-8)", () => {
  const block = /```mermaid\n([\s\S]*?)```/.exec(readRepoFile("README.md"))?.[1];
  assert.equal(block, readRepoFile("docs/diagrams/pipeline.mmd"));
});

test("the README names the six operators and carries the two sourced numbers", () => {
  const readme = readRepoFile("README.md");
  for (const op of ["AOR", "ROR", "LOR", "NEG", "NUM", "BLOCK"]) assert.ok(readme.includes(`\`${op}\``), op);
  for (const n of ["31,000", "70.2%"]) assert.ok(readme.includes(n), n);
  assert.ok(readme.includes("Same formula as Stryker so the definitions match; the scores are not comparable because the operator sets differ."));
});
