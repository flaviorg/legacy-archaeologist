// The one listing of a target directory, shared by the map stage and the stage copy (spec 4.2).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Any entry whose name starts with "." (.git, .cache, .env, .npmrc, .netrc, .DS_Store) is never listed, so it is not
// mapped, staged, hashed into targetSha or readable by the child; node_modules is not entered either.
const EXCLUDED = (name: string): boolean => name.startsWith(".");

export type TargetEntry = { relPath: string; absPath: string; size: number; isSymlink: boolean };

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Files and symlinks under `root` (lstat, symlinks never followed), with POSIX `relPath`, sorted by `relPath`.
 * Dot-entries (files, directories and symlinks whose name starts with `.`) are skipped and `node_modules` is not entered.
 */
export function walkTarget(root: string): TargetEntry[] {
  const out: TargetEntry[] = [];
  const visit = (absDir: string, relDir: string): void => {
    for (const name of readdirSync(absDir)) {
      if (EXCLUDED(name)) continue;
      const absPath = join(absDir, name);
      const relPath = relDir === "" ? name : `${relDir}/${name}`;
      const st = lstatSync(absPath);
      if (st.isSymbolicLink()) out.push({ relPath, absPath, size: st.size, isSymlink: true });
      else if (st.isDirectory()) {
        if (name !== "node_modules") visit(absPath, relPath);
      } else if (st.isFile()) out.push({ relPath, absPath, size: st.size, isSymlink: false });
    }
  };
  visit(root, "");
  return out.sort((a, b) => byCodeUnits(a.relPath, b.relPath));
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// "sha256:" + SHA-256 over the files sorted by relPath, each as relPath + "\0" + bytes (spec 5.1).
export function computeTargetSha(files: readonly { relPath: string; bytes: Buffer }[]): string {
  const hash = createHash("sha256");
  for (const f of [...files].sort((a, b) => byCodeUnits(a.relPath, b.relPath))) {
    hash.update(f.relPath);
    hash.update("\0");
    hash.update(f.bytes);
  }
  return "sha256:" + hash.digest("hex");
}

// The nearest package.json walking up from `dir`: "module" when its type is "module", otherwise (or when none) "commonjs".
export function resolveModuleType(dir: string): "commonjs" | "module" {
  let cur = dir;
  for (;;) {
    const pkg = join(cur, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { type?: unknown };
        return parsed.type === "module" ? "module" : "commonjs";
      } catch {
        return "commonjs";
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return "commonjs";
    cur = parent;
  }
}
