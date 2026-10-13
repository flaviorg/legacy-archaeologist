import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listScannedFiles, scanText, scanTree } from "../../scripts/check-secrets.ts";
import { tmpDir } from "../helpers/tmp-target.ts";

test("scanText finds each key shape and never returns the value", () => {
  const key = "sk-or-v1-" + "x".repeat(40);
  const f = scanText(`a\nb ${key}\n`, "x.txt");
  assert.deepEqual(f.map((x) => [x.line, x.pattern]), [[2, "OpenRouter key"]]);
  assert.ok(!JSON.stringify(f).includes(key));
  const others = ["sk-ant-" + "y".repeat(30), "sk-" + "z".repeat(30), "AIza" + "w".repeat(35)].join("\n");
  assert.deepEqual(scanText(others, "y.txt").map((x) => [x.line, x.pattern]), [[1, "Anthropic key"], [2, "sk- key"], [3, "Google API key"]]);
  assert.deepEqual(scanText("sk-short and AIza-too-short", "z.txt"), []);
});

test("scanTree skips node_modules, .git and artifacts", (t) => {
  const root = tmpDir(t);
  const key = "sk-or-v1-" + "q".repeat(40);
  for (const d of ["node_modules/pkg", ".git", "artifacts/run", "coverage"]) {
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, "leak.txt"), key);
  }
  writeFileSync(join(root, "clean.ts"), "export const x = 1;\n");
  assert.deepEqual(scanTree(root, { isTracked: () => false }), []);
  assert.deepEqual(listScannedFiles(root, { isTracked: () => false }).map((f) => f.slice(root.length + 1)), ["clean.ts"]);
  writeFileSync(join(root, "src.ts"), `const k = "${key}";\n`);
  assert.deepEqual(scanTree(root, { isTracked: () => false }).map((f) => [f.path, f.line, f.pattern]), [["src.ts", 1, "OpenRouter key"]]);
});

test("scanTree ignores an untracked .env and flags a tracked one", (t) => {
  const root = tmpDir(t);
  writeFileSync(join(root, ".env"), "LLM_API_KEY=" + "sk-or-v1-" + "e".repeat(40) + "\n");
  assert.deepEqual(scanTree(root, { isTracked: () => false }), []);
  assert.deepEqual(scanTree(root, { isTracked: (rel) => rel === ".env" }).map((f) => [f.path, f.pattern]), [[".env", "tracked .env file"], [".env", "OpenRouter key"]]);
});
