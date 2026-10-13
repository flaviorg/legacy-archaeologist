// The parent's side of the child protocol (spec 5.4, plan deltas 8 and 20). The child never imports this file
// (its read grant has no node_modules, so no zod); it writes the same shapes by hand in child/main.ts.
import * as z from "zod";
import type { Outcome } from "../contracts/outcomes.ts";
import type { CaseId, PlannedCase } from "../contracts/records.ts";
import type { Tagged, TaggedLimits } from "../contracts/tagged.ts";

export type JobCase = PlannedCase & { callbackIndex: number | null };

export type ChildJob = {
  kind: "probe" | "replay";
  modulePath: string;
  moduleKind: "commonjs" | "module";
  targetRoot: string;
  exportNames: string[];
  cases: JobCase[];
  world: { clockNow: number; seed: number };
  caseTimeoutMs: number;
  caseTimeoutsMs?: Record<CaseId, number>;
  limits: TaggedLimits;
};

const CHILD_HELLO = "legacy-archaeologist-child";

export type HelloLine = { nonce: string; hello: typeof CHILD_HELLO; version: string };
export type CaseLine = { nonce: string; caseId: CaseId; steps: { args: Tagged[]; outcome: Outcome }[]; stateAfter: Tagged | null; consoleLines: number; durationsMs: number[] };
export type LoadErrorLine = { nonce: string; caseId: CaseId; loadError: string };
export type DoneLine = { nonce: string; done: true; cases: number };
export type ChildLine = HelloLine | CaseLine | LoadErrorLine | DoneLine;

// A line already went through JSON.parse, so any value is valid JSON; the tagged walk is the child's job.
const taggedValue = z.custom<Tagged>((v) => v !== undefined);
const nonNegative = z.number().nonnegative();

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("returned"), value: taggedValue }).strict(),
  z.object({ kind: z.literal("threw"), value: taggedValue }).strict(),
  z.object({ kind: z.literal("callback"), args: z.array(taggedValue) }).strict(),
  z.object({ kind: z.literal("promise"), status: z.enum(["fulfilled", "rejected"]), value: taggedValue }).strict(),
  z.object({ kind: z.literal("timeout"), reason: z.enum(["case-timeout", "watchdog", "output-cap", "child-exit", "leaked-error"]).optional() }).strict(),
  z.object({ kind: z.literal("no-callback") }).strict(),
]);

const helloSchema = z.object({ nonce: z.string(), hello: z.literal(CHILD_HELLO), version: z.string() }).strict();
const caseSchema = z.object({
  nonce: z.string(),
  caseId: z.string(),
  steps: z.array(z.object({ args: z.array(taggedValue), outcome: outcomeSchema }).strict()),
  stateAfter: taggedValue,
  consoleLines: z.number().int().nonnegative(),
  durationsMs: z.array(nonNegative),
}).strict();
const loadErrorSchema = z.object({ nonce: z.string(), caseId: z.string(), loadError: z.string() }).strict();
const doneSchema = z.object({ nonce: z.string(), done: z.literal(true), cases: z.number().int().nonnegative() }).strict();
const lineSchema = z.union([helloSchema, caseSchema, loadErrorSchema, doneSchema]);

export type ParsedChildLine = { ok: true; line: ChildLine } | { ok: false; reason: "unparseable" | "nonce" | "schema" };

/**
 * One fd 3 line. `unparseable` and `nonce` are what a target writing to fd 3 can produce (dropped and counted,
 * delta 8); `schema` is a nonce-correct line of the wrong shape, which only a tool bug can produce.
 */
export function parseChildLine(text: string, nonce: string): ParsedChildLine {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "nonce" };
  if ((value as { nonce?: unknown }).nonce !== nonce) return { ok: false, reason: "nonce" };
  const parsed = lineSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "schema" };
  return { ok: true, line: parsed.data as ChildLine };
}
