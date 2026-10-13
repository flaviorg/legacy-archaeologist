// Map stage: reads the target's JS files, builds the static map, applies --only and writes <out>/map.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { MAX_EXPORTED_FUNCTIONS, SIDE_EFFECT_KINDS } from "../contracts/map.ts";
import type { StaticMap } from "../contracts/map.ts";
import { writeJsonText } from "../contracts/stable-json.ts";
import { buildMap, restrictMap } from "../static/map.ts";
import { LaError } from "../infra/errors.ts";
import type { Logger } from "../infra/logger.ts";
import { relativeToProject } from "../infra/paths.ts";
import { computeTargetSha, resolveModuleType, sha256Hex, walkTarget } from "../infra/target-files.ts";
import { TOOL_INFO } from "../infra/version.ts";

const JS_FILE = /\.(js|cjs|mjs)$/;
const MAX_LISTED = 10;

function listNames(names: readonly string[]): string {
  return names.length <= MAX_LISTED ? names.join(", ") : `${names.slice(0, MAX_LISTED).join(", ")} and ${names.length - MAX_LISTED} more`;
}

// --only entries match a function ID (`billing.js#applyDiscount`) or a bare function name (`applyDiscount`).
function selectOnly(map: StaticMap, only: readonly string[]): Set<string> {
  const fns = map.modules.flatMap((m) => m.functions);
  const keep = new Set<string>();
  const unknown: string[] = [];
  for (const wanted of only) {
    const hits = fns.filter((f) => f.id === wanted || f.name === wanted);
    if (hits.length === 0) unknown.push(wanted);
    for (const f of hits) keep.add(f.id);
  }
  if (unknown.length > 0) throw new LaError("USAGE", `--only names unknown functions: ${listNames(unknown)} (exported: ${listNames(fns.map((f) => f.id))})`);
  return keep;
}

// allFunctionIds lists every exported function before --only, so a fake fixture's drift check sees the whole target.
export function runMapStage(opts: { targetReal: string; outDir: string; only?: readonly string[]; logger: Logger }): { map: StaticMap; files: { path: string; text: string }[]; allFunctionIds: string[] } {
  const started = performance.now();
  opts.logger.info("stage_start", { stage: "map", target: opts.targetReal });
  const entries = walkTarget(opts.targetReal);
  const symlink = entries.find((e) => e.isSymlink);
  if (symlink) throw new LaError("TARGET_SYMLINK", `${symlink.relPath} is a symlink inside the target; v1 refuses symlinks in the walked tree`);

  const read = entries.map((e) => ({ relPath: e.relPath, bytes: readFileSync(e.absPath) }));
  const targetSha = computeTargetSha(read);
  const js = read.filter((f) => JS_FILE.test(f.relPath));
  if (js.length === 0) throw new LaError("NO_FUNCTIONS", "no .js, .cjs or .mjs file found (TypeScript input is not supported in v1)");

  const files = js.map((f) => ({ path: f.relPath, text: f.bytes.toString("utf8") }));
  const fileSha256 = Object.fromEntries(js.map((f) => [f.relPath, sha256Hex(f.bytes)]));
  let map = buildMap(files, resolveModuleType(opts.targetReal), { targetDir: relativeToProject(opts.targetReal), targetSha, builtinModules, fileSha256, tool: TOOL_INFO });

  if (map.stats.parsedFiles === 0) {
    const first = map.files[0]!;
    throw new LaError("PARSE_FAILED", `no file could be parsed (${first.path}: ${first.error ?? "parse error"}${map.files.length > 1 ? `; ${map.files.length - 1} more` : ""})`);
  }
  const total = map.modules.reduce((n, m) => n + m.functions.length, 0);
  const allFunctionIds = map.modules.flatMap((m) => m.functions.map((f) => f.id));
  if (opts.only && opts.only.length > 0) map = restrictMap(map, selectOnly(map, opts.only));
  else if (total > MAX_EXPORTED_FUNCTIONS) throw new LaError("TOO_MANY_FUNCTIONS", `${total} exported functions (limit ${MAX_EXPORTED_FUNCTIONS}); pick some with --only`);
  if (map.modules.every((m) => m.functions.length === 0)) {
    const values = map.modules.flatMap((m) => m.exports.map((e) => `${m.file}:${e.name}`));
    throw new LaError("NO_FUNCTIONS", `no exported function found in ${map.stats.parsedFiles} parsed file(s)${values.length > 0 ? `; exported values: ${listNames(values)}` : ""}`);
  }

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "map.json"), writeJsonText(map));
  opts.logger.info("stage_done", {
    stage: "map",
    durationMs: Math.round(performance.now() - started),
    files: map.stats.files,
    parsedFiles: map.stats.parsedFiles,
    exportedFunctions: map.modules.reduce((n, m) => n + m.functions.length, 0),
  });
  return { map, files, allFunctionIds };
}

// The CLI's one-line summary of a map (counts in en-US format).
export function formatMapSummary(map: StaticMap): string {
  const fns = map.modules.flatMap((m) => m.functions);
  const count = (n: number) => n.toLocaleString("en-US");
  const nameCounts = new Map<string, number>();
  for (const f of fns) nameCounts.set(f.name, (nameCounts.get(f.name) ?? 0) + 1);
  const label = (id: string): string => {
    const f = fns.find((x) => x.id === id);
    return f && nameCounts.get(f.name) === 1 ? f.name : id;
  };
  const hotspots = map.hotspots.map((h) => `${label(h.functionId)} (${h.complexity})`).join(", ") || "none";
  const effects = SIDE_EFFECT_KINDS.filter((k) => map.stats.sideEffects[k] > 0).map((k) => `${k} ×${count(map.stats.sideEffects[k])}`).join(", ") || "none";
  const callbacks = fns.filter((f) => f.style === "callback").length;
  return `map: ${count(fns.length)} exported function${fns.length === 1 ? "" : "s"} · ${count(callbacks)} callback-style · hotspots: ${hotspots} · side effects: ${effects} · unresolved calls: ${count(map.stats.unresolvedCalls)}`;
}
