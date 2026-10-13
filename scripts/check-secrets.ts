// node scripts/check-secrets.ts (npm run check:secrets): scans the project tree for key-shaped strings with the same
// four patterns the redaction uses. Runs in the pre-commit hook and in CI. Never prints a matched value: only the
// path, the line and the pattern name. Git is consulted only to tell whether a local `.env` is tracked.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PROJECT_ROOT } from "../src/infra/paths.ts";
import { KEY_PATTERNS } from "../src/infra/redact.ts";

// Same order as KEY_PATTERNS: the OpenRouter and Anthropic shapes come before the generic `sk-` one, and a span
// matched by an earlier pattern is masked before the later ones run, so one key is reported once.
const PATTERN_NAMES = ["OpenRouter key", "Anthropic key", "sk- key", "Google API key"] as const;

export type Finding = { path: string; line: number; pattern: string };

export function scanText(text: string, path: string): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((content, i) => {
    let rest = content;
    KEY_PATTERNS.forEach((re, k) => {
      rest = rest.replace(new RegExp(re.source, "g"), (match) => {
        out.push({ path, line: i + 1, pattern: PATTERN_NAMES[k] ?? "key" });
        return " ".repeat(match.length);
      });
    });
  });
  return out;
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", "artifacts", "coverage"]);

export type ScanOptions = { isTracked?: (rel: string) => boolean };

function trackedByGit(root: string, rel: string): boolean {
  return spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: root, stdio: "ignore" }).status === 0;
}

/**
 * Every file under `root` except the skipped directories, in a stable order. A local `.env` (ignored by Git, where
 * the README tells people to put a real key) is scanned only when Git tracks it.
 */
export function listScannedFiles(root: string, opts: ScanOptions = {}): string[] {
  const isTracked = opts.isTracked ?? ((rel: string) => trackedByGit(root, rel));
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) {
        if (!SKIPPED_DIRS.has(name)) walk(path);
      } else if (st.isFile()) {
        if (name === ".env" && !isTracked(relative(root, path).split(sep).join("/"))) continue;
        out.push(path);
      }
    }
  };
  walk(root);
  return out;
}

function readText(path: string): string | null {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 8192).includes(0)) return null;
  return bytes.toString("utf8");
}

export function scanTree(root: string, opts: ScanOptions = {}): Finding[] {
  const findings: Finding[] = [];
  for (const path of listScannedFiles(root, opts)) {
    const rel = relative(root, path).split(sep).join("/");
    if (rel === ".env" || rel.endsWith("/.env")) findings.push({ path: rel, line: 0, pattern: "tracked .env file" });
    const text = readText(path);
    if (text !== null) findings.push(...scanText(text, rel));
  }
  return findings;
}

if (import.meta.main) {
  const files = listScannedFiles(PROJECT_ROOT);
  const findings = scanTree(PROJECT_ROOT);
  if (findings.length === 0) {
    process.stdout.write(`check:secrets: ${files.length.toLocaleString("en-US")} files scanned, 0 findings\n`);
  } else {
    for (const f of findings) process.stderr.write(`${f.path}:${f.line} ${f.pattern}\n`);
    process.stderr.write(`check:secrets: ${findings.length.toLocaleString("en-US")} findings\n`);
    process.exitCode = 1;
  }
}
