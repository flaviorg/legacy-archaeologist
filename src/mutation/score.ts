// Stryker's score formula (spec 5.12, MUT-05): detected = killed + timeout, valid = detected + survived + noCoverage,
// error excluded; one decimal; the same per operator. Pure.
import type { MutantStatus, MutationScore, OperatorId, OperatorScore } from "../contracts/mutation.ts";
import { OPERATORS } from "./operators.ts";

type Counts = { killed: number; timeout: number; survived: number; noCoverage: number; error: number };

const zero = (): Counts => ({ killed: 0, timeout: 0, survived: 0, noCoverage: 0, error: 0 });

function bump(c: Counts, status: MutantStatus): void {
  if (status === "killed") c.killed += 1;
  else if (status === "timeout") c.timeout += 1;
  else if (status === "survived") c.survived += 1;
  else if (status === "no-coverage") c.noCoverage += 1;
  else c.error += 1;
}

function scoreOf(detected: number, valid: number): number {
  return valid === 0 ? 0 : Math.round((detected / valid) * 1000) / 10;
}

export function computeScore(mutants: readonly { operator: OperatorId; status: MutantStatus }[]): MutationScore {
  const total = zero();
  const per = new Map<OperatorId, Counts>(OPERATORS.map((op) => [op, zero()] as const));
  for (const m of mutants) {
    bump(total, m.status);
    bump(per.get(m.operator)!, m.status);
  }
  const byOperator = {} as Record<OperatorId, OperatorScore>;
  for (const op of OPERATORS) {
    const c = per.get(op)!;
    byOperator[op] = { killed: c.killed, timeout: c.timeout, survived: c.survived, noCoverage: c.noCoverage, mutationScore: scoreOf(c.killed + c.timeout, c.killed + c.timeout + c.survived + c.noCoverage) };
  }
  const detected = total.killed + total.timeout;
  const valid = detected + total.survived + total.noCoverage;
  return { ...total, detected, valid, mutationScore: scoreOf(detected, valid), byOperator };
}
