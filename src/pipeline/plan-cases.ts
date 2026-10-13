// The case planner (spec 4.4, 5.2 and 5.9): validation, dedup, boundary expansions, caps and stable IDs.
// Pure. It turns proposals into inputs only: nothing in a PlannedCase carries a prediction (HYP-05).
import type { HypothesisOutput, RejectedInput, RejectReason } from "../contracts/hypotheses.ts";
import type { CaseLimits } from "../contracts/limits.ts";
import type { FunctionInfo } from "../contracts/map.ts";
import type { CaseOrigin, PlannedCase } from "../contracts/records.ts";
import { stableStringify } from "../contracts/stable-json.ts";
import { OUTPUT_ONLY_TAGS } from "../contracts/tagged.ts";
import type { Tagged } from "../contracts/tagged.ts";

export type PlanContext = { kind: "llm" | "baseline" | "survivor"; round: number; mutantRef?: string };

const MAX_LABEL = 120;
const OUTPUT_ONLY: ReadonlySet<string> = new Set(OUTPUT_ONLY_TAGS);

type Steps = { args: Tagged[] }[];
type Proposal = { label: string; steps: Steps; origin: CaseOrigin; ruleRef?: string; ruleKey?: string };

function sanitizeLabel(label: string): string {
  return label.replace(/[^\x20-\x7E]/g, "").trim().slice(0, MAX_LABEL);
}

/** The canonical form used for dedup (and by rule evaluation to find a probe's case). */
export function canonicalSteps(steps: readonly { args: readonly Tagged[] }[]): string {
  return stableStringify(steps.map((s) => ({ args: s.args })));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOutputOnlyTag(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasOutputOnlyTag);
  if (!isRecord(v)) return false;
  if (typeof v.$t === "string") {
    if (OUTPUT_ONLY.has(v.$t)) return true;
    // The escape's inner object is plain data: its own "$t" key is not a tag.
    if (v.$t === "object" && isRecord(v.v)) return Object.values(v.v).some(hasOutputOnlyTag);
    return false;
  }
  return Object.values(v).some(hasOutputOnlyTag);
}

// Containers count one level each; primitives and tags (other than the object escape) count zero.
function nesting(v: unknown): number {
  if (Array.isArray(v)) return 1 + Math.max(0, ...v.map(nesting));
  if (!isRecord(v)) return 0;
  if (typeof v.$t === "string") return v.$t === "object" && isRecord(v.v) ? 1 + Math.max(0, ...Object.values(v.v).map(nesting)) : 0;
  return 1 + Math.max(0, ...Object.values(v).map(nesting));
}

function caseNumber(id: string): number {
  const m = /#c(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function expansionValues(v: number): { value: number; text: string }[] {
  if (Number.isInteger(v)) return [{ value: v - 1, text: "-1" }, { value: v + 1, text: "+1" }];
  const round = (x: number): number => {
    const r = Math.round(x * 1e9) / 1e9;
    return Object.is(r, -0) ? 0 : r;
  };
  return [{ value: round(v - 0.01), text: "-0.01" }, { value: round(v + 0.01), text: "+0.01" }];
}

