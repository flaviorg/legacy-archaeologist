// report.json (spec 5.11): rule statuses, suspicious behaviors and what was not characterized. Types only.
import type { HypothesesFile, Prediction } from "./hypotheses.ts";
import type { ToolInfo } from "./map.ts";
import type { Outcome } from "./outcomes.ts";
import type { RecordsFile } from "./records.ts";
import type { Tagged } from "./tagged.ts";

export type RuleStatus = "consistent" | "contradicted" | "unverified";

export type EvaluatedProbe = {
  label: string;
  caseId: string | null;          // null when the planner rejected the probe
  args: Tagged[][];               // one entry per step
  prediction: Prediction;
  observed: Outcome | null;       // the recorded outcome of the last step
  matched: boolean | null;        // null when the probe is not checkable
};

export type EvaluatedRule = {
  functionId: string;
  ruleId: string;
  key: string;
  statement: string;
  relatedConstants: number[];
  status: RuleStatus;
  probesChecked: number;
  probes: EvaluatedProbe[];
};

export type SuspiciousBehavior = {
  id: string;                     // "SB-01"
  functionId: string;
  ruleId: string;
  statement: string;
  probeLabel: string;
  caseId: string;
  args: Tagged[][];
  predicted: Prediction;
  observed: Outcome;
};

export type NotCharacterizedReason = "unstable" | "timeout" | "no-callback" | "sandbox-only outcome" | "leaked-error";

export type NotCharacterized = { caseId: string; reason: NotCharacterizedReason; detail: string };

export type ReportFile = {
  schemaVersion: 1;
  tool: ToolInfo;
  targetSha: string;
  provider: HypothesesFile["provider"];
  model: string;
  scenario?: string;
  rules: EvaluatedRule[];
  suspicious: SuspiciousBehavior[];
  notCharacterized: NotCharacterized[];
  loadErrors: RecordsFile["loadErrors"];
  tests: { module: string; file: string; count: number }[];
  mutation: { mutationScore: number; detected: number; valid: number } | null;
};
