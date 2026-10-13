// Side-effect sources (spec 5.1), magic numbers, module numeric constants and module state use, by identifier and
// member patterns and require/import names. Scope decides whether `Date` or `console` is the global or a local.
import * as walk from "acorn-walk";
import type { AnyNode, Node, Pattern, Program, Super } from "acorn";
import type { MagicNumber, SideEffect, SideEffectKind } from "../contracts/map.ts";
import { classifyIdentifier, patternNames } from "./scope.ts";
import type { ScopeInfo } from "./scope.ts";

type EnclosingOf = (pos: number) => readonly Node[];

// Module names (without `node:`) whose use is a side effect, and their kind.
const MODULE_KINDS: Readonly<Record<string, SideEffectKind>> = {
  fs: "fs",
  "fs/promises": "fs",
  child_process: "child_process",
  net: "net",
  tls: "net",
  dgram: "net",
  http: "http",
  https: "http",
  http2: "http",
  dns: "dns",
  "dns/promises": "dns",
  crypto: "crypto",
  timers: "timers",
  "timers/promises": "timers",
};

const TIMER_FUNCTIONS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const GLOBAL_OBJECTS = new Set(["global", "globalThis", "window"]);

function stripNode(spec: string): string {
  return spec.startsWith("node:") ? spec.slice(5) : spec;
}

// `require("x")` with one string literal argument → "x".
export function requireSpecifier(node: AnyNode | null | undefined): string | null {
  if (!node || node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "require") return null;
  const arg = node.arguments[0];
  return arg && arg.type === "Literal" && typeof arg.value === "string" ? arg.value : null;
}

