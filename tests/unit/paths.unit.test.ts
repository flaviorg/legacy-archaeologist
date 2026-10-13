import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS_DIR, FIXTURES_DIR, HARNESS_DIR, PROJECT_ROOT, isInsideOrEqual, relativeToProject, resolveOutDir, resolveTarget } from "../../src/infra/paths.ts";
import { tmpDir } from "../helpers/tmp-target.ts";

test("PROJECT_ROOT is the real path of the project, without a trailing separator", () => {
  assert.ok(existsSync(join(PROJECT_ROOT, "package.json")));
  assert.equal(PROJECT_ROOT, realpathSync(PROJECT_ROOT));
  assert.ok(!PROJECT_ROOT.endsWith("/"));
  assert.equal(HARNESS_DIR, join(PROJECT_ROOT, "src/harness/child"));
  assert.equal(CONTRACTS_DIR, join(PROJECT_ROOT, "src/contracts"));
  assert.equal(FIXTURES_DIR, join(PROJECT_ROOT, "fixtures"));
});

test("[SAFE-06] resolveTarget returns the real path of a relative or symlinked directory", (t) => {
  const dir = tmpDir(t);
  mkdirSync(join(dir, "real"));
  symlinkSync(join(dir, "real"), join(dir, "link"));
  assert.equal(resolveTarget("link", dir), join(dir, "real"));
  assert.equal(resolveTarget(join(dir, "link")), join(dir, "real"));
});

test("resolveTarget of a missing path is TARGET_NOT_FOUND", (t) => {
  const dir = tmpDir(t);
  assert.throws(() => resolveTarget("nope", dir), { code: "TARGET_NOT_FOUND" });
});

test("resolveOutDir resolves through the nearest existing ancestor", (t) => {
  const dir = tmpDir(t);
  mkdirSync(join(dir, "real"));
  symlinkSync(join(dir, "real"), join(dir, "link"));
  assert.equal(resolveOutDir("link/a/b", dir), join(dir, "real/a/b"));
  assert.equal(resolveOutDir("link", dir), join(dir, "real"));
});

test("[RF-1] paths with a space resolve normally", (t) => {
  const dir = tmpDir(t);
  mkdirSync(join(dir, "with space", "legacy"), { recursive: true });
  assert.equal(resolveTarget("with space/legacy", dir), join(dir, "with space", "legacy"));
  assert.equal(resolveOutDir("with space/out dir", dir), join(dir, "with space", "out dir"));
});

test("isInsideOrEqual compares whole path segments", () => {
  assert.ok(isInsideOrEqual("/a/b", "/a/b"));
  assert.ok(isInsideOrEqual("/a/b/c", "/a/b"));
  assert.ok(!isInsideOrEqual("/a/bc", "/a/b"));
  assert.ok(!isInsideOrEqual("/a", "/a/b"));
  assert.ok(isInsideOrEqual("/a/b/..c", "/a/b"));
});

test("relativeToProject uses POSIX separators and ../ outside the project", () => {
  assert.equal(relativeToProject(join(PROJECT_ROOT, "fixtures", "legacy-billing")), "fixtures/legacy-billing");
  assert.equal(relativeToProject(PROJECT_ROOT), ".");
  assert.match(relativeToProject(join(PROJECT_ROOT, "..", "elsewhere")), /^\.\.\/elsewhere$/);
});
