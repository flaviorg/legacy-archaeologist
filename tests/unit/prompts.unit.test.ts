import test from "node:test";
import assert from "node:assert/strict";
import { hypothesisOutputSchema, survivorOutputSchema } from "../../src/contracts/hypotheses.ts";
import { llmFixtureSchema } from "../../src/contracts/llm-fixture.ts";
import type { FunctionInfo } from "../../src/contracts/map.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";
import { buildHypothesizeInput, hypothesizePrompt } from "../../src/prompts/v1/hypothesize.ts";
import { survivorInputsPrompt } from "../../src/prompts/v1/survivor-inputs.ts";
import type { SurvivorInput } from "../../src/prompts/v1/survivor-inputs.ts";
import { billingFn as fnInfo, billingText } from "../helpers/billing.ts";

const calculateInvoiceInfo = fnInfo("calculateInvoice");

const survivorInput: SurvivorInput = {
  functionId: "billing.js#applyDiscount",
  round: 1,
  mutantId: "m-0007",
  functionSource: "function applyDiscount(subtotal, code) { return subtotal; }",
  mutant: { line: 41, operator: "ROR", original: ">", replacement: ">=", context: ["    if (subtotal > 100) {"] },
  existingArgs: [[100, "VIP"], [{ $t: "NaN" }, "STAFF"]],
};

test("[HYP-01] the hypothesize user message carries source, params, callback flag, side effects, magic numbers and callees", () => {
  const u = hypothesizePrompt.buildUser(buildHypothesizeInput(calculateInvoiceInfo, billingText));
  for (const s of ["Function: billing.js#calculateInvoice", "Parameters: customer, lines (callback: cb)", "Math.random (line", "Magic numbers: 1000000", "Calls: cb, applyDiscount, roundMoney", "```js", "global.LAST_INVOICE = invoice;"]) assert.ok(u.includes(s), s);
  assert.equal(buildHypothesizeInput(calculateInvoiceInfo, billingText).truncated, false);
  const none = hypothesizePrompt.buildUser(buildHypothesizeInput(fnInfo("roundMoney"), billingText));
  assert.ok(none.includes("Side effects: none"), none);
});

test("[HYP-01] a source over 8,192 bytes is truncated with a marker", () => {
  const text = "/" + "/" + "x".repeat(8_998);
  assert.equal(Buffer.byteLength(text), 9_000);
  const big: FunctionInfo = { ...fnInfo("roundMoney"), range: [0, text.length] };
  const input = buildHypothesizeInput(big, text);
  assert.equal(input.truncated, true);
  assert.ok(input.source.endsWith("\n/* truncated by legacy-archaeologist: 808 more bytes */"), input.source.slice(-80));
  assert.equal(Buffer.byteLength(input.source.split("\n/* truncated")[0]!), 8_192);
  // A multi-byte character is never split.
  const accented = "é".repeat(5_000);
  const cut = buildHypothesizeInput({ ...big, range: [0, accented.length] }, accented);
  assert.equal(cut.source.split("\n/* truncated")[0], "é".repeat(4_096));
  assert.ok(cut.source.endsWith("1808 more bytes */"));
});

test("[HYP-02] buildUser is a pure function of its input and carries no absolute path or environment value", () => {
  const input = buildHypothesizeInput(calculateInvoiceInfo, billingText);
  assert.equal(hypothesizePrompt.buildUser(input), hypothesizePrompt.buildUser(structuredClone(input)));
  assert.equal(survivorInputsPrompt.buildUser(survivorInput), survivorInputsPrompt.buildUser(structuredClone(survivorInput)));
  for (const u of [hypothesizePrompt.buildUser(input), survivorInputsPrompt.buildUser(survivorInput)]) {
    assert.ok(!u.includes(PROJECT_ROOT));
    assert.ok(!u.includes(process.env.HOME!));
  }
});

