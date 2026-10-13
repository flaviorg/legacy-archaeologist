// The staged copy of the target (spec 5.4): <out>/stage/original, granted to the child and used as its cwd.
import { copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STAGE_LIMITS } from "../contracts/limits.ts";
import { LaError } from "../infra/errors.ts";
import { computeTargetSha, resolveModuleType, walkTarget } from "../infra/target-files.ts";

export type StagedTarget = {
  root: string;          // <out>/stage
  dir: string;           // real path of <out>/stage/original
  moduleType: "commonjs" | "module";
  files: string[];       // POSIX paths relative to dir, as walked (the written package.json is not added)
  targetSha: string;
};

/**
 * Removes an existing <out>/stage, walks the target (node_modules and every dot-file or dot-directory skipped), refuses symlinks
 * and oversize trees, copies every walked file and writes <dir>/package.json with the type the target resolves to,
 * because under --permission the child cannot read an ancestor package.json outside its grant.
 */
export function stageTarget(opts: { targetReal: string; outDir: string }): StagedTarget {
  const root = join(opts.outDir, "stage");
  rmSync(root, { recursive: true, force: true });
  const entries = walkTarget(opts.targetReal);
  const symlink = entries.find((e) => e.isSymlink);
  if (symlink) throw new LaError("TARGET_SYMLINK", `${symlink.relPath} is a symbolic link`);
  const bytes = entries.reduce((n, e) => n + e.size, 0);
  if (entries.length > STAGE_LIMITS.maxFiles || bytes > STAGE_LIMITS.maxBytes) {
    throw new LaError("TARGET_TOO_LARGE", `${entries.length} files, ${bytes} bytes (limit ${STAGE_LIMITS.maxFiles} files, 2 MiB)`);
  }
  const original = join(root, "original");
  mkdirSync(original, { recursive: true });
  const read: { relPath: string; bytes: Buffer }[] = [];
  for (const e of entries) {
    const dest = join(original, ...e.relPath.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(e.absPath, dest);
    read.push({ relPath: e.relPath, bytes: readFileSync(dest) });
  }
  const moduleType = resolveModuleType(opts.targetReal);
  writeFileSync(join(original, "package.json"), JSON.stringify({ type: moduleType }) + "\n");
  return { root, dir: realpathSync(original), moduleType, files: entries.map((e) => e.relPath), targetSha: computeTargetSha(read) };
}
