// Finds exported functions in CommonJS and ESM shapes (spec 4.2, MAP-02).
import * as walk from "acorn-walk";
import type { AnyNode, Node, Pattern, Program, Property } from "acorn";
import type { ParsedFile } from "./parser.ts";
import { isFunctionNode } from "./scope.ts";
import type { FunctionNode, ScopeInfo } from "./scope.ts";

export type ExportEntry = { name: string; kind: "function" | "value"; functionId?: string };
export type ExportedFunction = { functionId: string; name: string; exportName: string; node: FunctionNode };
export type ExportsResult = { kind: "cjs" | "esm" | "unknown"; exports: ExportEntry[]; functions: ExportedFunction[] };

type FunctionTarget = { node: FunctionNode; declaredName: string | null };
type Candidate = { at: number; exportName: string; target: FunctionTarget | null };

// Module-level functions by the name module code uses for them: declarations, and declarators whose initializer is a function.
export function moduleFunctionTargets(program: Program): Map<string, FunctionTarget> {
  const out = new Map<string, FunctionTarget>();
  for (const stmt of program.body) {
    const decl = stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration" ? stmt.declaration : stmt;
    if (!decl) continue;
    if (decl.type === "FunctionDeclaration" && decl.id) {
      if (!out.has(decl.id.name)) out.set(decl.id.name, { node: decl, declaredName: decl.id.name });
    } else if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.id.type === "Identifier" && d.init && isFunctionNode(d.init) && !out.has(d.id.name)) out.set(d.id.name, { node: d.init as FunctionNode, declaredName: d.id.name });
      }
    }
  }
  return out;
}

function isIdent(node: AnyNode | null | undefined, name: string): boolean {
  return !!node && node.type === "Identifier" && node.name === name;
}