function propName(node: AnyNode): string | null {
  if (node.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") return node.property.value;
  return null;
}

/**
 * Local name → module name (`node:` stripped) for `var fs = require("fs")`, `var r = require("fs").readFileSync`,
 * `const { readFileSync: r } = require("node:fs")` (member alias recorded as `fs.readFileSync`), and ESM namespace,
 * default and named imports. Scoping is not tracked: an alias declared inside a function counts everywhere.
 */
export function requireAliases(program: Program): Map<string, string> {
  const out = new Map<string, string>();
  walk.simple(program, {
    VariableDeclarator(node) {
      const init = node.init as AnyNode | null | undefined;
      let spec = requireSpecifier(init);
      let member: string | null = null;
      if (spec === null && init && init.type === "MemberExpression") {
        spec = requireSpecifier(init.object);
        member = propName(init);
      }
      if (spec === null) return;
      const mod = stripNode(spec);
      if (node.id.type === "Identifier") out.set(node.id.name, member ? `${mod}.${member}` : mod);
      else if (node.id.type === "ObjectPattern" && member === null) {
        for (const p of node.id.properties) {
          if (p.type !== "Property" || p.computed) continue;
          const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : null;
          const local = p.value.type === "Identifier" ? p.value.name : p.value.type === "AssignmentPattern" && p.value.left.type === "Identifier" ? p.value.left.name : null;
          if (key !== null && local !== null) out.set(local, `${mod}.${key}`);
        }
      }
    },
    ImportDeclaration(node) {
      const mod = stripNode(String(node.source.value));
      for (const s of node.specifiers) {
        if (s.type === "ImportSpecifier") {
          const imported = s.imported.type === "Identifier" ? s.imported.name : String(s.imported.value);
          out.set(s.local.name, imported === "default" ? mod : `${mod}.${imported}`);
        } else {
          out.set(s.local.name, mod);
        }
      }
    },
  });
  return out;
}

function kindOfAlias(alias: string): SideEffectKind | null {
  const dot = alias.indexOf(".");
  return MODULE_KINDS[dot === -1 ? alias : alias.slice(0, dot)] ?? null;
}

// The identifier at the root of a member chain (`a` in `a.b[c].d`), or null.
function memberRoot(node: AnyNode): { root: AnyNode; first: AnyNode } | null {
  let first = node;
  let cur: AnyNode | Super = node;
  while (cur.type === "MemberExpression") {
    first = cur;
    cur = cur.object;
  }
  return cur.type === "Identifier" ? { root: cur, first } : null;
}

type Found = SideEffect & { pos: number };

/**
 * One entry per occurrence, ordered by position: `Date` (the global used as callee, `new` target or member object),
 * `Math.random`, `performance.now`, `process.hrtime`, the env object of `process`, `crypto` (the global or an alias),
 * module aliases of fs, child_process, net, http (also https, http2), dns, `console`, timers, `Intl`, `global-write`
 * (a member of `global`/`globalThis`/`window`, or an undeclared identifier) and `module-state-write` (an identifier
 * or member root bound at module level). Nested functions inside `fn` count as part of it.
 */
export function detectSideEffects(fn: Node, scope: ScopeInfo, aliases: Map<string, string>, enclosingOf: EnclosingOf): SideEffect[] {
  const found: Found[] = [];
  const classOf = (name: string, pos: number) => classifyIdentifier(scope, name, { pos, enclosing: enclosingOf(pos) });
  const isGlobal = (node: AnyNode): boolean => node.type === "Identifier" && classOf(node.name, node.start) === "global";
  const add = (kind: SideEffectKind, node: Node, detail: string, line = node.loc!.start.line): void => {
    found.push({ kind, line, detail, pos: node.start });
  };

  const writeTarget = (target: AnyNode, at: Node): void => {
    if (target.type === "Identifier") {
      const cls = classOf(target.name, target.start);
      if (cls === "module") add("module-state-write", at, target.name);
      else if (cls === "global") add("global-write", at, target.name);
      return;
    }
    if (target.type === "MemberExpression") {
      const r = memberRoot(target);
      if (!r || r.root.type !== "Identifier") return;
      const cls = classOf(r.root.name, r.root.start);
      if (cls === "global" && GLOBAL_OBJECTS.has(r.root.name)) add("global-write", at, propName(r.first) ?? "[computed]");
      else if (cls === "module") add("module-state-write", at, r.root.name);
      return;
    }
    if (target.type === "ObjectPattern" || target.type === "ArrayPattern") {
      for (const name of patternNames(target as Pattern)) {
        const cls = classOf(name, target.start);
        if (cls === "module") add("module-state-write", at, name);
        else if (cls === "global") add("global-write", at, name);
      }
    }
  };

  walk.simple(fn, {
    MemberExpression(node) {
      const prop = propName(node) ?? "[computed]";
      const obj = node.object as AnyNode;
      const spec = requireSpecifier(obj);
      if (spec !== null) {
        const mod = stripNode(spec);
        const kind = kindOfAlias(mod);
        if (kind) add(kind, node, `${mod}.${prop}`);
        return;
      }
      if (obj.type !== "Identifier") return;
      const alias = aliases.get(obj.name);
      if (alias !== undefined) {
        const kind = kindOfAlias(alias);
        if (kind) add(kind, node, `${alias}.${prop}`);
        return;
      }
      if (!isGlobal(obj)) return;
      switch (obj.name) {
        case "Date":
          add("Date", node, `Date.${prop}`);
          break;
        case "Math":
          if (prop === "random") add("Math.random", node, "Math.random");
          break;
        case "performance":
          if (prop === "now") add("performance.now", node, "performance.now");
          break;
        case "process":
          if (prop === "hrtime") add("process.hrtime", node, "process.hrtime");
          else if (prop === "env") add("process.env", node, "process.env");
          break;
        case "crypto":
          add("crypto", node, `crypto.${prop}`);
          break;
        case "console":
          add("console", node, `console.${prop}`);
          break;
        case "Intl":
          add("Intl", node, `Intl.${prop}`);
          break;
        default:
          if (GLOBAL_OBJECTS.has(obj.name)) {
            if (prop === "crypto") add("crypto", node, `${obj.name}.crypto`);
            else if (TIMER_FUNCTIONS.has(prop)) add("timers", node, `${obj.name}.${prop}`);
          }
      }
    },
    CallExpression(node) {
      const callee = node.callee as AnyNode;
      if (callee.type !== "Identifier") return;
      const alias = aliases.get(callee.name);
      if (alias !== undefined) {
        const kind = kindOfAlias(alias);
        if (kind) add(kind, node, alias);
        return;
      }
      if (!isGlobal(callee)) return;
      if (TIMER_FUNCTIONS.has(callee.name)) add("timers", node, callee.name);
      else if (callee.name === "Date") add("Date", node, "Date()");
    },
    NewExpression(node) {
      const callee = node.callee as AnyNode;
      if (callee.type === "Identifier" && callee.name === "Date" && isGlobal(callee)) add("Date", node, "new Date");
    },
    AssignmentExpression(node) {
      writeTarget(node.left as AnyNode, node);
    },
    UpdateExpression(node) {
      writeTarget(node.argument as AnyNode, node);
    },
  });

  return found
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.pos - b.f.pos || a.i - b.i)
    .map(({ f }) => ({ kind: f.kind, line: f.line, detail: f.detail }));
}

