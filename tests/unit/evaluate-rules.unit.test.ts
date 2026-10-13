import test from "node:test";
import assert from "node:assert/strict";
import type { HypothesesFile, HypothesisOutput, Prediction } from "../../src/contracts/hypotheses.ts";
import type { Outcome } from "../../src/contracts/outcomes.ts";
import type { RecordedCase } from "../../src/contracts/records.ts";
import type { Tagged } from "../../src/contracts/tagged.ts";
import { evaluateRules } from "../../src/pipeline/evaluate-rules.ts";

const F = "x.js#f";
const G = "x.js#g";
const usage = { promptTokens: 0, completionTokens: 0 };
const R = (v: Tagged): Outcome => ({ kind: "returned", value: v });
type Probe = HypothesisOutput["rules"][number]["probes"][number];
const probe = (label: string, args: Tagged[], prediction: Prediction, more: Tagged[][] = []): Probe => ({ label, steps: [{ args }, ...more.map((a) => ({ args: a }))], prediction });
const rule = (key: string, probes: Probe[]): HypothesisOutput["rules"][number] => ({ key, statement: `The ${key} rule holds for every input.`, relatedConstants: [], probes });
const ruleOut = (probes: Probe[]): HypothesisOutput => ({ rules: [rule("rule-one", probes)], partitions: [] });
const fnEntry = (functionId: string, output: HypothesisOutput): HypothesesFile["functions"][number] => ({ functionId, output, usage });

let counter = 0;
function caseWith(args: Tagged[], outcome: Outcome, extra: Partial<RecordedCase> = {}): RecordedCase {
  counter += 1;
  const functionId = extra.functionId ?? F;
  return {
    id: `${functionId}#c${String(counter).padStart(2, "0")}`, functionId, moduleFile: "x.js", exportName: functionId.split("#")[1]!, style: "sync", origin: "rule-probe", ruleRefs: ["BR-01"], round: 0, label: "p",
    steps: [{ args, outcome }], stateAfter: null, consoleLines: 0, determinism: "stable", ...extra,
  };
}

test("[SUS-01] a probe whose last-step outcome differs from the prediction contradicts the rule and adds an SB entry", () => {
  const c = caseWith([100, "VIP"], R(100));
  const r = evaluateRules([fnEntry(F, ruleOut([probe("vip at 100", [100, "VIP"], { kind: "returns", value: 90 })]))], [c]);
  assert.equal(r.rules.length, 1);
  const [only] = r.rules;
  assert.equal(only!.ruleId, "BR-01");
  assert.equal(only!.functionId, F);
  assert.equal(only!.status, "contradicted");
  assert.equal(only!.probesChecked, 1);
  assert.deepEqual(only!.probes[0], { label: "vip at 100", caseId: c.id, args: [[100, "VIP"]], prediction: { kind: "returns", value: 90 }, observed: R(100), matched: false });
  assert.equal(r.suspicious.length, 1);
  assert.deepEqual(r.suspicious[0], { id: "SB-01", functionId: F, ruleId: "BR-01", statement: "The rule-one rule holds for every input.", probeLabel: "vip at 100", caseId: c.id, args: [[100, "VIP"]], predicted: { kind: "returns", value: 90 }, observed: R(100) });
});

test("[SUS-01] the prediction refers to the last step of a sequence probe", () => {
  const steps = [{ args: [] as Tagged[], outcome: R("A-1") }, { args: [] as Tagged[], outcome: R("A-2") }, { args: [] as Tagged[], outcome: R("A-3") }];
  const c = { ...caseWith([], R("A-1")), steps };
  const ok = evaluateRules([fnEntry(F, ruleOut([probe("three", [], { kind: "returns", value: "A-3" }, [[], []])]))], [c]);
  assert.equal(ok.rules[0]!.status, "consistent");
  assert.deepEqual(ok.rules[0]!.probes[0]!.observed, R("A-3"));
  const bad = evaluateRules([fnEntry(F, ruleOut([probe("three", [], { kind: "returns", value: "A-1" }, [[], []])]))], [c]);
  assert.equal(bad.rules[0]!.status, "contradicted");
});

test("[SUS-01] throws with a name matches only that error; without a name any throw", () => {
  const typeErr: Outcome = { kind: "threw", value: { $t: "Error", name: "TypeError", message: "x" } };
  const thrownString: Outcome = { kind: "threw", value: "boom" };
  const c1 = caseWith([1], typeErr), c2 = caseWith([2], thrownString), c3 = caseWith([3], R(1));
  const cases = [c1, c2, c3];
  const status = (args: Tagged[], p: Prediction) => evaluateRules([fnEntry(F, ruleOut([probe("p", args, p)]))], cases).rules[0]!.status;
  assert.equal(status([1], { kind: "throws", name: "TypeError" }), "consistent");
  assert.equal(status([1], { kind: "throws", name: "RangeError" }), "contradicted");
  assert.equal(status([1], { kind: "throws" }), "consistent");
  assert.equal(status([2], { kind: "throws" }), "consistent");
  assert.equal(status([2], { kind: "throws", name: "Error" }), "contradicted");
  assert.equal(status([3], { kind: "throws" }), "contradicted");
});

