// The DEMO-05 eval table: a provider's run against the `none` baseline on the same target, computed from the three
// artifacts of each run. Pure; scripts/eval-llm.ts reads the files and prints the table.
import type { HypothesesFile } from "../contracts/hypotheses.ts";
import type { MutationReport } from "../contracts/mutation.ts";
import type { RecordsFile } from "../contracts/records.ts";
import { LaError } from "../infra/errors.ts";
import { evaluateRules } from "./evaluate-rules.ts";

export type RunArtifacts = { hypotheses: HypothesesFile; records: RecordsFile; mutation: MutationReport };

export type EvalRow = { metric: string; baseline: string; candidate: string; delta: string };

export type EvalTable = { targetSha: string; baseline: string; candidate: string; rows: EvalRow[] };

const DASH = "—";

/** The column label of a run: `none`, `fake (scripted)` or `openai-compatible (<model>)`. */
function runLabel(h: Pick<HypothesesFile, "provider" | "model">): string {
  if (h.provider === "none") return "none";
  if (h.provider === "fake") return "fake (scripted)";
  return `openai-compatible (${h.model})`;
}

type Metrics = {
  rules: Record<"consistent" | "contradicted" | "unverified", number>;
  proposed: number;
  acceptedRound0: number;
  rejected: Map<string, number>;
  cases: number;
  stable: number;
  survivorAccepted: number;
  survivorKilled: number;
  score: number;
};

function metricsOf(run: RunArtifacts): Metrics {
  const { rules } = evaluateRules(run.hypotheses.functions, run.records.cases);
  const count = (status: string): number => rules.filter((r) => r.status === status).length;
  const rejected = new Map<string, number>();
  // Round 0 only, like `inputs proposed` and `inputs accepted (round 0)`; survivor inputs have their own rows.
  for (const r of run.hypotheses.rejected.filter((x) => x.origin !== "survivor-round")) rejected.set(r.reason, (rejected.get(r.reason) ?? 0) + 1);
  return {
    rules: { consistent: count("consistent"), contradicted: count("contradicted"), unverified: count("unverified") },
    proposed: run.hypotheses.functions.reduce((n, f) => n + f.output.partitions.length + f.output.rules.reduce((p, r) => p + r.probes.length, 0), 0),
    acceptedRound0: run.records.cases.filter((c) => c.round === 0 && c.origin !== "boundary-expansion").length,
    rejected,
    cases: run.records.cases.length,
    stable: run.records.cases.filter((c) => c.determinism === "stable").length,
    survivorAccepted: run.mutation.rounds.reduce((n, r) => n + r.inputsAccepted, 0),
    survivorKilled: run.mutation.rounds.reduce((n, r) => n + r.killed.length, 0),
    score: run.mutation.score.mutationScore,
  };
}

const signed = (n: number, digits = 0, suffix = ""): string => {
  const text = Math.abs(n).toFixed(digits);
  if (Number(text) === 0) return `${text}${suffix}`;
  return `${n > 0 ? "+" : "-"}${text}${suffix}`;
};

function countRow(metric: string, a: number, b: number): EvalRow {
  return { metric, baseline: a.toLocaleString("en-US"), candidate: b.toLocaleString("en-US"), delta: signed(b - a) };
}

function killsPerInput(m: Metrics): number | null {
  return m.survivorAccepted === 0 ? null : m.survivorKilled / m.survivorAccepted;
}

/** Refuses runs of different targets (USAGE); rows in the fixed order of spec 5.1 and plan Task 33. */
export function evalLlm(baseline: RunArtifacts, candidate: RunArtifacts): EvalTable {
  const shas = new Set([baseline.hypotheses.targetSha, baseline.records.targetSha, baseline.mutation.targetSha, candidate.hypotheses.targetSha, candidate.records.targetSha, candidate.mutation.targetSha]);
  if (shas.size !== 1) throw new LaError("USAGE", "the two runs have different targetSha");
  const a = metricsOf(baseline);
  const b = metricsOf(candidate);
  const rows: EvalRow[] = [
    countRow("rules consistent", a.rules.consistent, b.rules.consistent),
    countRow("rules contradicted", a.rules.contradicted, b.rules.contradicted),
    countRow("rules unverified", a.rules.unverified, b.rules.unverified),
    countRow("inputs proposed", a.proposed, b.proposed),
    countRow("inputs accepted (round 0)", a.acceptedRound0, b.acceptedRound0),
  ];
  const reasons = [...new Set([...a.rejected.keys(), ...b.rejected.keys()])].sort();
  for (const reason of reasons) rows.push(countRow(`inputs rejected · ${reason}`, a.rejected.get(reason) ?? 0, b.rejected.get(reason) ?? 0));
  rows.push(
    countRow("cases recorded", a.cases, b.cases),
    countRow("stable cases", a.stable, b.stable),
    countRow("survivor inputs accepted", a.survivorAccepted, b.survivorAccepted),
    countRow("mutants killed in survivor rounds", a.survivorKilled, b.survivorKilled),
  );
  const ka = killsPerInput(a);
  const kb = killsPerInput(b);
  rows.push({ metric: "kills per accepted survivor input", baseline: ka === null ? "n/a" : ka.toFixed(2), candidate: kb === null ? "n/a" : kb.toFixed(2), delta: ka === null || kb === null ? DASH : signed(kb - ka, 2) });
  rows.push({ metric: "mutation score", baseline: `${a.score.toFixed(1)}%`, candidate: `${b.score.toFixed(1)}%`, delta: signed(b.score - a.score, 1, " pts") });
  return { targetSha: baseline.hypotheses.targetSha, baseline: runLabel(baseline.hypotheses), candidate: runLabel(candidate.hypotheses), rows };
}

const cell = (text: string): string => text.replace(/\|/g, "\\|");

export function renderEvalTable(t: EvalTable): string {
  const lines = [`| Metric | ${cell(t.baseline)} | ${cell(t.candidate)} | Delta |`, "|---|---|---|---|"];
  for (const r of t.rows) lines.push(`| ${cell(r.metric)} | ${cell(r.baseline)} | ${cell(r.candidate)} | ${cell(r.delta)} |`);
  return lines.join("\n") + "\n";
}
