// hypothesize.v1: asks for business-rule hypotheses with probe inputs and input partitions for one function.
// The answer is data: Zod validates it and the planner turns it into inputs; predictions are compared with the
// recorded behavior later and never become expected values.
import { hypothesisOutputSchema } from "../../contracts/hypotheses.ts";
import type { HypothesisOutput } from "../../contracts/hypotheses.ts";
import { LLM_SOURCE_LIMIT_BYTES } from "../../contracts/map.ts";
import type { FunctionInfo, SideEffectKind } from "../../contracts/map.ts";
import type { PromptSpec } from "../prompt-spec.ts";

export type HypothesizeInput = {
  functionId: string;
  name: string;
  params: string[];
  callbackParam: string | null;
  source: string;
  truncated: boolean;
  sideEffects: { kind: SideEffectKind; line: number }[];
  magicNumbers: number[];
  callees: string[];
};

const SYSTEM = [
  "You are helping to characterize a legacy JavaScript function before it is refactored.",
  "Read the function and propose business-rule hypotheses, probe inputs for each rule, and input partitions worth recording.",
  "",
  "Answer with exactly one JSON object and nothing else, matching this shape:",
  '{ "rules": [ { "key": "kebab-case-slug", "statement": "one sentence", "relatedConstants": [100], "probes": [ { "label": "short phrase", "steps": [ { "args": [100, "VIP"] } ], "prediction": { "kind": "returns", "value": 90 } } ] } ],',
  '  "partitions": [ { "label": "short phrase", "steps": [ { "args": [0, "NONE"] } ] } ], "notes": "optional, at most 500 characters" }',
  "",
  "Values inside args and prediction values are JSON, except these tagged forms:",
  '- NaN: { "$t": "NaN" }; Infinity: { "$t": "Infinity" }; -Infinity: { "$t": "-Infinity" }; negative zero: { "$t": "-0" }',
  '- undefined: { "$t": "undefined" }; a Date: { "$t": "Date", "v": "2023-11-14T22:13:20.000Z" }; a bigint: { "$t": "bigint", "v": "123" }',
  '- a plain object that itself has a "$t" key: { "$t": "object", "v": { ... } }',
  "",
  "Limits: at most 8 rules, 6 probes per rule, 20 partitions, 5 steps per probe or partition, 8 arguments per step,",
  "100 items per array, 100 keys per object, strings of at most 1,000 characters, nesting depth of at most 5.",
  "",
  "Rules:",
  "- Each step is one call of the function on the same fresh module instance; use several steps only for stateful behavior.",
  "- A prediction refers to the outcome of the LAST step of its probe.",
  '- Prediction kinds: { "kind": "returns", "value": ... }, { "kind": "throws", "name": "TypeError" } (name optional),',
  '  { "kind": "callback", "value": ... } (the second argument passed to the callback), or { "kind": "unknown" } when you are unsure.',
  "- Never put the callback argument in args: the harness supplies the callback itself.",
  "- Labels are short English phrases in printable ASCII; statements are one English sentence.",
  "- The current date is frozen at 2023-11-14T22:13:20.000Z and Math.random is seeded, so time-based rules are testable.",
  "- Your answer is advisory: the inputs are executed and the real behavior is recorded; predictions are only compared with it.",
].join("\n");

const TRUNCATION_MARKER = (more: number): string => `\n/* truncated by legacy-archaeologist: ${more} more bytes */`;

const utf8 = new TextEncoder();

// Cuts `text` to at most `limit` UTF-8 bytes without splitting a character.
function cutUtf8(text: string, limit: number): { kept: string; total: number } {
  const total = utf8.encode(text).length;
  if (total <= limit) return { kept: text, total };
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const size = utf8.encode(ch).length;
    if (bytes + size > limit) break;
    bytes += size;
    end += ch.length;
  }
  return { kept: text.slice(0, end), total };
}

function uniqueInOrder<T>(values: readonly T[]): T[] {
  const out: T[] = [];
  for (const v of values) if (!out.includes(v)) out.push(v);
  return out;
}

export function buildHypothesizeInput(fn: FunctionInfo, moduleText: string): HypothesizeInput {
  const raw = moduleText.slice(fn.range[0], fn.range[1]);
  const { kept, total } = cutUtf8(raw, LLM_SOURCE_LIMIT_BYTES);
  const truncated = kept.length < raw.length;
  const keptBytes = utf8.encode(kept).length;
  return {
    functionId: fn.id,
    name: fn.name,
    params: [...fn.params],
    callbackParam: fn.callbackParam,
    source: truncated ? kept + TRUNCATION_MARKER(total - keptBytes) : raw,
    truncated,
    sideEffects: fn.sideEffects.map((s) => ({ kind: s.kind, line: s.line })),
    magicNumbers: uniqueInOrder(fn.magicNumbers.map((m) => m.value)),
    callees: uniqueInOrder(fn.calls.map((c) => c.callee)),
  };
}

// A Markdown fence longer than any backtick run inside the source, so the block always closes where it should.
export function fenceFor(source: string): string {
  const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function buildUser(input: HypothesizeInput): string {
  // The callback parameter is named once, in the suffix, because the harness supplies it.
  const plain = input.params.filter((p) => p !== input.callbackParam);
  const params = plain.length === 0 ? "none" : plain.join(", ");
  const callback = input.callbackParam === null ? "" : ` (callback: ${input.callbackParam})`;
  const effects = input.sideEffects.length === 0 ? "none" : input.sideEffects.map((s) => `${s.kind} (line ${s.line})`).join(", ");
  const magic = input.magicNumbers.length === 0 ? "none" : input.magicNumbers.map((n) => String(n)).join(", ");
  const calls = input.callees.length === 0 ? "none" : input.callees.join(", ");
  const fence = fenceFor(input.source);
  return [
    `Function: ${input.functionId}`,
    `Parameters: ${params}${callback}`,
    `Side effects: ${effects}`,
    `Magic numbers: ${magic}`,
    `Calls: ${calls}`,
    ...(input.truncated ? ["The source below was truncated to 8,192 bytes."] : []),
    "",
    fence + "js",
    input.source,
    fence,
  ].join("\n");
}

export const hypothesizePrompt: PromptSpec<HypothesizeInput, HypothesisOutput> = {
  version: "hypothesize.v1",
  system: SYSTEM,
  buildUser,
  outputSchema: hypothesisOutputSchema,
  matchKeys: (input) => ({ functionId: input.functionId }),
};