test("[HYP-04] the hypothesis schema rejects bogus, malformed and oversize tags", () => {
  const withArg = (arg: unknown) => ({ rules: [], partitions: [{ label: "x", steps: [{ args: [arg] }] }] });
  for (const bad of [{ $t: "bogus" }, { $t: "bigint", v: "1.5" }, { $t: "NaN", extra: 1 }, { $t: "Date", v: "garbage" }, { $t: "function", name: "x" }, { $t: "circular" }, "s".repeat(1_001), Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i]))])
    assert.equal(hypothesisOutputSchema.safeParse(withArg(bad)).success, false, JSON.stringify(bad).slice(0, 40));
  for (const good of [{ $t: "NaN" }, { $t: "bigint", v: "-12" }, { $t: "Date", v: "2023-11-14T22:13:20.000Z" }, { $t: "Date", v: "Invalid Date" }, { a: 1, b: [{ $t: "-0" }] }, { $t: "object", v: { $t: "NaN" } }, { $t: "undefined" }])
    assert.equal(hypothesisOutputSchema.safeParse(withArg(good)).success, true, JSON.stringify(good));
  assert.equal(hypothesisOutputSchema.safeParse({ rules: [], partitions: [], extra: 1 }).success, false, "strict");
  assert.equal(hypothesisOutputSchema.safeParse({ rules: [], partitions: [{ label: "x", steps: [] }] }).success, false, "at least one step");
  assert.equal(hypothesisOutputSchema.safeParse({ rules: [], partitions: [{ label: "x", steps: [{ args: Array(9).fill(0) }] }] }).success, false, "at most 8 args");
  assert.equal(survivorOutputSchema.safeParse({ inputs: [], likelyEquivalent: true, reason: "same value" }).success, true);
});

test("matchKeys of both prompts", () => {
  assert.deepEqual(hypothesizePrompt.matchKeys(buildHypothesizeInput(calculateInvoiceInfo, billingText)), { functionId: "billing.js#calculateInvoice" });
  assert.deepEqual(survivorInputsPrompt.matchKeys(survivorInput), { round: 1, mutantId: "m-0007", functionId: "billing.js#applyDiscount" });
  assert.equal(hypothesizePrompt.version, "hypothesize.v1");
  assert.equal(survivorInputsPrompt.version, "survivor-inputs.v1");
  const u = survivorInputsPrompt.buildUser(survivorInput);
  for (const s of ["Function: billing.js#applyDiscount", "Mutant: m-0007", "line 41", ">=", '[100,"VIP"]', "```js"]) assert.ok(u.includes(s), s);
});

test("the fixture schema requires exactly one of output and error", () => {
  const base = { schemaVersion: 1, scenario: "s", targetDir: "fixtures/x", targetSha: "sha256:" + "a".repeat(64), promptHashes: { "hypothesize.v1": "sha256:" + "b".repeat(64) } };
  const turn = { id: "t1", prompt: "hypothesize.v1", when: { functionId: "a.js#f" } };
  const output = { rules: [], partitions: [] };
  assert.equal(llmFixtureSchema.safeParse({ ...base, turns: [{ ...turn, output }] }).success, true);
  assert.equal(llmFixtureSchema.safeParse({ ...base, turns: [{ ...turn, error: { kind: "invalid_output", raw: "{" } }] }).success, true);
  assert.equal(llmFixtureSchema.safeParse({ ...base, turns: [{ ...turn, error: { kind: "timeout" } }] }).success, true);
  assert.equal(llmFixtureSchema.safeParse({ ...base, turns: [{ ...turn, output, error: { kind: "timeout" } }] }).success, false, "both");
  assert.equal(llmFixtureSchema.safeParse({ ...base, turns: [turn] }).success, false, "neither");
  assert.equal(llmFixtureSchema.safeParse({ ...base, turns: [{ ...turn, output }, { ...turn, output }] }).success, false, "duplicate turn id");
  assert.equal(llmFixtureSchema.safeParse({ ...base, turns: [{ ...turn, error: { kind: "explode" } }] }).success, false, "unknown error kind");
});
