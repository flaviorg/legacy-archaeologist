import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";
import { readRepoFile } from "../helpers/repo-files.ts";

test("the vendored bytes matches VENDORED.md, is MIT and declares commonjs", () => {
  const sha = createHash("sha256").update(readFileSync(join(PROJECT_ROOT, "fixtures/third-party/bytes/index.js"))).digest("hex");
  const notes = readRepoFile("fixtures/third-party/bytes/VENDORED.md");
  assert.ok(notes.includes(sha), "VENDORED.md carries the sha256 of index.js");
  for (const fact of ["bytes", "3.1.2", "https://registry.npmjs.org/bytes/-/bytes-3.1.2.tgz", "MIT"]) assert.ok(notes.includes(fact), fact);
  assert.match(readRepoFile("fixtures/third-party/bytes/LICENSE"), /MIT License/);
  assert.deepEqual(JSON.parse(readRepoFile("fixtures/third-party/bytes/package.json")), { type: "commonjs" });
  const source = readRepoFile("fixtures/third-party/bytes/index.js");
  assert.equal(source.split("\n").length - 1, 170);
  assert.match(source, /^module\.exports = bytes;\nmodule\.exports\.format = format;\nmodule\.exports\.parse = parse;$/m);
});
