// Hypothesize stage: one hypothesize.v1 call per exported function (or the baseline table with `none`), then the
// planner. Writes hypotheses.json and llm-trace.jsonl (empty with `none`).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HypothesesFile, HypothesisOutput, Usage } from "../contracts/hypotheses.ts";
import { DEFAULT_CASE_LIMITS } from "../contracts/limits.ts";
import type { StaticMap } from "../contracts/map.ts";
import type { PlannedCase } from "../contracts/records.ts";
import { writeJsonText } from "../contracts/stable-json.ts";
import type { Logger } from "../infra/logger.ts";
import { TOOL_INFO } from "../infra/version.ts";
import { NONE_PROVIDER, noneProposals } from "../llm/none-provider.ts";
import { callLlm } from "../llm/provider.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { createTraceWriter } from "../llm/trace.ts";
import type { TraceWriter } from "../llm/trace.ts";
import { buildHypothesizeInput, hypothesizePrompt } from "../prompts/v1/hypothesize.ts";
import { planCases } from "./plan-cases.ts";

export type ProviderChoice = { kind: "none" } | { kind: "llm"; llm: LlmProvider; name: "fake" | "openai-compatible"; model: string; scenario?: string };

const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0 };

/**
 * Functions skipped later for EXTERNAL_DEPENDENCY are still hypothesized here (the record stage skips them).
 * When a call fails, the trace written so far is kept on disk (it holds both raw texts of an invalid output).
 */
export async function runHypothesizeStage(opts: {
  map: StaticMap;
  files: { path: string; text: string }[];
  provider: ProviderChoice;
  outDir: string;
  logger: Logger;
  secrets: readonly string[];
}): Promise<{ hypotheses: HypothesesFile; planned: PlannedCase[]; trace: TraceWriter }> {
  const started = performance.now();
  const providerName = opts.provider.kind === "none" ? NONE_PROVIDER.provider : opts.provider.name;
  opts.logger.info("stage_start", { stage: "hypothesize", provider: providerName });
  const trace = createTraceWriter(opts.secrets);
  const texts = new Map(opts.files.map((f) => [f.path, f.text] as const));
  const functions: HypothesesFile["functions"] = [];
  const rejected: HypothesesFile["rejected"] = [];
  const planned: PlannedCase[] = [];
  mkdirSync(opts.outDir, { recursive: true });
  const writeTrace = (): void => writeFileSync(join(opts.outDir, "llm-trace.jsonl"), trace.text());

  for (const mod of opts.map.modules) {
    for (const fn of mod.functions) {
      let output: HypothesisOutput;
      let usage = ZERO_USAGE;
      let seq: number | null = null;
      if (opts.provider.kind === "none") {
        output = noneProposals(fn);
      } else {
        try {
          output = await callLlm(opts.provider.llm, hypothesizePrompt, buildHypothesizeInput(fn, texts.get(mod.file) ?? ""), { trace, secrets: opts.secrets, logger: opts.logger });
        } catch (err) {
          writeTrace();
          throw err;
        }
        seq = trace.lastSeq();
        usage = trace.entries()[seq - 1]?.usage ?? ZERO_USAGE;
      }
      const plan = planCases(fn, output, DEFAULT_CASE_LIMITS, [], { kind: opts.provider.kind === "none" ? "baseline" : "llm", round: 0 });
      functions.push({ functionId: fn.id, output, usage });
      planned.push(...plan.cases);
      rejected.push(...plan.rejected);
      if (seq !== null) trace.setRejected(seq, plan.rejected.map((r) => ({ label: r.label, reason: r.reason })));
      for (const r of plan.rejected) opts.logger.info("input_rejected", { functionId: r.functionId, label: r.label, reason: r.reason, ...(r.ruleKey !== undefined ? { ruleKey: r.ruleKey } : {}) });
    }
  }

  const hypotheses: HypothesesFile = {
    schemaVersion: 1,
    tool: TOOL_INFO,
    targetSha: opts.map.targetSha,
    provider: providerName,
    model: opts.provider.kind === "none" ? NONE_PROVIDER.model : opts.provider.model,
    ...(opts.provider.kind === "llm" && opts.provider.scenario !== undefined ? { scenario: opts.provider.scenario } : {}),
    functions,
    rejected,
  };
  writeFileSync(join(opts.outDir, "hypotheses.json"), writeJsonText(hypotheses));
  writeTrace();
  opts.logger.info("stage_done", {
    stage: "hypothesize",
    durationMs: Math.round(performance.now() - started),
    functions: functions.length,
    accepted: planned.length,
    rejected: rejected.length,
  });
  return { hypotheses, planned, trace };
}