test("[SUS-01] a callback prediction is compared with args[1] when args[0] is null or undefined", () => {
  const invoice = { total: 20, ref: "R1" };
  const cases = [
    caseWith([1], { kind: "callback", args: [null, invoice] }),
    caseWith([2], { kind: "callback", args: [{ $t: "undefined" }, 5] }),
    caseWith([3], { kind: "callback", args: [{ $t: "Error", name: "Error", message: "no lines" }] }),
    caseWith([4], { kind: "callback", args: [null] }),
  ];
  const status = (args: Tagged[], value: Tagged) => evaluateRules([fnEntry(F, ruleOut([probe("p", args, { kind: "callback", value })]))], cases).rules[0]!.status;
  assert.equal(status([1], { total: 20, ref: "R1" }), "consistent");
  assert.equal(status([1], { ref: "R1", total: 20 }), "contradicted"); // key order is behavior
  assert.equal(status([2], 5), "consistent");
  assert.equal(status([3], { $t: "undefined" }), "contradicted"); // the error slot is not empty
  assert.equal(status([4], { $t: "undefined" }), "consistent");
});

test("[SUS-02] only unknown predictions, or only unstable probes, give unverified, never consistent", () => {
  const stable = caseWith([1], R(1));
  const unstable = caseWith([2], R(2), { determinism: "unstable", instability: { step: 1, firstRun: R(2), secondRun: R(3) } });
  const timedOut = caseWith([3], { kind: "timeout", reason: "watchdog" });
  const onlyUnknown = evaluateRules([fnEntry(F, ruleOut([probe("a", [1], { kind: "unknown" })]))], [stable, unstable, timedOut]);
  assert.equal(onlyUnknown.rules[0]!.status, "unverified");
  assert.equal(onlyUnknown.rules[0]!.probesChecked, 0);
  assert.equal(onlyUnknown.rules[0]!.probes[0]!.matched, null);
  const onlyUnstable = evaluateRules([fnEntry(F, ruleOut([probe("b", [2], { kind: "returns", value: 99 }), probe("c", [3], { kind: "returns", value: 99 })]))], [stable, unstable, timedOut]);
  assert.equal(onlyUnstable.rules[0]!.status, "unverified");
  assert.equal(onlyUnstable.suspicious.length, 0);
  const rejected = evaluateRules([fnEntry(F, ruleOut([probe("d", [42], { kind: "returns", value: 1 })]))], [stable]);
  assert.equal(rejected.rules[0]!.status, "unverified");
  assert.equal(rejected.rules[0]!.probes[0]!.caseId, null);
  assert.equal(rejected.rules[0]!.probes[0]!.observed, null);
  const noProbes = evaluateRules([fnEntry(F, ruleOut([]))], [stable]);
  assert.equal(noProbes.rules[0]!.status, "unverified");
});

test("[SUS-02] every checkable probe matching gives consistent with probesChecked", () => {
  const cases = [caseWith([80, "STAFF"], R(60)), caseWith([0.04, "STAFF"], R(0.03))];
  const r = evaluateRules([fnEntry(F, ruleOut([probe("a", [80, "STAFF"], { kind: "returns", value: 60 }), probe("b", [0.04, "STAFF"], { kind: "returns", value: 0.03 }), probe("c", [1], { kind: "unknown" })]))], cases);
  assert.equal(r.rules[0]!.status, "consistent");
  assert.equal(r.rules[0]!.probesChecked, 2);
  assert.deepEqual(r.suspicious, []);
});

test("[SUS-01] a probe deduplicated into another rule's case is still checked for both rules", () => {
  const c = caseWith([100, "VIP"], R(100), { ruleRefs: ["BR-01", "BR-02"] });
  const output: HypothesisOutput = { rules: [rule("first-rule", [probe("x", [100, "VIP"], { kind: "returns", value: 100 })]), rule("second-rule", [probe("y", [100, "VIP"], { kind: "returns", value: 90 })])], partitions: [] };
  const r = evaluateRules([fnEntry(F, output)], [c]);
  assert.deepEqual(r.rules.map((x) => [x.ruleId, x.status, x.probes[0]!.caseId]), [["BR-01", "consistent", c.id], ["BR-02", "contradicted", c.id]]);
  assert.deepEqual(r.suspicious.map((s) => [s.id, s.ruleId]), [["SB-01", "BR-02"]]);
});

test("SB numbers run across functions in the given order, then rules, then probes; a case of another function never matches", () => {
  const f1 = caseWith([1], R(1)), g1 = caseWith([1], R(2), { functionId: G });
  const r = evaluateRules([
    fnEntry(F, { rules: [rule("aaa", [probe("p1", [1], { kind: "returns", value: 9 })]), rule("bbb", [probe("p2", [1], { kind: "returns", value: 8 })])], partitions: [] }),
    fnEntry(G, ruleOut([probe("p3", [1], { kind: "returns", value: 2 }), probe("p4", [1], { kind: "returns", value: 7 })])),
  ], [f1, g1]);
  assert.deepEqual(r.suspicious.map((s) => [s.id, s.functionId, s.ruleId, s.probeLabel]), [["SB-01", F, "BR-01", "p1"], ["SB-02", F, "BR-02", "p2"], ["SB-03", G, "BR-01", "p4"]]);
  assert.deepEqual(r.rules.map((x) => `${x.functionId}/${x.ruleId}:${x.status}`), [`${F}/BR-01:contradicted`, `${F}/BR-02:contradicted`, `${G}/BR-01:contradicted`]);
});

test("a sandbox-only outcome is not checkable (no emitted test could pin it)", () => {
  const net = caseWith([1], { kind: "threw", value: { $t: "Error", name: "Error", message: "network is disabled", code: "NO_NETWORK" } });
  const r = evaluateRules([fnEntry(F, ruleOut([probe("p", [1], { kind: "returns", value: 1 })]))], [net]);
  assert.equal(r.rules[0]!.status, "unverified");
  assert.equal(r.suspicious.length, 0);
});
