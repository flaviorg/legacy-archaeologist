import test from "node:test";
import assert from "node:assert/strict";
import type { HypothesisOutput } from "../../src/contracts/hypotheses.ts";
import { hypothesisOutputSchema } from "../../src/contracts/hypotheses.ts";
import type { LlmFixture } from "../../src/contracts/llm-fixture.ts";
import { writeJsonText } from "../../src/contracts/stable-json.ts";
import { makeLyingFixture } from "../../scripts/make-lying-fixture.ts";
import { readRepoFile } from "../helpers/repo-files.ts";

const demo = (): LlmFixture => JSON.parse(readRepoFile("fixtures/llm/legacy-billing.json")) as LlmFixture;

test("[LLM-03] the committed lying fixture is exactly makeLyingFixture of the demo fixture", () => {
  assert.equal(readRepoFile("tests/fixtures/llm/lying-hypotheses.json"), writeJsonText(makeLyingFixture(demo())));
});

test("[LLM-03] the lying fixture keeps every input and label, negates every statement and replaces every checkable prediction", () => {
  const original = demo();
  const lying = makeLyingFixture(original);
  assert.equal(lying.scenario, "lying-hypotheses");
  assert.deepEqual([lying.targetDir, lying.targetSha, lying.promptHashes], [original.targetDir, original.targetSha, original.promptHashes]);
  assert.deepEqual(lying.turns.map((t) => [t.id, t.prompt, t.when, t.usage]), original.turns.map((t) => [t.id, t.prompt, t.when, t.usage]));
  original.turns.forEach((turn, i) => {
    if (turn.prompt !== "hypothesize.v1") {
      assert.deepEqual(lying.turns[i], turn, `${turn.id}: survivor turns are copied as they are`);
      return;
    }
    const before = turn.output as HypothesisOutput;
    const after = lying.turns[i]!.output as HypothesisOutput;
    assert.ok(hypothesisOutputSchema.safeParse(after).success, turn.id);
    assert.deepEqual(after.partitions, before.partitions);
    after.rules.forEach((rule, r) => {
      const src = before.rules[r]!;
      assert.ok(rule.statement.startsWith("It is not true that ") && rule.statement !== src.statement);
      assert.deepEqual(rule.probes.map((p) => [p.label, p.steps]), src.probes.map((p) => [p.label, p.steps]));
      rule.probes.forEach((p, k) => {
        const kind = src.probes[k]!.prediction.kind;
        assert.deepEqual(p.prediction, kind === "unknown" ? { kind: "unknown" } : { kind: kind === "callback" ? "callback" : "returns", value: "lying-prediction" });
      });
    });
  });
  assert.ok(original.turns.some((t) => t.prompt === "survivor-inputs.v1"), "the demo fixture has survivor turns");
  assert.ok(lying.turns.some((t) => t.prompt === "hypothesize.v1" && (t.output as HypothesisOutput).rules.some((r) => r.statement === "It is not true that VIP customers get 10% off orders of 100.00 or more.")));
});