export function planCases(fn: FunctionInfo, proposals: HypothesisOutput, limits: CaseLimits, existing: PlannedCase[], ctx: PlanContext = { kind: "llm", round: 0 }): { cases: PlannedCase[]; rejected: RejectedInput[] } {
  const moduleFile = fn.id.slice(0, fn.id.lastIndexOf("#"));
  const arity = fn.params.filter((p) => p !== fn.callbackParam).length;
  const partitionOrigin: CaseOrigin = ctx.kind === "baseline" ? "baseline" : ctx.kind === "survivor" ? "survivor-round" : "partition";
  const round = ctx.kind === "survivor" ? ctx.round : 0;

  const cases: PlannedCase[] = [];
  const rejected: RejectedInput[] = [];
  const byKey = new Map<string, PlannedCase | null>(); // null: an existing case (its ruleRefs are not changed here)
  for (const c of existing) byKey.set(canonicalSteps(c.steps), null);
  let next = Math.max(0, ...existing.map((c) => caseNumber(c.id))) + 1;
  const total = (): number => existing.length + cases.length;

  const ordered: Proposal[] = [];
  proposals.rules.forEach((rule, i) => {
    const ruleRef = `BR-${String(i + 1).padStart(2, "0")}`;
    for (const p of rule.probes) ordered.push({ label: p.label, steps: p.steps, origin: "rule-probe", ruleRef, ruleKey: rule.key });
  });
  for (const p of proposals.partitions) ordered.push({ label: p.label, steps: p.steps, origin: partitionOrigin });

  const makeCase = (label: string, steps: Steps, origin: CaseOrigin, ruleRefs: string[], expandsCase?: string): PlannedCase => ({
    id: `${fn.id}#c${String(next++).padStart(2, "0")}`,
    functionId: fn.id,
    moduleFile,
    exportName: fn.exportName ?? fn.name,
    style: fn.style,
    origin,
    ruleRefs,
    round,
    ...(ctx.kind === "survivor" && ctx.mutantRef !== undefined ? { mutantRef: ctx.mutantRef } : {}),
    ...(expandsCase !== undefined ? { expandsCase } : {}),
    label,
    steps: structuredClone(steps),
  });

  for (const p of ordered) {
    const label = sanitizeLabel(p.label);
    const reject = (reason: RejectReason): void => {
      rejected.push({
        functionId: fn.id,
        origin: p.origin,
        label,
        reason,
        ...(p.ruleKey !== undefined ? { ruleKey: p.ruleKey } : {}),
        ...(ctx.kind === "survivor" && ctx.mutantRef !== undefined ? { mutantRef: ctx.mutantRef } : {}),
      });
    };
    const args = p.steps.flatMap((s) => s.args);
    if (label === "") { reject("BAD_LABEL"); continue; }
    if (hasOutputOnlyTag(args)) { reject("OUTPUT_ONLY_TAG"); continue; }
    if (p.steps.length === 0 || p.steps.length > limits.maxSteps || p.steps.some((s) => s.args.length > arity)) { reject("ARITY"); continue; }
    if (args.some((a) => nesting(a) > limits.maxDepth)) { reject("DEPTH"); continue; }
    const key = canonicalSteps(p.steps);
    if (byKey.has(key)) {
      const kept = byKey.get(key);
      if (kept && p.ruleRef !== undefined && !kept.ruleRefs.includes(p.ruleRef)) kept.ruleRefs.push(p.ruleRef);
      reject("DUPLICATE");
      continue;
    }
    if (total() >= limits.maxCasesPerFunction) { reject("CAP_CASES"); continue; }
    const c = makeCase(label, p.steps, p.origin, p.ruleRef !== undefined ? [p.ruleRef] : []);
    cases.push(c);
    byKey.set(key, c);
  }

  // Boundary expansions (plan delta 17): single-step cases of round 0, top-level finite numeric arguments.
  if (ctx.kind !== "survivor") {
    let perFunction = 0;
    for (const source of [...cases]) {
      if (source.steps.length !== 1) continue;
      let perCase = 0;
      const sourceArgs = source.steps[0]!.args;
      for (let i = 0; i < sourceArgs.length; i++) {
        const v = sourceArgs[i];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        for (const e of expansionValues(v)) {
          if (perCase >= limits.maxExpansionsPerCase || perFunction >= limits.maxExpansionsPerFunction || total() >= limits.maxCasesPerFunction) break;
          const args = [...sourceArgs];
          args[i] = e.value;
          const steps = [{ args }];
          const key = canonicalSteps(steps);
          if (byKey.has(key)) continue;
          // The source label is already sanitized; the code-made suffix is printable ASCII too (spec 5.1, GEN-02).
          const suffix = ` / arg ${i + 1} ${e.text}`;
          const c = makeCase(source.label.slice(0, MAX_LABEL - suffix.length).trimEnd() + suffix, steps, "boundary-expansion", [], source.id);
          cases.push(c);
          byKey.set(key, c);
          perCase += 1;
          perFunction += 1;
        }
      }
    }
  }
  return { cases, rejected };
}
