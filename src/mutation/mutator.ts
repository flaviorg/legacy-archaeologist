// The mutator (spec 5.12): candidate mutants from acorn ranges, operator tokens from one tokenizer pass per file,
// a reparse of every mutated text, stable IDs and truncation. Pure: string splices only, nothing is written.
import type { AnyNode, BlockStatement, Expression, Literal, Node, PrivateIdentifier } from "acorn";
import * as walk from "acorn-walk";
import type { FunctionInfo } from "../contracts/map.ts";
import type { Mutant, OperatorId } from "../contracts/mutation.ts";
import { positionOf, reparseOk, tokenize } from "../static/parser.ts";
import type { ParsedFile, SourceToken } from "../static/parser.ts";
import { AOR_SWAPS, LOR_SWAPS, OPERATORS, ROR_SWAPS, numReplacements } from "./operators.ts";

type Candidate = Omit<Mutant, "id" | "line" | "column"> & { order: number };

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

export function applyMutant(source: string, m: Pick<Mutant, "start" | "end" | "replacement">): string {
  return source.slice(0, m.start) + m.replacement + source.slice(m.end);
}

// The first token whose start is >= pos (tokens are in source order).
function lowerBound(tokens: readonly SourceToken[], pos: number): number {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid]!.start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The operator token between the operands: start in [left.end, right.start) and text equal to the operator (delta 5).
function operatorToken(tokens: readonly SourceToken[], left: Node, right: Node, operator: string): SourceToken | null {
  for (let i = lowerBound(tokens, left.end); i < tokens.length && tokens[i]!.start < right.start; i++) {
    if (tokens[i]!.text === operator) return tokens[i]!;
  }
  return null;
}

function isStringOperand(node: Expression | PrivateIdentifier): boolean {
  return node.type === "TemplateLiteral" || (node.type === "Literal" && typeof (node as Literal).value === "string");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Lists the mutants of the given files inside exported functions only (the innermost exported function names the
 * mutant). Each mutated text is reparsed in the file's sourceType; failures are counted in `invalid` and dropped.
 * Order: file, start, operator order, replacement order; IDs m-0001...; then truncated to maxMutants.
 */
export function listMutants(parsed: readonly ParsedFile[], functions: readonly FunctionInfo[], operators: readonly OperatorId[], maxMutants: number): { mutants: Mutant[]; invalid: number; truncated: number } {
  const enabled = new Set(operators);
  const opRank = new Map(OPERATORS.map((op, i) => [op, i] as const));
  const kept: (Candidate & { line: number; column: number })[] = [];
  let invalid = 0;

  for (const file of [...parsed].sort((a, b) => compareText(a.path, b.path))) {
    if (file.program === null || file.sourceType === null) continue;
    const sourceType = file.sourceType;
    const text = file.text;
    const exported = functions.filter((f) => f.exported && f.id.slice(0, f.id.lastIndexOf("#")) === file.path);
    if (exported.length === 0) continue;
    const owner = (start: number, end: number): FunctionInfo | null => {
      let best: FunctionInfo | null = null;
      for (const f of exported) if (f.range[0] <= start && end <= f.range[1] && (best === null || f.range[0] >= best.range[0])) best = f;
      return best;
    };
    const exportedBody = (fnNode: Node): FunctionInfo | null => exported.find((f) => f.range[0] === fnNode.start && f.range[1] === fnNode.end) ?? null;
    let tokens: SourceToken[] | null = null;
    const tokensOf = (): SourceToken[] => (tokens ??= tokenize(text, sourceType));

    const candidates: Candidate[] = [];
    let order = 0;
    const add = (operator: OperatorId, start: number, end: number, replacements: readonly string[]): void => {
      if (!enabled.has(operator)) return;
      const fn = owner(start, end);
      if (fn === null) return;
      for (const replacement of replacements) {
        candidates.push({ functionId: fn.id, file: file.path, operator, start, end, original: text.slice(start, end), replacement, order: order++ });
      }
    };
    const addBlock = (block: BlockStatement): void => {
      if (block.body.length > 0) add("BLOCK", block.start, block.end, ["{}"]);
    };

    walk.full(file.program, (raw) => {
      const node = raw as AnyNode;
      switch (node.type) {
        case "BinaryExpression": {
          const table = AOR_SWAPS[node.operator] ? { op: "AOR" as const, swaps: AOR_SWAPS[node.operator]! } : ROR_SWAPS[node.operator] ? { op: "ROR" as const, swaps: ROR_SWAPS[node.operator]! } : null;
          if (table === null || !enabled.has(table.op)) return;
          if (table.op === "AOR" && node.operator === "+" && (isStringOperand(node.left) || isStringOperand(node.right))) return;
          const tok = operatorToken(tokensOf(), node.left, node.right, node.operator);
          if (tok) add(table.op, tok.start, tok.end, table.swaps);
          return;
        }
        case "LogicalExpression": {
          const swaps = LOR_SWAPS[node.operator];
          if (!swaps || !enabled.has("LOR")) return;
          const tok = operatorToken(tokensOf(), node.left, node.right, node.operator);
          if (tok) add("LOR", tok.start, tok.end, swaps);
          return;
        }
        case "IfStatement":
          add("NEG", node.test.start, node.test.end, [`!(${text.slice(node.test.start, node.test.end)})`]);
          if (node.consequent.type === "BlockStatement") addBlock(node.consequent);
          return;
        case "ConditionalExpression":
          add("NEG", node.test.start, node.test.end, [`!(${text.slice(node.test.start, node.test.end)})`]);
          return;
        case "Literal":
          if (typeof node.value === "number" && node.bigint === undefined) add("NUM", node.start, node.end, numReplacements(node.value));
          return;
        case "Property":
          // acorn-walk does not visit a non-computed key; a numeric key is still a numeric literal ({ 0: "z" }).
          if (!node.computed && node.key.type === "Literal" && typeof node.key.value === "number" && node.key.bigint === undefined) {
            add("NUM", node.key.start, node.key.end, numReplacements(node.key.value));
          }
          return;
        default:
          if (FUNCTION_TYPES.has(node.type)) {
            const body = (node as { body: Node }).body;
            if (body.type !== "BlockStatement") return;
            const block = body as BlockStatement;
            if (exportedBody(node) !== null && block.body.length === 1) return;
            addBlock(block);
          }
      }
    });

    candidates.sort((a, b) => a.start - b.start || opRank.get(a.operator)! - opRank.get(b.operator)! || a.order - b.order);
    for (const c of candidates) {
      if (!reparseOk(applyMutant(text, c), sourceType)) {
        invalid += 1;
        continue;
      }
      kept.push({ ...c, ...positionOf(text, c.start) });
    }
  }

  const numbered: Mutant[] = kept.map((c, i) => ({
    id: `m-${String(i + 1).padStart(4, "0")}`,
    functionId: c.functionId,
    file: c.file,
    operator: c.operator,
    start: c.start,
    end: c.end,
    original: c.original,
    replacement: c.replacement,
    line: c.line,
    column: c.column,
  }));
  const limit = Math.max(0, maxMutants);
  return { mutants: numbered.slice(0, limit), invalid, truncated: Math.max(0, numbered.length - limit) };
}
