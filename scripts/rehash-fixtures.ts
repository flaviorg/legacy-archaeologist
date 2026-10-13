// npm run fixtures:rehash [file...]: recomputes each fake fixture's targetSha (from its targetDir) and promptHashes,
// after a deliberate change to the target or to a prompt. Default: fixtures/llm/*.json and tests/fixtures/llm/*.json.
// Afterwards the lying fixture is derived again from the demo fixture (plan delta 12).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeJsonText } from "../src/contracts/stable-json.ts";
import { PROJECT_ROOT, relativeToProject } from "../src/infra/paths.ts";
import { computeTargetSha, walkTarget } from "../src/infra/target-files.ts";
import { promptHash, PROMPTS } from "../src/llm/fake-provider.ts";
import { DEMO_FIXTURE, LYING_FIXTURE, writeLyingFixture } from "./make-lying-fixture.ts";

function defaultFiles(): string[] {
  return ["fixtures/llm", "tests/fixtures/llm"].flatMap((dir) => {
    const abs = join(PROJECT_ROOT, dir);
    if (!existsSync(abs)) return [];
    return readdirSync(abs).filter((f) => f.endsWith(".json")).sort().map((f) => join(abs, f));
  });
}

function targetShaOf(targetDir: string): string {
  const root = join(PROJECT_ROOT, ...targetDir.split("/"));
  return computeTargetSha(walkTarget(root).map((e) => ({ relPath: e.relPath, bytes: readFileSync(e.absPath) })));
}

const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => resolve(f)) : defaultFiles();
for (const file of files) {
  const shown = relativeToProject(file);
  const fixture = JSON.parse(readFileSync(file, "utf8")) as { targetDir?: unknown; targetSha?: unknown; promptHashes?: Record<string, string> };
  if (typeof fixture.targetDir !== "string") {
    process.stderr.write(`rehash: ${shown} has no targetDir; skipped\n`);
    process.exitCode = 1;
    continue;
  }
  const oldSha = typeof fixture.targetSha === "string" ? fixture.targetSha : "";
  const newSha = targetShaOf(fixture.targetDir);
  const oldHashes = fixture.promptHashes ?? {};
  const newHashes = Object.fromEntries(PROMPTS.map((p) => [p.version, promptHash(p)]));
  const next = { ...fixture, targetSha: newSha, promptHashes: newHashes };
  const before = readFileSync(file, "utf8");
  const after = writeJsonText(next);
  if (oldSha !== newSha) process.stdout.write(`rehash: ${shown} targetSha ${oldSha.slice(7, 15) || "(none)"} → ${newSha.slice(7, 15)}\n`);
  for (const p of PROMPTS) if (oldHashes[p.version] !== newHashes[p.version]) process.stdout.write(`rehash: ${shown} promptHashes ${p.version} updated\n`);
  if (before !== after) writeFileSync(file, after);
}

if (existsSync(join(PROJECT_ROOT, DEMO_FIXTURE)) && writeLyingFixture()) process.stdout.write(`rehash: ${LYING_FIXTURE} regenerated from ${DEMO_FIXTURE}\n`);