// The property name of a member expression: `a.x` or `a["x"]`; null when computed from a non-literal.
function memberName(node: AnyNode): string | null {
  if (node.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") return node.property.value;
  return null;
}

function isModuleExports(node: AnyNode): boolean {
  return node.type === "MemberExpression" && memberName(node) === "exports" && isIdent(node.object, "module");
}

function propertyKey(prop: Property): string | null {
  if (prop.computed) return prop.key.type === "Literal" && typeof prop.key.value === "string" ? prop.key.value : null;
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal") return String(prop.key.value);
  return null;
}

function exportedName(node: AnyNode): string {
  return node.type === "Identifier" ? node.name : node.type === "Literal" ? String(node.value) : "";
}

function hasFunctionAncestor(ancestors: readonly Node[], self: Node): boolean {
  return ancestors.some((a) => a !== self && isFunctionNode(a));
}

/**
 * Exported functions and every export entry, in source order of the export site.
 *
 * IDs are `<file>#<declared name>`; an anonymous default export is `<file>#default` with exportName `default`.
 * Rule for an anonymous function assigned to a named export (`module.exports.a = function () {}`): the declared name is
 * missing, so the ID uses the export name (`styles.js#a`). A declarator's name counts as the declared name
 * (`var c = function () {}` is `#c`). One ExportedFunction per function node: when several export names are bound to one
 * function, exportName is the first in source order and every name stays in `exports` with the same functionId (RF-3).
 * If two different functions would get the same ID, the later one uses its export name instead.
 */
export function findExports(parsed: ParsedFile, scope: ScopeInfo): ExportsResult {
  void scope; // identifiers in export positions are module level by construction; kept for the documented signature
  const program = parsed.program;
  if (!program) return { kind: "unknown", exports: [], functions: [] };
  const fnByName = moduleFunctionTargets(program);
  const resolve = (expr: AnyNode | null | undefined): FunctionTarget | null => {
    if (!expr) return null;
    if (expr.type === "FunctionExpression") return { node: expr, declaredName: expr.id ? expr.id.name : null };
    if (expr.type === "ArrowFunctionExpression") return { node: expr, declaredName: null };
    if (expr.type === "Identifier") return fnByName.get(expr.name) ?? null;
    if (expr.type === "AssignmentExpression") return resolve(expr.right);
    return null;
  };

  const cjs: Candidate[] = [];
  walk.ancestor(program, {
    AssignmentExpression(node, _state, ancestors) {
      if (node.operator !== "=" || hasFunctionAncestor(ancestors as Node[], node)) return;
      const left: AnyNode = node.left;
      if (isModuleExports(left)) {
        let right: AnyNode = node.right;
        while (right.type === "AssignmentExpression") right = right.right;
        if (right.type === "ObjectExpression") {
          for (const p of right.properties) {
            if (p.type !== "Property") continue;
            const key = propertyKey(p);
            if (key !== null) cjs.push({ at: p.start, exportName: key, target: resolve(p.value) });
          }
        } else {
          cjs.push({ at: node.start, exportName: "default", target: resolve(right) });
        }
        return;
      }
      if (left.type !== "MemberExpression") return;
      const object: AnyNode = left.object;
      const name = memberName(left);
      if (name !== null && (isModuleExports(object) || isIdent(object, "exports"))) cjs.push({ at: node.start, exportName: name, target: resolve(node.right) });
    },
  });

  const esm: Candidate[] = [];
  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration") {
      const decl = stmt.declaration;
      if (decl?.type === "FunctionDeclaration") esm.push({ at: stmt.start, exportName: decl.id.name, target: { node: decl, declaredName: decl.id.name } });
      else if (decl?.type === "ClassDeclaration") esm.push({ at: stmt.start, exportName: decl.id.name, target: null });
      else if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations) {
          if (d.id.type === "Identifier") {
            const target = d.init && isFunctionNode(d.init) ? { node: d.init as FunctionNode, declaredName: d.id.name } : null;
            esm.push({ at: d.start, exportName: d.id.name, target });
          } else {
            for (const n of bindingNames(d.id)) esm.push({ at: d.start, exportName: n, target: null });
          }
        }
      }
      for (const spec of stmt.specifiers) {
        const target = stmt.source ? null : fnByName.get(exportedName(spec.local)) ?? null;
        esm.push({ at: spec.start, exportName: exportedName(spec.exported), target });
      }
    } else if (stmt.type === "ExportDefaultDeclaration") {
      const d: AnyNode = stmt.declaration;
      if (d.type === "FunctionDeclaration" || d.type === "FunctionExpression") {
        esm.push({ at: stmt.start, exportName: "default", target: { node: d as FunctionNode, declaredName: d.id ? d.id.name : null } });
      } else if (d.type === "ArrowFunctionExpression") {
        esm.push({ at: stmt.start, exportName: "default", target: { node: d, declaredName: null } });
      } else {
        esm.push({ at: stmt.start, exportName: "default", target: resolve(d) });
      }
    } else if (stmt.type === "ExportAllDeclaration" && stmt.exported) {
      esm.push({ at: stmt.start, exportName: exportedName(stmt.exported), target: null });
    }
  }

  const kind: ExportsResult["kind"] = esm.length > 0 ? "esm" : cjs.length > 0 ? "cjs" : parsed.sourceType === "module" ? "esm" : "unknown";
  // A later assignment to the same export name replaces the earlier one (runtime semantics).
  const byName = new Map<string, Candidate>();
  for (const c of [...cjs, ...esm].sort((a, b) => a.at - b.at)) {
    byName.delete(c.exportName);
    byName.set(c.exportName, c);
  }
  const ordered = [...byName.values()].sort((a, b) => a.at - b.at);

  const idOf = new Map<Node, ExportedFunction>();
  const usedIds = new Set<string>();
  const exports: ExportEntry[] = [];
  const functions: ExportedFunction[] = [];
  for (const c of ordered) {
    if (!c.target) {
      exports.push({ name: c.exportName, kind: "value" });
      continue;
    }
    let fn = idOf.get(c.target.node);
    if (!fn) {
      const declared = c.target.declaredName ?? c.exportName;
      let name = declared;
      if (usedIds.has(`${parsed.path}#${name}`)) name = c.exportName;
      for (let n = 2; usedIds.has(`${parsed.path}#${name}`); n++) name = `${c.exportName}~${n}`;
      const functionId = `${parsed.path}#${name}`;
      usedIds.add(functionId);
      fn = { functionId, name, exportName: c.exportName, node: c.target.node };
      idOf.set(c.target.node, fn);
      functions.push(fn);
    }
    exports.push({ name: c.exportName, kind: "function", functionId: fn.functionId });
  }
  functions.sort((a, b) => a.node.start - b.node.start);
  return { kind, exports, functions };
}

function bindingNames(p: Pattern): string[] {
  const out: string[] = [];
  walk.full(p, (n) => {
    const node = n as AnyNode;
    if (node.type === "Identifier") out.push(node.name);
  });
  return out;
}

// Parameter names for FunctionInfo.params: identifiers by name, defaults by their left side, rest as `...name`,
// destructuring patterns as their source text (whitespace collapsed).
export function paramNames(fn: FunctionNode, text: string): string[] {
  const one = (p: Pattern): string => {
    if (p.type === "Identifier") return p.name;
    if (p.type === "AssignmentPattern") return one(p.left);
    if (p.type === "RestElement") return "..." + one(p.argument);
    return text.slice(p.start, p.end).replace(/\s+/g, " ");
  };
  return fn.params.map(one);
}