function numericValue(node: AnyNode | null | undefined): number | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "number") return node.value;
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") return -node.argument.value;
  return null;
}

type ConstantDecl = { range: [number, number]; entries: { name: string; value: number; line: number }[] };

function constantDeclarations(program: Program): ConstantDecl[] {
  const out: ConstantDecl[] = [];
  for (const stmt of program.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (!decl || decl.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (d.id.type !== "Identifier" || !d.init) continue;
      const name = d.id.name;
      const init = d.init as AnyNode;
      const direct = numericValue(init);
      if (direct !== null) {
        out.push({ range: [d.start, d.end], entries: [{ name, value: direct, line: init.loc!.start.line }] });
        continue;
      }
      if (init.type !== "ObjectExpression" || init.properties.length === 0) continue;
      const entries: ConstantDecl["entries"] = [];
      let all = true;
      for (const p of init.properties) {
        const value = p.type === "Property" && !p.computed ? numericValue(p.value as AnyNode) : null;
        const key = p.type === "Property" && !p.computed ? (p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : null) : null;
        if (value === null || key === null) {
          all = false;
          break;
        }
        entries.push({ name: `${name}.${key}`, value, line: p.loc!.start.line });
      }
      if (all) out.push({ range: [d.start, d.end], entries });
    }
  }
  return out;
}

// Module-level declarators initialized with a number (or `-number`) or an object of numbers, as `NAME` or `NAME.key`.
export function moduleNumericConstants(program: Program): { name: string; value: number; line: number }[] {
  return constantDeclarations(program).flatMap((d) => d.entries);
}

export function moduleConstantRanges(program: Program): [number, number][] {
  return constantDeclarations(program).map((d) => d.range);
}

// Numeric literals other than 0 and 1 outside module-level constant declarations; column is 1-based (UTF-16 units).
export function magicNumbers(fn: Node, moduleConstantRanges: readonly [number, number][]): MagicNumber[] {
  const out: (MagicNumber & { pos: number })[] = [];
  walk.simple(fn, {
    Literal(node) {
      if (typeof node.value !== "number" || node.value === 0 || node.value === 1) return;
      if (moduleConstantRanges.some(([s, e]) => node.start >= s && node.start < e)) return;
      out.push({ value: node.value, line: node.loc!.start.line, column: node.loc!.start.column + 1, pos: node.start });
    },
  });
  return out.sort((a, b) => a.pos - b.pos).map(({ value, line, column }) => ({ value, line, column }));
}

const STATE_KINDS = new Set(["var", "let", "const"]);

// Module-level variable bindings (not functions, classes or imports) read and written by `fn`, and globals it writes.
export function moduleStateUse(fn: Node, scope: ScopeInfo, enclosingOf: EnclosingOf): { reads: string[]; writes: string[]; globalsWritten: string[] } {
  const reads = new Set<string>();
  const isState = (name: string, pos: number): boolean => {
    const b = scope.moduleBindings.get(name);
    return !!b && STATE_KINDS.has(b.kind) && !b.functionValued && classifyIdentifier(scope, name, { pos, enclosing: enclosingOf(pos) }) === "module";
  };
  walk.simple(fn, {
    Identifier(node) {
      if (isState(node.name, node.start)) reads.add(node.name);
    },
  });
  const writes = new Set<string>();
  const globalsWritten = new Set<string>();
  for (const e of detectSideEffects(fn, scope, new Map(), enclosingOf)) {
    if (e.kind === "module-state-write") {
      const b = scope.moduleBindings.get(e.detail);
      if (b && STATE_KINDS.has(b.kind)) writes.add(e.detail);
    } else if (e.kind === "global-write") {
      globalsWritten.add(e.detail);
    }
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return { reads: sorted(reads), writes: sorted(writes), globalsWritten: sorted(globalsWritten) };
}

