import test from "node:test";
import assert from "node:assert/strict";
import type { MutantStatus, OperatorId } from "../../src/contracts/mutation.ts";
import { computeScore } from "../../src/mutation/score.ts";

const rep = (operator: OperatorId, status: MutantStatus, n: number) => Array.from({ length: n }, () => ({ operator, status }));

test("[MUT-05] Stryker's formula on a table of statuses, error excluded, one decimal, per operator", () => {
  const s = computeScore([...rep("AOR", "killed", 3), ...rep("ROR", "timeout", 1), ...rep("ROR", "survived", 2), ...rep("NUM", "no-coverage", 1), ...rep("NUM", "error", 5)]);
  assert.deepEqual([s.detected, s.valid, s.mutationScore], [4, 7, 57.1]);
  assert.deepEqual([s.killed, s.timeout, s.survived, s.noCoverage, s.error], [3, 1, 2, 1, 5]);
  assert.equal(s.byOperator.ROR.mutationScore, 33.3);
  assert.deepEqual(s.byOperator.AOR, { killed: 3, timeout: 0, survived: 0, noCoverage: 0, mutationScore: 100 });
  assert.deepEqual(s.byOperator.NUM, { killed: 0, timeout: 0, survived: 0, noCoverage: 1, mutationScore: 0 });
  assert.equal(s.byOperator.BLOCK.mutationScore, 0);
  assert.equal(s.error, 5);
  assert.deepEqual(Object.keys(s.byOperator), ["AOR", "ROR", "LOR", "NEG", "NUM", "BLOCK"]);
});

test("[MUT-05] no valid mutant gives a score of 0, and two thirds rounds to 66.7", () => {
  assert.equal(computeScore([]).mutationScore, 0);
  assert.equal(computeScore(rep("NEG", "error", 2)).mutationScore, 0);
  assert.equal(computeScore([...rep("NEG", "killed", 2), ...rep("NEG", "survived", 1)]).mutationScore, 66.7);
});
