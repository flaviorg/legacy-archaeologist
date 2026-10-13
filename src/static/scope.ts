// Minimal hand-written scope (spec 4.2): module-level bindings and, per function, its params and local declarations.
// No block-level precision beyond "local to the function"; a `with` body or a direct eval makes identifiers unresolved.
import * as walk from "acorn-walk";
import type { ArrowFunctionExpression, FunctionDeclaration, FunctionExpression, Node, Pattern, Program } from "acorn";

export type IdentifierClass = "local" | "module" | "global" | "unresolved";
export type BindingKind = "var" | "let" | "const" | "function" | "class" | "import";
// functionValued: a function declaration or a declarator whose initializer is a function (not module state).
export type ModuleBinding = { kind: BindingKind; line: number; functionValued: boolean };

export type ScopeInfo = {
  moduleBindings: Map<string, ModuleBinding>;
  functionLocals: Map<Node, Set<string>>;
  hasDirectEval: boolean;
  withRanges: [number, number][];
};

export type FunctionNode = FunctionDeclaration | FunctionExpression | ArrowFunctionExpression;

export function isFunctionNode(node: Node): node is FunctionNode {
  return node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
}

// Names bound by a pattern (params, declarators, catch params).
export function patternNames(pattern: Pattern | null | undefined, out: string[] = []): string[] {
  if (!pattern) return out;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") patternNames(prop.argument, out);
        else patternNames(prop.value, out);
      }
      break;
    case "ArrayPattern":
      for (const el of pattern.elements) patternNames(el, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    default:
      break; // MemberExpression targets bind nothing
  }
  return out;
}

function innermostFunction(ancestors: readonly Node[], self: Node): Node | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i] as Node;
    if (a !== self && isFunctionNode(a)) return a;
  }
  return null;
}

function isFunctionInit(init: Node | null | undefined): boolean {
  return !!init && (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression");
}

// The function nodes of a program in source order (outer before inner).
export function functionNodes(program: Program): FunctionNode[] {
  const out: FunctionNode[] = [];
  walk.full(program, (node) => {
    if (isFunctionNode(node)) out.push(node);
  });
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

// Function nodes whose range contains `pos`, outermost first.
export function enclosingFunctionsOf(program: Program): (pos: number) => readonly Node[] {
  const fns = functionNodes(program);
  return (pos) => fns.filter((f) => f.start <= pos && pos < f.end);
}

export function buildScope(program: Program): ScopeInfo {
  const moduleBindings = new Map<string, ModuleBinding>();
  const functionLocals = new Map<Node, Set<string>>();
  const withRanges: [number, number][] = [];
  let hasDirectEval = false;

  const localsOf = (fn: Node): Set<string> => {
    let set = functionLocals.get(fn);
    if (!set) {
      set = new Set();
      functionLocals.set(fn, set);
    }
    return set;
  };
  const addModule = (name: string, kind: BindingKind, line: number, functionValued: boolean): void => {
    if (!moduleBindings.has(name)) moduleBindings.set(name, { kind, line, functionValued });
  };
  // A declaration directly in the program body, or wrapped by an export declaration that is.
  const isTopLevel = (ancestors: readonly Node[], self: Node): boolean => {
    const parent = ancestors[ancestors.indexOf(self) - 1];
    if (parent?.type === "Program") return true;
    if (parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration") return ancestors[ancestors.indexOf(self) - 2]?.type === "Program";
    return false;
  };

  walk.ancestor(program, {
    Function(node, _state, ancestors) {
      const fn = node as FunctionNode;
      const locals = localsOf(fn);
      for (const p of fn.params) for (const name of patternNames(p)) locals.add(name);
      if (fn.type === "FunctionExpression" && fn.id) locals.add(fn.id.name);
      if (fn.type !== "ArrowFunctionExpression") locals.add("arguments");
      if (fn.type === "FunctionDeclaration" && fn.id) {
        const owner = innermostFunction(ancestors as Node[], fn);
        if (owner) localsOf(owner).add(fn.id.name);
        else if (isTopLevel(ancestors as Node[], fn)) addModule(fn.id.name, "function", fn.id.loc!.start.line, true);
      }
    },
    VariableDeclaration(node, _state, ancestors) {
      const owner = innermostFunction(ancestors as Node[], node);
      const topLevel = isTopLevel(ancestors as Node[], node);
      for (const decl of node.declarations) {
        for (const name of patternNames(decl.id)) {
          if (owner) localsOf(owner).add(name);
          else if (node.kind === "var" || topLevel) {
            if (node.kind === "var" || node.kind === "let" || node.kind === "const") addModule(name, node.kind, decl.id.loc!.start.line, isFunctionInit(decl.init));
          }
        }
      }
    },
    ClassDeclaration(node, _state, ancestors) {
      if (!node.id) return;
      const owner = innermostFunction(ancestors as Node[], node);
      if (owner) localsOf(owner).add(node.id.name);
      else if (isTopLevel(ancestors as Node[], node)) addModule(node.id.name, "class", node.id.loc!.start.line, false);
    },
    CatchClause(node, _state, ancestors) {
      const owner = innermostFunction(ancestors as Node[], node);
      if (owner) for (const name of patternNames(node.param)) localsOf(owner).add(name);
    },
    ImportDeclaration(node) {
      for (const spec of node.specifiers) addModule(spec.local.name, "import", spec.local.loc!.start.line, false);
    },
    CallExpression(node) {
      if (node.callee.type === "Identifier" && node.callee.name === "eval") hasDirectEval = true;
    },
    WithStatement(node) {
      withRanges.push([node.body.start, node.body.end]);
    },
  });

  return { moduleBindings, functionLocals, hasDirectEval, withRanges };
}

/**
 * `enclosing` = function nodes from outermost to innermost. `unresolved` when the file has a direct eval or `pos`
 * lies in a `with` body; `local` when any enclosing function declares the name; `module` when a module binding
 * exists; otherwise `global`.
 */
export function classifyIdentifier(scope: ScopeInfo, name: string, at: { pos: number; enclosing: readonly Node[] }): IdentifierClass {
  if (scope.hasDirectEval) return "unresolved";
  if (scope.withRanges.some(([s, e]) => at.pos >= s && at.pos < e)) return "unresolved";
  for (const fn of at.enclosing) if (scope.functionLocals.get(fn)?.has(name)) return "local";
  if (scope.moduleBindings.has(name)) return "module";
  return "global";
}

