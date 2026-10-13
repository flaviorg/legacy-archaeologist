// Golden files under tests/golden/: written by code with UPDATE_GOLDEN=1 (npm run regen), otherwise compared byte for
// byte. Never typed by hand.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

export const GOLDEN_DIR = join(PROJECT_ROOT, "tests", "golden");

export function assertGoldenText(actual: string, goldenRel: string): void {
  const path = join(GOLDEN_DIR, ...goldenRel.split("/"));
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  const expected = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (expected !== actual) assert.fail(`GOLDEN_MISMATCH: ${goldenRel} (run npm run regen and review the diff)`);
}

/** actualPath is absolute or relative to the project root. */
export function assertGoldenFile(actualPath: string, goldenRel: string): void {
  assertGoldenText(readFileSync(isAbsolute(actualPath) ? actualPath : join(PROJECT_ROOT, actualPath), "utf8"), goldenRel);
}
