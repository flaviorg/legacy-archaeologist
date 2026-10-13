// LLM output schemas and caps (spec 5.2), the rejection record of the planner and hypotheses.json (spec 5.1).
import * as z from "zod";
import type { ToolInfo } from "./map.ts";
import type { PlannedCase } from "./records.ts";
import type { Tagged } from "./tagged.ts";

// Input tags only: function, circular, truncated and unserializable are output-only and fail here (the planner's
// OUTPUT_ONLY_TAG covers values that reach it by another path).
const inputSpecialSchema = z.discriminatedUnion("$t", [
  z.object({ $t: z.literal("NaN") }).strict(),
  z.object({ $t: z.literal("Infinity") }).strict(),
  z.object({ $t: z.literal("-Infinity") }).strict(),
  z.object({ $t: z.literal("-0") }).strict(),
  z.object({ $t: z.literal("undefined") }).strict(),
  z.object({ $t: z.literal("bigint"), v: z.string().regex(/^-?\d{1,30}$/) }).strict(), // so revive's BigInt(v) cannot throw
  z.object({ $t: z.literal("Date"), v: z.union([z.iso.datetime(), z.literal("Invalid Date")]) }).strict(),
  z.object({ $t: z.literal("object"), v: z.lazy(() => plainObjectSchema) }).strict(), // escape: a plain object that itself has a "$t" key
]);

const plainObjectSchema: z.ZodType<{ [k: string]: Tagged }> = z
  .record(z.string().max(64), z.lazy(() => taggedSchema))
  .refine((o) => Object.keys(o).length <= 100, { message: "more than 100 keys" });

const taggedSchema: z.ZodType<Tagged> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string().max(1_000),
    z.array(taggedSchema).max(100),
    inputSpecialSchema,
    // Without this refine the record branch would accept { $t: "bogus" }.
    plainObjectSchema.refine((o) => !Object.hasOwn(o, "$t"), { message: "unknown or malformed $t tag" }),
  ]),
);

// callLlm rejects a longer raw text before JSON.parse (counts as invalid output; the repair applies).
export const MAX_RAW_LLM_BYTES = 65_536;

const argsSchema = z.array(taggedSchema).max(8); // arity cap; the planner also checks against the parameters
const stepsSchema = z.array(z.object({ args: argsSchema })).min(1).max(5);

const predictionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("returns"), value: taggedSchema }),
  z.object({ kind: z.literal("throws"), name: z.string().max(64).optional() }), // with a name, only an error of that name matches
  z.object({ kind: z.literal("callback"), value: taggedSchema }), // the callback's second argument (the first is the error slot)
  z.object({ kind: z.literal("unknown") }),
]);

// A prediction always refers to the outcome of the probe's LAST step.
const ruleHypothesisSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9-]{3,40}$/), // LLM slug; code assigns "BR-nn" by order
    statement: z.string().min(10).max(300),
    relatedConstants: z.array(z.number()).max(8).default([]),
    probes: z.array(z.object({ label: z.string().max(120), steps: stepsSchema, prediction: predictionSchema })).max(6),
  })
  .strict();

export const hypothesisOutputSchema = z
  .object({
    rules: z.array(ruleHypothesisSchema).max(8),
    partitions: z.array(z.object({ label: z.string().max(120), steps: stepsSchema })).max(20),
    notes: z.string().max(500).optional(), // free text, shown in SPEC.md as "Archaeologist notes (LLM)"
  })
  .strict();

export const survivorOutputSchema = z
  .object({
    inputs: z.array(z.object({ label: z.string().max(120), steps: stepsSchema })).max(5),
    likelyEquivalent: z.boolean(),
    reason: z.string().max(300),
  })
  .strict();

export type Prediction = z.infer<typeof predictionSchema>;
export type HypothesisOutput = z.infer<typeof hypothesisOutputSchema>;
export type SurvivorOutput = z.infer<typeof survivorOutputSchema>;

export type RejectReason = "ARITY" | "DEPTH" | "DUPLICATE" | "CAP_CASES" | "BAD_LABEL" | "OUTPUT_ONLY_TAG";

export type RejectedInput = {
  functionId: string;
  origin: PlannedCase["origin"];
  label: string;
  reason: RejectReason;
  ruleKey?: string;
  mutantRef?: string;
};

export type Usage = { promptTokens: number; completionTokens: number };

export type HypothesesFile = {
  schemaVersion: 1;
  tool: ToolInfo;
  targetSha: string;
  provider: "none" | "fake" | "openai-compatible";
  model: string;
  scenario?: string;
  functions: { functionId: string; output: HypothesisOutput; usage: Usage }[];
  rejected: RejectedInput[];
};
