// Planned and recorded cases, records.json and timings.json (spec 5.1, plan deltas 4 and 20).
import type { CaseLimits } from "./limits.ts";
import type { ToolInfo } from "./map.ts";
import type { Outcome } from "./outcomes.ts";
import type { Tagged } from "./tagged.ts";

export type CaseId = string;

export type CaseOrigin = "rule-probe" | "partition" | "boundary-expansion" | "survivor-round" | "baseline";

export type PlannedCase = {
  id: CaseId;                       // "<functionId>#c<nn>"
  functionId: string;
  moduleFile: string;
  exportName: string;
  style: "sync" | "callback";
  origin: CaseOrigin;
  ruleRefs: string[];
  round: number;
  mutantRef?: string;
  expandsCase?: CaseId;             // set on boundary-expansion cases
  label: string;
  steps: { args: Tagged[] }[];
};

export type RecordedStep = { args: Tagged[]; outcome: Outcome };

export type Instability = { step: number /* 1-based; 0 means stateAfter differed */; firstRun: Outcome; secondRun: Outcome };

export type RecordedCase = Omit<PlannedCase, "steps"> & {
  steps: RecordedStep[];
  stateAfter: Tagged | null;
  consoleLines: number;
  determinism: "stable" | "unstable";
  instability?: Instability;
};

export type LoadError = { module: string; code: "CHILD_LOAD" | "EXTERNAL_DEPENDENCY"; error: string };

export type RecordsFile = {
  schemaVersion: 1;
  tool: ToolInfo;
  targetSha: string;
  world: { clockNow: number; seed: number; tz: "UTC" };
  limits: CaseLimits;
  cases: RecordedCase[];
  loadErrors: LoadError[];
};

export type TimingsFile = {
  schemaVersion: 1;
  tool: ToolInfo;
  targetSha: string;
  cases: Record<CaseId, { stepDurationsMs: number[] }>;
  batches: { kind: "probe" | "replay"; mutantId: string | null; durationMs: number; respawns: number }[];
};
