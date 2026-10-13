// Cyclomatic complexity (MAP-05) and the hotspot list.
import * as walk from "acorn-walk";
import type { RecursiveVisitors } from "acorn-walk";
import type { Node } from "acorn";
import { HOTSPOT_COUNT } from "../contracts/map.ts";
import { isFunctionNode } from "./scope.ts";

// The default walker with nested functions skipped (they have their own complexity).
const SKIP_NESTED: RecursiveVisitors<unknown> = { ...walk.base, Function: () => {} };
const DECISION_LOGICAL = new Set(["&&", "||", "??"]);

// 1 + if, for, for-in, for-of, while, do-while, ?:, &&, ||, ??, case with a test, catch; nested functions not counted.
export function cyclomatic(fn: Node): number {
  let n = 1;
  const inc = (): void => {
    n++;
  };
  const start = isFunctionNode(fn) ? fn.body : fn;
  walk.simple(start, {
    IfStatement: inc,
    ForStatement: inc,
    ForInStatement: inc,
    ForOfStatement: inc,
    WhileStatement: inc,
    DoWhileStatement: inc,
    ConditionalExpression: inc,
    CatchClause: inc,
    LogicalExpression(node) {
      if (DECISION_LOGICAL.has(node.operator)) n++;
    },
    SwitchCase(node) {
      if (node.test) n++;
    },
  }, SKIP_NESTED);
  return n;
}

// Descending complexity, ties by functionId; the input array is not reordered.
export function topHotspots(fns: readonly { functionId: string; complexity: number }[], n: number = HOTSPOT_COUNT): { functionId: string; complexity: number }[] {
  return [...fns]
    .sort((a, b) => b.complexity - a.complexity || (a.functionId < b.functionId ? -1 : a.functionId > b.functionId ? 1 : 0))
    .slice(0, n)
    .map(({ functionId, complexity }) => ({ functionId, complexity }));
}
