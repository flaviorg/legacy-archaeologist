// Derives tests/fixtures/llm/lying-hypotheses.json from the demo fixture (plan delta 12, LLM-03): the same inputs,
// labels, partitions, survivor turns and usage, with every rule statement negated and every checkable prediction
// replaced by a value the code can never produce. `node scripts/make-lying-fixture.ts` writes the file;
// `npm run fixtures:rehash` calls it after rehashing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HypothesisOutput, Prediction } from "../src/contracts/hypotheses.ts";
import type { LlmFixture } from "../src/contracts/llm-fixture.ts";
import { writeJsonText } from "../src/contracts/stable-json.ts";
import { PROJECT_ROOT } from "../src/infra/paths.ts";

export const DEMO_FIXTURE = "fixtures/llm/legacy-billing.json";
export const LYING_FIXTURE = "tests/fixtures/llm/lying-hypotheses.json";
const LYING_SCENARIO = "lying-hypotheses";
const LIE = "lying-prediction";
const MAX_STATEMENT = 300;

// "VIP customers get..." stays "VIP"; "Half cents are..." becomes "half cents are...".
function lowerFirst(text: string): string {
  const second = text.charAt(1);
  return second !== "" && second === second.toLowerCase() ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function lie(p: Prediction): Prediction {
  switch (p.kind) {
    case "returns": return { kind: "returns", value: LIE };
    case "callback": return { kind: "callback", value: LIE };
    case "throws": return { kind: "returns", value: LIE };
    default: return p;
  }
}

function lyingOutput(output: HypothesisOutput): HypothesisOutput {
  return {
    ...output,
    rules: output.rules.map((rule) => ({
      ...rule,
      statement: `It is not true that ${lowerFirst(rule.statement)}`.slice(0, MAX_STATEMENT),
      probes: rule.probes.map((probe) => ({ ...probe, prediction: lie(probe.prediction) })),
    })),
  };
}

/** Pure: the lying fixture for a demo fixture. Only hypothesize turns change; survivor turns are copied as they are. */
export function makeLyingFixture(demo: LlmFixture): LlmFixture {
  return {
    ...demo,
    scenario: LYING_SCENARIO,
    turns: demo.turns.map((turn) => (turn.prompt === "hypothesize.v1" && turn.output !== undefined ? { ...turn, output: lyingOutput(turn.output as HypothesisOutput) } : turn)),
  };
}

export function writeLyingFixture(): boolean {
  const demo = JSON.parse(readFileSync(join(PROJECT_ROOT, DEMO_FIXTURE), "utf8")) as LlmFixture;
  const path = join(PROJECT_ROOT, LYING_FIXTURE);
  const text = writeJsonText(makeLyingFixture(demo));
  let before = "";
  try {
    before = readFileSync(path, "utf8");
  } catch {
    before = "";
  }
  if (before === text) return false;
  writeFileSync(path, text);
  return true;
}

if (import.meta.main) {
  const changed = writeLyingFixture();
  process.stdout.write(`make-lying-fixture: ${LYING_FIXTURE} ${changed ? "written" : "unchanged"}\n`);
}
