// Numeric limits of spec 6.1 that more than one component needs. Imports nothing.

export type CaseLimits = {
  maxCasesPerFunction: number;
  maxExpansionsPerCase: number;
  maxExpansionsPerFunction: number;
  maxDepth: number;
  maxSteps: number;
  maxArgs: number;
};

export const DEFAULT_CASE_LIMITS: CaseLimits = {
  maxCasesPerFunction: 40,
  maxExpansionsPerCase: 4,
  maxExpansionsPerFunction: 12,
  maxDepth: 5,
  maxSteps: 5,
  maxArgs: 8,
};

// What the stage copies: every walked file counts, all types (spec 5.6 TARGET_TOO_LARGE).
export const STAGE_LIMITS = { maxFiles: 200, maxBytes: 2 * 1024 * 1024 } as const;

// Output caps on the recorder child (spec 5.4); crossing one kills the child with reason output-cap.
export const CHILD_CAPS = { stdoutBytes: 4 * 1024 * 1024, stderrBytes: 64 * 1024, fd3LineBytes: 1024 * 1024 } as const;
