// Rule evaluation (spec 5.11 status rules, plan delta 19). Pure, and it calls no LLM: a prediction is compared with
// the recorded outcome of its probe's last step after recording, and that is all it is ever used for (HYP-05).
import type { HypothesesFile, Prediction } from "../contracts/hypotheses.ts";
import { isCharacterized, taggedEqual } from "../contracts/outcomes.ts";
import type { Outcome } from "../contracts/outcomes.ts";
import type { RecordedCase } from "../contracts/records.ts";
import type { EvaluatedProbe, EvaluatedRule, RuleStatus, SuspiciousBehavior } from "../contracts/report.ts";
import type { Tagged } from "../contracts/tagged.ts";
import { canonicalSteps } from "./plan-cases.ts";

function isUndefinedTag(t: Tagged | undefined): boolean {
  return t === undefined || (typeof t === "object" && t !== null && !Array.isArray(t) && (t as { $t?: unknown }).$t === "undefined");
}

/** Does the observed outcome of the last step satisfy the prediction? (spec 5.11) */
function predictionMatches(prediction: Prediction, observed: Outcome): boolean {
  switch (prediction.kind) {
    case "returns":
      return observed.kind === "returned" && taggedEqual(observed.value, prediction.value);
    case "throws": {
      if (observed.kind !== "threw") return false;
      if (prediction.name === undefined) return true;
      const v = observed.value;
      return typeof v === "object" && v !== null && !Array.isArray(v) && (v as { $t?: unknown }).$t === "Error" && (v as { name?: unknown }).name === prediction.name;
    }
    case "callback": {
      if (observed.kind !== "callback") return false;
      if (!(observed.args.length === 0 || observed.args[0] === null || isUndefinedTag(observed.args[0]))) return false;
      const value: Tagged = observed.args.length > 1 ? (observed.args[1] as Tagged) : { $t: "undefined" };
      return taggedEqual(value, prediction.value);
    }
    default:
      return false;
  }
}

/**
 * Statuses for every rule of every function, in the given function order (map order), then rule order (BR-01..),
 * then probe order. A probe's case is the case of the same function with the same canonical steps; a probe is
 * checkable when its prediction is not `unknown` and its case is characterized (stable, no timeout or no-callback,
 * no sandbox-only outcome). Each failing checkable probe adds one SB-nn, numbered across the run.
 */
export function evaluateRules(hypotheses: HypothesesFile["functions"], records: RecordedCase[]): { rules: EvaluatedRule[]; suspicious: SuspiciousBehavior[] } {
  const byKey = new Map<string, RecordedCase>();
  for (const c of records) {
    const key = `${c.functionId}\u0000${canonicalSteps(c.steps)}`;
    if (!byKey.has(key)) byKey.set(key, c);
  }
  const rules: EvaluatedRule[] = [];
  const suspicious: SuspiciousBehavior[] = [];
  for (const fn of hypotheses) {
    fn.output.rules.forEach((rule, ruleIndex) => {
      const ruleId = `BR-${String(ruleIndex + 1).padStart(2, "0")}`;
      const probes: EvaluatedProbe[] = [];
      let checked = 0;
      let failed = 0;
      for (const p of rule.probes) {
        const c = byKey.get(`${fn.functionId}\u0000${canonicalSteps(p.steps)}`) ?? null;
        const observed = c ? (c.steps.at(-1)?.outcome ?? null) : null;
        const checkable = p.prediction.kind !== "unknown" && c !== null && observed !== null && isCharacterized(c);
        const matched = checkable ? predictionMatches(p.prediction, observed) : null;
        const args = p.steps.map((s) => s.args);
        probes.push({ label: p.label, caseId: c ? c.id : null, args, prediction: p.prediction, observed, matched });
        if (!checkable) continue;
        checked += 1;
        if (matched) continue;
        failed += 1;
        suspicious.push({
          id: `SB-${String(suspicious.length + 1).padStart(2, "0")}`,
          functionId: fn.functionId,
          ruleId,
          statement: rule.statement,
          probeLabel: p.label,
          caseId: (c as RecordedCase).id,
          args,
          predicted: p.prediction,
          observed: observed as Outcome,
        });
      }
      const status: RuleStatus = failed > 0 ? "contradicted" : checked > 0 ? "consistent" : "unverified";
      rules.push({ functionId: fn.functionId, ruleId, key: rule.key, statement: rule.statement, relatedConstants: rule.relatedConstants, status, probesChecked: checked, probes });
    });
  }
  return { rules, suspicious };
}
