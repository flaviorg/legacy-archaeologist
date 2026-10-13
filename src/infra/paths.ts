import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LaError } from "./errors.ts";

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

export const PROJECT_ROOT: string = stripTrailingSep(realpathSync(fileURLToPath(new URL("../../", import.meta.url))));
export const HARNESS_DIR: string = join(PROJECT_ROOT, "src", "harness", "child");
export const CONTRACTS_DIR: string = join(PROJECT_ROOT, "src", "contracts");
export const FIXTURES_DIR: string = join(PROJECT_ROOT, "fixtures");
export const ARTIFACTS_DIR: string = join(PROJECT_ROOT, "artifacts");

// The user's --target as a real path (what gets granted, staged, logged and used as cwd).
export function resolveTarget(userPath: string, cwd: string = process.cwd()): string {
  const abs = resolve(cwd, userPath);
  if (!existsSync(abs)) throw new LaError("TARGET_NOT_FOUND", `target not found: ${userPath}`);
  return realpathSync(abs);
}

// The real path of the nearest existing ancestor joined with the rest (the --out directory may not exist yet).
export function resolveOutDir(userPath: string, cwd: string = process.cwd()): string {
  let existing = resolve(cwd, userPath);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

export function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + sep);
}

// Project-relative path with POSIX separators ("../x" outside the project); "." for the root itself.
export function relativeToProject(realPath: string): string {
  const rel = relative(PROJECT_ROOT, realPath);
  return rel === "" ? "." : rel.split(sep).join("/");
}
