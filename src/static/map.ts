// buildMap: a pure function of file contents (MAP-07). Files sorted by path, functions by position.
import * as walk from "acorn-walk";
import type { AnyNode, Node, Program } from "acorn";
import { LLM_SOURCE_LIMIT_BYTES, SIDE_EFFECT_KINDS } from "../contracts/map.ts";
import type { FileInfo, FunctionInfo, ModuleInfo, SideEffectKind, StaticMap, ToolInfo } from "../contracts/map.ts";
import { parseSource } from "./parser.ts";
import { buildScope, classifyIdentifier, enclosingFunctionsOf, functionNodes } from "./scope.ts";
import type { FunctionNode, ScopeInfo } from "./scope.ts";
import { findExports, paramNames } from "./exports.ts";
import { detectSideEffects, magicNumbers, moduleConstantRanges, moduleStateUse, requireAliases, requireSpecifier } from "./side-effects.ts";
import { listCalls, moduleFunctionIds } from "./calls.ts";
import { cyclomatic, topHotspots } from "./complexity.ts";

// Plan delta 6, plus `tool` (src/static may not import src/infra/version.ts).
export type BuildMapMeta = {
  targetDir: string;
  targetSha: string;
  builtinModules: readonly string[];
  fileSha256: Readonly<Record<string, string>>;
  tool: ToolInfo;
};

const ENCODER = new TextEncoder();
const utf8Length = (s: string): number => ENCODER.encode(s).length;
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// POSIX normalization by hand (src/static may not import node:path); a leading ".." is kept.
function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.length === 0 ? "." : out.join("/");
}

function dirOf(file: string): string {
  const i = file.lastIndexOf("/");
  return i === -1 ? "." : file.slice(0, i);
}

function isExternal(spec: string, file: string, builtins: ReadonlySet<string>): boolean {
  if (spec.startsWith("node:") || builtins.has(spec) || builtins.has("node:" + spec)) return false;
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    const joined = normalizePosix(`${dirOf(file)}/${spec}`);
    return joined === ".." || joined.startsWith("../");
  }
  return true; // a bare package name or an absolute path
}

function literalSource(node: AnyNode | null | undefined): string | null {
  return node && node.type === "Literal" && typeof node.value === "string" ? node.value : null;
}

// Literal require()/import/export-from/import() specifiers that name a package or leave the target folder; sorted, unique.
export function externalSpecifiers(program: Program, file: string, builtins: ReadonlySet<string>): string[] {
  const specs = new Set<string>();
  const add = (s: string | null): void => {
    if (s !== null && isExternal(s, file, builtins)) specs.add(s);
  };
  walk.simple(program, {
    CallExpression(node) {
      add(requireSpecifier(node));
    },
    ImportDeclaration(node) {
      add(literalSource(node.source));
    },
    ExportNamedDeclaration(node) {
      add(literalSource(node.source));
    },
    ExportAllDeclaration(node) {
      add(literalSource(node.source));
    },
    ImportExpression(node) {
      add(literalSource(node.source as AnyNode));
    },
  });
  return [...specs].sort(byCodeUnits);
}

