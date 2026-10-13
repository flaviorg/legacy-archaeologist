// The six v1 mutation operators and their replacement tables (spec 5.12). Pure, no imports beyond the contract.
import type { OperatorId } from "../contracts/mutation.ts";

export const OPERATORS: readonly OperatorId[] = ["AOR", "ROR", "LOR", "NEG", "NUM", "BLOCK"];

export const AOR_SWAPS: Readonly<Record<string, readonly string[]>> = { "+": ["-"], "-": ["+"], "*": ["/"], "/": ["*"], "%": ["*"] };

export const ROR_SWAPS: Readonly<Record<string, readonly string[]>> = {
  "<": ["<="],
  "<=": ["<"],
  ">": [">="],
  ">=": [">"],
  "==": ["!="],
  "!=": ["=="],
  "===": ["!=="],
  "!==": ["==="],
};

export const LOR_SWAPS: Readonly<Record<string, readonly string[]>> = { "&&": ["||"], "||": ["&&"] };

/** n + 1, n - 1 and 0 (when n is not 0), deduplicated by text; negative values parenthesized so `a-0.1` stays valid. */
export function numReplacements(n: number): string[] {
  const values = [n + 1, n - 1, ...(n !== 0 ? [0] : [])];
  const out: string[] = [];
  for (const v of values) {
    const text = v < 0 ? `(${String(v)})` : String(v);
    if (!out.includes(text)) out.push(text);
  }
  return out;
}
