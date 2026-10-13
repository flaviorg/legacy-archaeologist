import test from "node:test";
import assert from "node:assert/strict";
import type { HypothesisOutput } from "../../src/contracts/hypotheses.ts";
import { DEFAULT_CASE_LIMITS } from "../../src/contracts/limits.ts";
import type { PlannedCase } from "../../src/contracts/records.ts";
import type { Tagged } from "../../src/contracts/tagged.ts";
import { planCases } from "../../src/pipeline/plan-cases.ts";
import { billingFn, syntheticFn } from "../helpers/billing.ts";

const applyDiscountInfo = billingFn("applyDiscount");
const part = (label: string, ...steps: Tagged[][]) => ({ label, steps: steps.map((args) => ({ args })) });
const probe = (label: string, args: Tagged[]) => ({ label, steps: [{ args }], prediction: { kind: "unknown" as const } });
const rule = (key: string, probes: ReturnType<typeof probe>[]) => ({ key, statement: `statement for ${key} rule`, relatedConstants: [], probes });
const out = (rules: ReturnType<typeof rule>[], partitions: ReturnType<typeof part>[]): HypothesisOutput => ({ rules, partitions });
const ids = (cases: PlannedCase[]) => cases.map((c) => c.id.split("#").at(-1));

test("[HYP-03] case IDs follow probes, partitions, then expansions, two-digit and stable", () => {
  const proposals = out([rule("vip-threshold", [probe("vip at 100", [100, "VIP"]), probe("vip at 150", [150, "VIP"])])], [part("unknown code", [50, "NOPE"]), part("staff cents", [0.5, "STAFF"])]);
  const { cases, rejected } = planCases(applyDiscountInfo, proposals, DEFAULT_CASE_LIMITS, []);
  assert.deepEqual(rejected, []);
  assert.deepEqual(ids(cases), ["c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08", "c09", "c10", "c11", "c12"]);
  assert.deepEqual(cases.slice(0, 4).map((c) => [c.origin, c.ruleRefs, c.label]), [["rule-probe", ["BR-01"], "vip at 100"], ["rule-probe", ["BR-01"], "vip at 150"], ["partition", [], "unknown code"], ["partition", [], "staff cents"]]);
  assert.deepEqual(cases.slice(4).map((c) => [c.label, c.steps[0]!.args[0], c.expandsCase?.split("#").at(-1)]), [
    ["vip at 100 / arg 1 -1", 99, "c01"], ["vip at 100 / arg 1 +1", 101, "c01"],
    ["vip at 150 / arg 1 -1", 149, "c02"], ["vip at 150 / arg 1 +1", 151, "c02"],
    ["unknown code / arg 1 -1", 49, "c03"], ["unknown code / arg 1 +1", 51, "c03"],
    ["staff cents / arg 1 -0.01", 0.49, "c04"], ["staff cents / arg 1 +0.01", 0.51, "c04"],
  ]);
  for (const c of cases) {
    assert.equal(c.functionId, "billing.js#applyDiscount");
    assert.equal(c.moduleFile, "billing.js");
    assert.equal(c.exportName, "applyDiscount");
    assert.equal(c.style, "sync");
    assert.equal(c.round, 0);
  }
  assert.ok(cases.slice(4).every((c) => c.origin === "boundary-expansion" && c.ruleRefs.length === 0));
  assert.equal(cases[0]!.id, "billing.js#applyDiscount#c01");
  assert.deepEqual(planCases(applyDiscountInfo, proposals, DEFAULT_CASE_LIMITS, []), { cases, rejected });
});

test("[HYP-03] duplicates keep the first case and merge ruleRefs", () => {
  const proposals = out([rule("rule-one", [probe("first", [100, "VIP"])]), rule("rule-two", [probe("again", [100, "VIP"]), probe("other", [5, "VIP"])])], [part("dup partition", [5, "VIP"])]);
  const { cases, rejected } = planCases(applyDiscountInfo, proposals, DEFAULT_CASE_LIMITS, []);
  assert.deepEqual(cases.slice(0, 2).map((c) => [c.label, c.ruleRefs]), [["first", ["BR-01", "BR-02"]], ["other", ["BR-02"]]]);
  assert.deepEqual(rejected, [
    { functionId: "billing.js#applyDiscount", origin: "rule-probe", label: "again", reason: "DUPLICATE", ruleKey: "rule-two" },
    { functionId: "billing.js#applyDiscount", origin: "partition", label: "dup partition", reason: "DUPLICATE" },
  ]);
  // Object key order is behavior: { a, b } and { b, a } are different inputs.
  const keyed = planCases(syntheticFn(["o"]), out([], [part("ab", [{ a: 1, b: 2 }]), part("ba", [{ b: 2, a: 1 }])]), DEFAULT_CASE_LIMITS, []);
  assert.equal(keyed.cases.length, 2);
});