// The last param, when it is a plain identifier invoked as a function (directly, or with .call/.apply) inside the body.
function callbackParamOf(fn: FunctionNode): string | null {
  const last = fn.params[fn.params.length - 1];
  if (!last || last.type !== "Identifier") return null;
  const name = last.name;
  let invoked = false;
  walk.simple(fn.body, {
    CallExpression(node) {
      const callee = node.callee as AnyNode;
      if (callee.type === "Identifier" && callee.name === name) invoked = true;
      else if (callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" && callee.object.name === name && callee.property.type === "Identifier" && (callee.property.name === "call" || callee.property.name === "apply")) invoked = true;
    },
  });
  return invoked ? name : null;
}

// Identifier reads and assignment targets classified `unresolved` (inside a with body, or any in a file with direct eval).
function countUnresolved(program: Program, scope: ScopeInfo, enclosingOf: (pos: number) => readonly Node[]): number {
  if (!scope.hasDirectEval && scope.withRanges.length === 0) return 0;
  let n = 0;
  const check = (name: string, pos: number): void => {
    if (classifyIdentifier(scope, name, { pos, enclosing: enclosingOf(pos) }) === "unresolved") n++;
  };
  walk.simple(program, {
    Identifier(node) {
      check(node.name, node.start);
    },
    AssignmentExpression(node) {
      const left = node.left as AnyNode;
      if (left.type === "Identifier") check(left.name, left.start);
    },
  });
  return n;
}

type ModuleResult = { file: FileInfo; module: ModuleInfo; functionCount: number; unresolvedIdentifiers: number };

function moduleKindOf(path: string, moduleKind: "commonjs" | "module"): "cjs" | "esm" {
  if (path.endsWith(".mjs")) return "esm";
  if (path.endsWith(".cjs")) return "cjs";
  return moduleKind === "module" ? "esm" : "cjs";
}

function analyzeFile(input: { path: string; text: string }, moduleKind: "commonjs" | "module", meta: BuildMapMeta, builtins: ReadonlySet<string>): ModuleResult {
  const { path, text } = input;
  const parsed = parseSource(path, text);
  const base = { path, bytes: utf8Length(text), sha256: meta.fileSha256[path] ?? "" };
  if (!parsed.program) {
    return {
      file: { ...base, parse: "error", error: parsed.error ?? "parse failed" },
      module: { file: path, kind: "unknown", exports: [], externalSpecifiers: [], moduleState: [], functions: [] },
      functionCount: 0,
      unresolvedIdentifiers: 0,
    };
  }
  const program = parsed.program;
  const scope = buildScope(program);
  const enclosingOf = enclosingFunctionsOf(program);
  const aliases = requireAliases(program);
  const fnIds = moduleFunctionIds(program, path);
  const constRanges = moduleConstantRanges(program);
  const found = findExports(parsed, scope);

  const functions: FunctionInfo[] = found.functions.map((ef) => {
    const node = ef.node;
    const callbackParam = callbackParamOf(node);
    const state = moduleStateUse(node, scope, enclosingOf);
    const sourceBytes = utf8Length(text.slice(node.start, node.end));
    return {
      id: ef.functionId,
      name: ef.name,
      exported: true,
      exportName: ef.exportName,
      params: paramNames(node, text),
      callbackParam,
      style: callbackParam ? "callback" : "sync",
      loc: { startLine: node.loc!.start.line, endLine: node.loc!.end.line },
      range: [node.start, node.end],
      complexity: cyclomatic(node),
      sideEffects: detectSideEffects(node, scope, aliases, enclosingOf),
      calls: listCalls(node, fnIds),
      magicNumbers: magicNumbers(node, constRanges),
      readsModuleState: state.reads,
      writesModuleState: state.writes,
      writesGlobals: state.globalsWritten,
      sourceBytes,
      tooLargeForLlm: sourceBytes > LLM_SOURCE_LIMIT_BYTES,
    };
  });

  const allFns = functionNodes(program);
  const written = new Set<string>();
  for (const fn of allFns) for (const name of moduleStateUse(fn, scope, enclosingOf).writes) written.add(name);
  const moduleState: ModuleInfo["moduleState"] = [];
  for (const name of written) {
    const b = scope.moduleBindings.get(name);
    if (b && (b.kind === "var" || b.kind === "let" || b.kind === "const")) moduleState.push({ name, line: b.line, declaration: b.kind });
  }
  moduleState.sort((a, b) => a.line - b.line || byCodeUnits(a.name, b.name));

  return {
    file: { ...base, parse: "ok", sourceType: parsed.sourceType ?? "script" },
    module: {
      file: path,
      kind: moduleKindOf(path, moduleKind),
      exports: found.exports,
      externalSpecifiers: externalSpecifiers(program, path, builtins),
      moduleState,
      functions,
    },
    functionCount: allFns.length,
    unresolvedIdentifiers: countUnresolved(program, scope, enclosingOf),
  };
}

function functionStats(modules: readonly ModuleInfo[]): { hotspots: StaticMap["hotspots"]; exportedFunctions: number; unresolvedCalls: number; sideEffects: Record<SideEffectKind, number> } {
  const fns = modules.flatMap((m) => m.functions);
  const sideEffects = Object.fromEntries(SIDE_EFFECT_KINDS.map((k) => [k, 0])) as Record<SideEffectKind, number>;
  for (const f of fns) for (const e of f.sideEffects) sideEffects[e.kind]++;
  return {
    hotspots: topHotspots(fns.map((f) => ({ functionId: f.id, complexity: f.complexity }))),
    exportedFunctions: fns.filter((f) => f.exported).length,
    unresolvedCalls: fns.reduce((n, f) => n + f.calls.filter((c) => c.dynamic).length, 0),
    sideEffects,
  };
}

/**
 * Pure: the same contents in any order give the same map. `files[].bytes` is the UTF-8 length, `sha256` comes from
 * `meta.fileSha256`; `ModuleInfo.kind` comes from the extension (`.mjs`, `.cjs`) or `moduleKind` for `.js`, and is
 * `unknown` for a file that failed to parse. v1 lists exported functions only, so `exported` is always true.
 */
export function buildMap(files: readonly { path: string; text: string }[], moduleKind: "commonjs" | "module", meta: BuildMapMeta): StaticMap {
  const builtins = new Set(meta.builtinModules);
  const results = [...files].sort((a, b) => byCodeUnits(a.path, b.path)).map((f) => analyzeFile(f, moduleKind, meta, builtins));
  const modules = results.map((r) => r.module);
  const { hotspots, ...fnStats } = functionStats(modules);
  return {
    schemaVersion: 1,
    tool: { name: meta.tool.name, version: meta.tool.version },
    targetDir: meta.targetDir,
    targetSha: meta.targetSha,
    files: results.map((r) => r.file),
    modules,
    hotspots,
    stats: {
      files: results.length,
      parsedFiles: results.filter((r) => r.file.parse === "ok").length,
      functions: results.reduce((n, r) => n + r.functionCount, 0),
      exportedFunctions: fnStats.exportedFunctions,
      unresolvedCalls: fnStats.unresolvedCalls,
      unresolvedIdentifiers: results.reduce((n, r) => n + r.unresolvedIdentifiers, 0),
      sideEffects: fnStats.sideEffects,
    },
  };
}

// `--only`: keeps the selected functions (every export entry stays) and recomputes hotspots and function stats.
export function restrictMap(map: StaticMap, keep: ReadonlySet<string>): StaticMap {
  const modules = map.modules.map((m) => ({ ...m, functions: m.functions.filter((f) => keep.has(f.id)) }));
  const { hotspots, ...fnStats } = functionStats(modules);
  return { ...map, modules, hotspots, stats: { ...map.stats, ...fnStats } };
}
