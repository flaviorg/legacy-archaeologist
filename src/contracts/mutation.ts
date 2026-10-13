// mutation.json and the Mutant (spec 5.12). Types only, so src/prompts can name a Mutant without importing src/mutation.
import type { ToolInfo } from "./map.ts";

export type OperatorId = "AOR" | "ROR" | "LOR" | "NEG" | "NUM" | "BLOCK";
export const OPERATOR_IDS: readonly OperatorId[] = ["AOR", "ROR", "LOR", "NEG", "NUM", "BLOCK"];

export type MutantStatus = "killed" | "timeout" | "survived" | "no-coverage" | "error";

// One mutant: the string splice [start, end) of `file` (UTF-16 offsets) by `replacement`; line 1-based, column 0-based.
export type Mutant = {
  id: string;
  functionId: string;
  file: string;
  operator: OperatorId;
  start: number;
  end: number;
  original: string;
  replacement: string;
  line: number;
  column: number;
};

export type MutantEntry = {
  id: string;
  functionId: string;
  file: string;
  line: number;
  column: number;
  operator: OperatorId;
  original: string;
  replacement: string;
  status: MutantStatus;
  killedBy: string | null;
  roundKilled: number | null;
  llmSuggestedEquivalent: { reason: string } | null;
};

export type MutationRound = {
  round: number;
  survivorsConsidered: string[];
  inputsProposed: number;
  inputsAccepted: number;
  inputsRejected: { reason: string; count: number }[];
  newCases: string[];
  killed: string[];
  scoreBefore: number;
  scoreAfter: number;
};

export type OperatorScore = { killed: number; timeout: number; survived: number; noCoverage: number; mutationScore: number };

export type MutationScore = {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  error: number;
  detected: number;
  valid: number;
  mutationScore: number;
  byOperator: Record<OperatorId, OperatorScore>;
};

export type MutationReport = {
  schemaVersion: 1;
  tool: ToolInfo;
  targetSha: string;
  operators: OperatorId[];
  truncated: number;
  invalid: number;
  replayedCases: string[];
  mutants: MutantEntry[];
  rounds: MutationRound[];
  score: MutationScore;
};