test("[HYP-03] expansions are capped at 4 per case and 12 per function; cases at 40 including existing ones", () => {
  const fn = syntheticFn(["x", "y", "z"]);
  const four = planCases(fn, out([], [part("p1", [1, 2, 3]), part("p2", [10, 20, 30]), part("p3", [100, 200, 300]), part("p4", [7, 8, 9])]), DEFAULT_CASE_LIMITS, []);
  const expansions = four.cases.filter((c) => c.origin === "boundary-expansion");
  assert.equal(expansions.length, 12);
  assert.deepEqual(expansions.slice(0, 4).map((c) => c.steps[0]!.args), [[0, 2, 3], [2, 2, 3], [1, 1, 3], [1, 3, 3]]);
  assert.ok(!expansions.some((c) => c.expandsCase === "t.js#f#c04"));
  // Multi-step cases and non-numeric arguments are not expanded; a duplicate expansion is skipped.
  const mixed = planCases(fn, out([], [part("seq", [1], [2]), part("text", ["a", null]), part("near", [4]), part("next", [5])]), DEFAULT_CASE_LIMITS, []);
  assert.deepEqual(mixed.cases.filter((c) => c.origin === "boundary-expansion").map((c) => c.steps[0]!.args), [[3], [6]]);

  const existing = planCases(fn, out([], Array.from({ length: 19 }, (_, i) => part(`e${i}`, [`v${i}`], [`w${i}`]))), DEFAULT_CASE_LIMITS, []).cases;
  const more = planCases(fn, out([], Array.from({ length: 19 }, (_, i) => part(`m${i}`, [`m${i}`], [`n${i}`]))), DEFAULT_CASE_LIMITS, existing).cases;
  const all = [...existing, ...more];
  assert.equal(all.length, 38);
  const capped = planCases(fn, out([], [part("a", [1]), part("b", [2]), part("c", [3])]), DEFAULT_CASE_LIMITS, all);
  assert.deepEqual(capped.cases.map((c) => c.label), ["a", "b"]);
  assert.deepEqual(capped.rejected.map((r) => [r.label, r.reason]), [["c", "CAP_CASES"]]);
});

test("[HYP-03] numbering continues after existing cases and dedup counts them", () => {
  const first = planCases(applyDiscountInfo, out([], [part("a", ["s", "VIP"]), part("b", ["t", "VIP"]), part("c", ["u", "VIP"])]), DEFAULT_CASE_LIMITS, []).cases;
  assert.deepEqual(ids(first), ["c01", "c02", "c03"]);
  const { cases, rejected } = planCases(applyDiscountInfo, out([], [part("new one", [3, "STAFF"]), part("old one", ["t", "VIP"])]), DEFAULT_CASE_LIMITS, first, { kind: "survivor", round: 1, mutantRef: "m-0007" });
  assert.deepEqual(ids(cases), ["c04"]);
  assert.deepEqual([cases[0]!.origin, cases[0]!.round, cases[0]!.mutantRef], ["survivor-round", 1, "m-0007"]);
  assert.deepEqual(rejected, [{ functionId: "billing.js#applyDiscount", origin: "survivor-round", label: "old one", reason: "DUPLICATE", mutantRef: "m-0007" }]);
  const baseline = planCases(applyDiscountInfo, out([], [part("base vector", [0, 1])]), DEFAULT_CASE_LIMITS, [], { kind: "baseline", round: 0 });
  assert.deepEqual(baseline.cases.map((c) => c.origin), ["baseline", "boundary-expansion", "boundary-expansion", "boundary-expansion", "boundary-expansion"]);
});

test("[HYP-04] ARITY, DEPTH, BAD_LABEL and OUTPUT_ONLY_TAG are rejected with reasons without aborting", () => {
  const deep: Tagged = [[[[[[1]]]]]];
  const fine: Tagged = [[[[[1]]]]];
  const proposals = out([], [
    part("three args", [1, 2, 3]),
    part("too deep", [deep]),
    part("\u0001\u0002"),
    part("function tag", [{ $t: "function", name: "f" } as unknown as Tagged]),
    part("hidden tag", [{ list: [{ $t: "circular" } as unknown as Tagged] }]),
    part("escaped is fine", [{ $t: "object", v: { $t: "function" } }]),
    part("five deep is fine", [fine]),
    part("café — accented  ", ["ok", "VIP"]),
    part("too many steps", [1], [2], [3], [4], [5], [6]),
  ]);
  proposals.partitions[2]!.steps = [{ args: [1] }];
  const { cases, rejected } = planCases(applyDiscountInfo, proposals, DEFAULT_CASE_LIMITS, []);
  assert.deepEqual(rejected.map((r) => [r.label, r.reason]), [["three args", "ARITY"], ["too deep", "DEPTH"], ["", "BAD_LABEL"], ["function tag", "OUTPUT_ONLY_TAG"], ["hidden tag", "OUTPUT_ONLY_TAG"], ["too many steps", "ARITY"]]);
  assert.deepEqual(cases.filter((c) => c.origin !== "boundary-expansion").map((c) => c.label), ["escaped is fine", "five deep is fine", "caf  accented"]);
  const long = planCases(applyDiscountInfo, out([], [part("x".repeat(200), [1, "VIP"])]), DEFAULT_CASE_LIMITS, []);
  assert.equal(long.cases[0]!.label.length, 120);
  assert.ok(long.cases.slice(1).every((c) => c.label.length <= 120));
});

test("[HYP-05] a planned case never carries a prediction", () => {
  const { cases } = planCases(applyDiscountInfo, { rules: [{ key: "vip-threshold", statement: "VIP takes 10% off at 100.00", relatedConstants: [100], probes: [{ label: "vip at 100", steps: [{ args: [100, "VIP"] }], prediction: { kind: "returns", value: 90 } }] }], partitions: [] }, DEFAULT_CASE_LIMITS, []);
  assert.ok(!JSON.stringify(cases).includes("prediction"));
  assert.ok(!JSON.stringify(cases).includes("90"));
});
