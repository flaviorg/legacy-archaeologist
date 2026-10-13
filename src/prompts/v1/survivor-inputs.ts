// survivor-inputs.v1: asks for inputs that make the original function and one surviving mutant behave differently.
// Advisory: the proposed inputs are recorded on the original and replayed on the mutant by code.
import { survivorOutputSchema } from "../../contracts/hypotheses.ts";
import type { SurvivorOutput } from "../../contracts/hypotheses.ts";
import type { FunctionInfo } from "../../contracts/map.ts";
import type { Mutant } from "../../contracts/mutation.ts";
import type { RecordedCase } from "../../contracts/records.ts";
import type { Tagged } from "../../contracts/tagged.ts";
import type { PromptSpec } from "../prompt-spec.ts";
import { buildHypothesizeInput, fenceFor } from "./hypothesize.ts";

export type SurvivorInput = {
  functionId: string;
  round: number;
  mutantId: string;
  functionSource: string;
  mutant: { line: number; operator: string; original: string; replacement: string; context: string[] };
  existingArgs: Tagged[][];
};

const SYSTEM = [
  "You are helping to strengthen characterization tests of a legacy JavaScript function.",
  "A small change (a mutant) was applied to the function and none of the recorded inputs noticed it.",
  "Propose at most 5 inputs that make the original function and the mutant behave differently,",
  "or answer likelyEquivalent: true with a reason when no input can tell them apart.",
  "",
  "Answer with exactly one JSON object and nothing else, matching this shape:",
  '{ "inputs": [ { "label": "short phrase", "steps": [ { "args": [0.04, "STAFF"] } ] } ], "likelyEquivalent": false, "reason": "one sentence" }',
  "",
  "Values inside args are JSON, except these tagged forms:",
  '- NaN: { "$t": "NaN" }; Infinity: { "$t": "Infinity" }; -Infinity: { "$t": "-Infinity" }; negative zero: { "$t": "-0" }',
  '- undefined: { "$t": "undefined" }; a Date: { "$t": "Date", "v": "2023-11-14T22:13:20.000Z" }; a bigint: { "$t": "bigint", "v": "123" }',
  '- a plain object that itself has a "$t" key: { "$t": "object", "v": { ... } }',
  "",
  "Limits: at most 5 inputs, 5 steps per input, 8 arguments per step; strings of at most 1,000 characters; nesting depth of at most 5.",
  "Never put the callback argument in args. Do not repeat the existing inputs listed below. Labels are short English phrases in printable ASCII.",
  "Your answer is advisory: the inputs are executed on both versions and only the recorded behavior decides.",
].join("\n");

function buildUser(input: SurvivorInput): string {
  const fence = fenceFor(input.functionSource);
  const existing = input.existingArgs.length === 0 ? ["none"] : input.existingArgs.map((args) => `- ${JSON.stringify(args)}`);
  return [
    `Function: ${input.functionId}`,
    `Round: ${input.round}`,
    `Mutant: ${input.mutantId} (${input.mutant.operator}) at line ${input.mutant.line}: \`${input.mutant.original}\` replaced by \`${input.mutant.replacement}\``,
    "Context of the mutated line:",
    ...input.mutant.context.map((l) => `| ${l}`),
    "Existing inputs (arguments of each recorded call):",
    ...existing,
    "",
    fence + "js",
    input.functionSource,
    fence,
  ].join("\n");
}

const CONTEXT_LINES = 3;
const MAX_EXISTING = 20;

/**
 * The function source exactly as hypothesize.v1 sends it (same 8,192-byte cut), the mutated line with 3 source lines
 * before and after it, and the first step's arguments of the function's first 20 cases in case-ID order.
 */
export function buildSurvivorInput(fn: FunctionInfo, moduleText: string, m: Mutant, round: number, existing: readonly RecordedCase[]): SurvivorInput {
  const lines = moduleText.split(/\r?\n/);
  const from = Math.max(0, m.line - 1 - CONTEXT_LINES);
  const to = Math.min(lines.length, m.line + CONTEXT_LINES);
  const cases = existing.filter((c) => c.functionId === fn.id).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, MAX_EXISTING);
  return {
    functionId: fn.id,
    round,
    mutantId: m.id,
    functionSource: buildHypothesizeInput(fn, moduleText).source,
    mutant: { line: m.line, operator: m.operator, original: m.original, replacement: m.replacement, context: lines.slice(from, to) },
    existingArgs: cases.map((c) => structuredClone(c.steps[0]?.args ?? [])),
  };
}

export const survivorInputsPrompt: PromptSpec<SurvivorInput, SurvivorOutput> = {
  version: "survivor-inputs.v1",
  system: SYSTEM,
  buildUser,
  outputSchema: survivorOutputSchema,
  matchKeys: (input) => ({ round: input.round, mutantId: input.mutantId, functionId: input.functionId }),
};
