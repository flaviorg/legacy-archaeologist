import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

// Real path of a fresh directory under os.tmpdir() (on macOS /var/... resolves to /private/var/...), removed after the test.
export function tmpDir(t: TestContext, prefix = "la-test-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Copies tests/fixtures/targets/<name> to <tmpDir>/<parentName ?? "">/<name> and returns its real path.
export function tmpTarget(t: TestContext, name: string, opts: { parentName?: string } = {}): string {
  const parent = join(tmpDir(t), opts.parentName ?? "");
  mkdirSync(parent, { recursive: true });
  const dest = join(parent, name);
  cpSync(join(PROJECT_ROOT, "tests/fixtures/targets", name), dest, { recursive: true, verbatimSymlinks: true });
  return realpathSync(dest);
}
