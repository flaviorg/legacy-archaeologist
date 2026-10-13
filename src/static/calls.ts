// Calls per function (MAP-06): callee text, `resolved` by name only for module-level functions of the same file, and
// `dynamic` for computed members and non-identifier callees. No call graph is built (M9).
import * as walk from "acorn-walk";
import type { AnyNode, Node, Program, Super } from "acorn";
import type { CallInfo } from "../contracts/map.ts";
import { moduleFunctionTargets } from "./exports.ts";

// Name → function ID (`<file>#<name>`) for the module-level functions of one file.
export function moduleFunctionIds(program: Program, file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of moduleFunctionTargets(program).keys()) out.set(name, `${file}#${name}`);
  return out;
}

// Identifiers, `this` and non-computed member chains by name; anything else in the chain is `<expression>` or `<computed>`.
function render(node: AnyNode | Super): string {
  switch (node.type) {
    case "Identifier":
      return node.name;
    case "ThisExpression":
      return "this";
    case "Super":
      return "super";
    case "MemberExpression": {
      const object = render(node.object);
      if (node.computed) return `${object}[<computed>]`;
      return `${object}.${node.property.type === "Identifier" ? node.property.name : node.property.type === "PrivateIdentifier" ? "#" + node.property.name : "<computed>"}`;
    }
    default:
      return "<expression>";
  }
}

/**
 * Every call expression inside `fn` (nested functions included), in source order (an inner call of a chain first).
 * `line` is the line where the callee ends, so a chained `.method()` on its own line reports that line.
 */
export function listCalls(fn: Node, moduleFunctions: ReadonlyMap<string, string>): CallInfo[] {
  const found: (CallInfo & { start: number; end: number })[] = [];
  walk.simple(fn, {
    CallExpression(node) {
      const callee = node.callee as AnyNode | Super;
      const line = callee.loc!.end.line;
      const base = { line, start: node.start, end: node.end };
      if (callee.type === "Identifier") {
        found.push({ callee: callee.name, resolved: moduleFunctions.get(callee.name) ?? null, dynamic: false, ...base });
      } else if (callee.type === "MemberExpression" && callee.computed) {
        found.push({ callee: "<computed>", resolved: null, dynamic: true, ...base });
      } else if (callee.type === "MemberExpression") {
        found.push({ callee: render(callee), resolved: null, dynamic: false, ...base });
      } else {
        found.push({ callee: "<expression>", resolved: null, dynamic: true, ...base });
      }
    },
  });
  return found
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map(({ callee, resolved, line, dynamic }) => ({ callee, resolved, line, dynamic }));
}
