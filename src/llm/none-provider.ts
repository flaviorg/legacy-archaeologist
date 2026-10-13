// The `none` mode: no LLM at all; proposals come from the baseline value table (HYP-06). Not an LlmProvider.
import type { HypothesisOutput } from "../contracts/hypotheses.ts";
import type { FunctionInfo } from "../contracts/map.ts";
import { baselineProposals } from "../pipeline/baseline-inputs.ts";

export const NONE_PROVIDER = { provider: "none", model: "none" } as const;

/** The proposals of the `none` mode: the baseline value table, a pure function of the map (HYP-06). */
export function noneProposals(fn: FunctionInfo): HypothesisOutput {
  return baselineProposals(fn);
}
