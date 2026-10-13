// The job as the child reads it (spec 5.4). The parent's typed version is src/harness/protocol.ts, which the child
// cannot import (it uses zod); these structural types are the subset the child relies on.
import type { Outcome } from "../../contracts/outcomes.ts";
import type { Tagged, TaggedLimits } from "../../contracts/tagged.ts";

export type ChildCase = {
  id: string;
  exportName: string;
  style: "sync" | "callback";
  steps: { args: Tagged[] }[];
  callbackIndex: number | null;
};

export type ChildJobIn = {
  kind: "probe" | "replay";
  modulePath: string;
  moduleKind: "commonjs" | "module";
  targetRoot: string;
  exportNames: string[];
  cases: ChildCase[];
  world: { clockNow: number; seed: number };
  caseTimeoutMs: number;
  caseTimeoutsMs?: Record<string, number>;
  limits: TaggedLimits;
};

export type StepResult = { args: Tagged[]; outcome: Outcome };

export type CaseResult = { steps: StepResult[]; stateAfter: Tagged | null; durationsMs: number[] };
