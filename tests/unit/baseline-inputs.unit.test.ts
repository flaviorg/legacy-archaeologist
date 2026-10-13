import test from "node:test";
import assert from "node:assert/strict";
import { BASELINE_SEEDS, baselineProposals, isDateNamed } from "../../src/pipeline/baseline-inputs.ts";
import { noneProposals } from "../../src/llm/none-provider.ts";
import { billingFn, syntheticFn } from "../helpers/billing.ts";

const applyDiscountInfo = billingFn("applyDiscount");
const DAY = 86_400_000;
const dateTag = (ms: number) => ({ $t: "Date", v: new Date(ms).toISOString() });

test("[HYP-06] the baseline of a 2-parameter function is the base vector plus 17 values per position, then magic boundaries", () => {
  const out = baselineProposals(applyDiscountInfo); // params subtotal, code; magic 100
  assert.deepEqual(out.rules, []);
  assert.equal(out.partitions[0]!.label, "base vector");
  assert.deepEqual(out.partitions[0]!.steps, [{ args: [0, 1] }]);
  assert.equal(out.partitions.filter((p) => p.label.startsWith("arg ") && !p.label.includes("magic")).length, 34);
  assert.deepEqual(out.partitions.filter((p) => p.label.includes("magic")).map((p) => p.label), ["arg 1 = 100 (magic number)", "arg 1 = 99 (magic number 100 - 1)", "arg 1 = 101 (magic number 100 + 1)", "arg 2 = 100 (magic number)", "arg 2 = 99 (magic number 100 - 1)", "arg 2 = 101 (magic number 100 + 1)"]);
  assert.equal(out.partitions.length, 41);
  const byLabel = new Map(out.partitions.map((p) => [p.label, p.steps]));
  assert.deepEqual(byLabel.get("arg 1 = empty string"), [{ args: ["", 1] }]);
  assert.deepEqual(byLabel.get('arg 2 = "x"'), [{ args: [0, "x"] }]);
  assert.deepEqual(byLabel.get("arg 2 = the frozen clock date"), [{ args: [0, { $t: "Date", v: "2023-11-14T22:13:20.000Z" }] }]);
  assert.deepEqual(byLabel.get("arg 1 = NaN"), [{ args: [{ $t: "NaN" }, 1] }]);
  assert.deepEqual(byLabel.get("arg 1 = undefined"), [{ args: [{ $t: "undefined" }, 1] }]);
  assert.deepEqual(byLabel.get("arg 2 = array of one empty object"), [{ args: [0, [{}]] }]);
  assert.deepEqual(out.partitions.slice(1, 18).map((p) => p.label.replace("arg 1 = ", "")), BASELINE_SEEDS.map((s) => s.text));
});

test("[HYP-06] the seed table has the 17 values of spec 5.2 in order", () => {
  assert.deepEqual(BASELINE_SEEDS.map((s) => s.text), ["0", "1", "-1", "2", "100", "-0.5", "empty string", '"x"', "true", "false", "null", "undefined", "empty array", "array of one empty object", "empty object", "the frozen clock date", "NaN"]);
});

test("[HYP-06] the callback position is never filled", () => {
  const out = baselineProposals(billingFn("calculateInvoice")); // customer, lines, cb
  assert.ok(out.partitions.length > 30);
  for (const p of out.partitions) for (const s of p.steps) assert.equal(s.args.length, 2, p.label);
  assert.ok(!out.partitions.some((p) => p.label.startsWith("arg 3")));
});

test("[HYP-06] date-named parameters get frozen clock ± 1 and ± 31 days as Date tags", () => {
  for (const [p, yes] of [["startDate", true], ["createdAt", true], ["paidOn", true], ["dueDate", true], ["day", true], ["date2", true], ["start_date", true], ["options", false], ["rate", false], ["data", false], ["count", false], ["amount", false], ["update", false]] as const) assert.equal(isDateNamed(p), yes, p);
  const out = baselineProposals(billingFn("lateFee")); // dueDate, paidDate, amount; magic 86400000, 7, 3, 3, 0.015
  assert.deepEqual(out.partitions[0]!.steps, [{ args: [0, 1, "x"] }]);
  const dates = out.partitions.filter((p) => /= frozen clock [-+]/.test(p.label));
  assert.deepEqual(dates.map((p) => p.label), [
    "arg 1 = frozen clock - 31 days", "arg 1 = frozen clock - 1 day", "arg 1 = frozen clock + 1 day", "arg 1 = frozen clock + 31 days",
    "arg 2 = frozen clock - 31 days", "arg 2 = frozen clock - 1 day", "arg 2 = frozen clock + 1 day", "arg 2 = frozen clock + 31 days",
  ]);
  assert.deepEqual(dates[0]!.steps, [{ args: [dateTag(1700000000000 - 31 * DAY), 1, "x"] }]);
  assert.deepEqual(dates[6]!.steps, [{ args: [0, dateTag(1700000000000 + DAY), "x"] }]);
  const magic = out.partitions.filter((p) => p.label.startsWith("arg 1 =") && p.label.includes("magic")).map((p) => p.label);
  assert.deepEqual(magic, [
    "arg 1 = 86400000 (magic number)", "arg 1 = 86399999 (magic number 86400000 - 1)", "arg 1 = 86400001 (magic number 86400000 + 1)",
    "arg 1 = 7 (magic number)", "arg 1 = 6 (magic number 7 - 1)", "arg 1 = 8 (magic number 7 + 1)",
    "arg 1 = 3 (magic number)", "arg 1 = 2 (magic number 3 - 1)", "arg 1 = 4 (magic number 3 + 1)",
    "arg 1 = 0.015 (magic number)", "arg 1 = 0.005 (magic number 0.015 - 0.01)", "arg 1 = 0.025 (magic number 0.015 + 0.01)",
  ]);
  const lastMagic = out.partitions.findIndex((p) => p.label === "arg 3 = 0.025 (magic number 0.015 + 0.01)");
  assert.ok(lastMagic > 0 && lastMagic < out.partitions.indexOf(dates[0]!), "magic boundaries come before dates");
});

test("[HYP-06] a 4-parameter function uses null from the fourth position on, and a 0-parameter function gets only the base vector", () => {
  assert.deepEqual(baselineProposals(syntheticFn(["a", "b", "c", "d"])).partitions[0]!.steps, [{ args: [0, 1, "x", null] }]);
  assert.deepEqual(baselineProposals(syntheticFn([])).partitions, [{ label: "base vector", steps: [{ args: [] }] }]);
});

test("[HYP-06] a function that writes module state gets a 3-step sequence", () => {
  const out = baselineProposals(billingFn("nextInvoiceNumber"));
  const last = out.partitions.at(-1)!;
  assert.equal(last.label, "sequence of 3 calls");
  assert.deepEqual(last.steps, [{ args: [0] }, { args: [0] }, { args: [0] }]);
  assert.ok(!baselineProposals(applyDiscountInfo).partitions.some((p) => p.label === "sequence of 3 calls"));
});

test("[HYP-06] baselineProposals is pure", () => {
  assert.deepEqual(baselineProposals(applyDiscountInfo), baselineProposals(structuredClone(applyDiscountInfo)));
  const a = baselineProposals(applyDiscountInfo);
  (a.partitions[16]!.steps[0]!.args as unknown[]).push("mutated");
  assert.deepEqual(baselineProposals(applyDiscountInfo).partitions[16]!.steps[0]!.args.length, 2, "no shared seed objects");
  assert.deepEqual(noneProposals(applyDiscountInfo), baselineProposals(applyDiscountInfo));
});
