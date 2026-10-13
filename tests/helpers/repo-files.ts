// Scanners for tests/unit/conventions.unit.test.ts (dependency rules, pending markers, repository checks).
import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "artifacts", "coverage"]);
const SKIP_ROOT_DIRS = new Set(["private"]);
const TEXT_EXTENSIONS = new Set([".ts", ".mts", ".js", ".cjs", ".mjs", ".json", ".jsonl", ".md", ".yml", ".yaml", ".txt", ".mmd"]);
const TEXT_NAMES = new Set([".env.example", ".npmrc", ".nvmrc", ".gitignore", "LICENSE"]);

function isTextFile(rel: string): boolean {
  const name = posix.basename(rel);
  if (TEXT_NAMES.has(name)) return true;
  if (rel.startsWith(".githooks/")) return true;
  return TEXT_EXTENSIONS.has(posix.extname(name));
}

function walk(relDir: string, out: string[]): void {
  const entries = readdirSync(join(PROJECT_ROOT, relDir), { withFileTypes: true });
  for (const entry of entries) {
    const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (relDir === "" && SKIP_ROOT_DIRS.has(entry.name)) continue;
      walk(rel, out);
    } else if (entry.isFile() && isTextFile(rel)) {
      out.push(rel);
    }
  }
}

// POSIX paths relative to PROJECT_ROOT, sorted; symlinks are not followed.
export function listRepoFiles(): string[] {
  const out: string[] = [];
  walk("", out);
  return out.sort();
}

export function readRepoFile(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8");
}

export type ImportSpecifier = { spec: string; typeOnly: boolean };

// The clause between the keyword and `from` holds no quote, semicolon, parenthesis or `=`, so a declaration such as
// `export const x = ...` never pairs with a later `from "..."`.
const STATIC_RE = /\b(import|export)\s+(type\s+)?[^;"'`()=]*?\bfrom\s*(["'])([^"'\n]+)\3/g;
const SIDE_EFFECT_RE = /\bimport\s*(["'])([^"'\n]+)\1/g;
const DYNAMIC_RE = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

// Static `import ... from`, `export ... from`, side-effect `import "x"` and `import("x")` with a literal, in source order.
export function importSpecifiers(source: string): ImportSpecifier[] {
  const found: { index: number; spec: string; typeOnly: boolean }[] = [];
  for (const m of source.matchAll(STATIC_RE)) found.push({ index: m.index, spec: m[4] as string, typeOnly: m[2] !== undefined });
  for (const m of source.matchAll(SIDE_EFFECT_RE)) found.push({ index: m.index, spec: m[2] as string, typeOnly: false });
  for (const m of source.matchAll(DYNAMIC_RE)) found.push({ index: m.index, spec: m[2] as string, typeOnly: false });
  return found.sort((a, b) => a.index - b.index).map(({ spec, typeOnly }) => ({ spec, typeOnly }));
}

// Relative specifiers become repo-relative POSIX paths; bare and node: specifiers are returned unchanged.
export function resolveImport(fromRel: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  return posix.normalize(posix.join(posix.dirname(fromRel), spec));
}

// The literal first argument of every test(...) call in `source` (quotes removed, escapes kept as written).
export function testNames(source: string): string[] {
  return [...source.matchAll(/\btest\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]!);
}
