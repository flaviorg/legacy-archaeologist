import { redactSecrets } from "./redact.ts";

// Every code of spec 5.6, plus LLM_AUTH, FIXTURE_UNCONSUMED (plan delta 13), DEMO_EXPECTATION (scripts/demo.ts) and INTERNAL.
export type ErrorCode =
  | "USAGE"
  | "TRUST_REQUIRED"
  | "TARGET_NOT_FOUND"
  | "TARGET_SYMLINK"
  | "TARGET_TOO_LARGE"
  | "MODULE_NOT_FOUND_IN_AGAINST"
  | "NO_PROVIDER"
  | "PARSE_FAILED"
  | "NO_FUNCTIONS"
  | "TOO_MANY_FUNCTIONS"
  | "FIXTURE_NOT_FOUND"
  | "FIXTURE_PROMPT_DRIFT"
  | "FIXTURE_TARGET_DRIFT"
  | "FIXTURE_UNCONSUMED"
  | "UNSCRIPTED_LLM_CALL"
  | "LLM_OUTPUT_INVALID"
  | "LLM_UNAVAILABLE"
  | "LLM_AUTH"
  | "CHILD_SPAWN"
  | "CHILD_PROTOCOL"
  | "CHILD_LOAD"
  | "EXTERNAL_DEPENDENCY"
  | "MUTANT_COPY"
  | "VERIFY_FAILED"
  | "GOLDEN_MISMATCH"
  | "DEMO_EXPECTATION"
  | "INTERNAL";

export type ExitCode = 1 | 2 | 3 | 4;

export const EXIT_CODES: Readonly<Record<ErrorCode, ExitCode>> = {
  USAGE: 1,
  TRUST_REQUIRED: 4,
  TARGET_NOT_FOUND: 2,
  TARGET_SYMLINK: 2,
  TARGET_TOO_LARGE: 2,
  MODULE_NOT_FOUND_IN_AGAINST: 2,
  NO_PROVIDER: 2,
  PARSE_FAILED: 2,
  NO_FUNCTIONS: 2,
  TOO_MANY_FUNCTIONS: 2,
  FIXTURE_NOT_FOUND: 2,
  FIXTURE_PROMPT_DRIFT: 2,
  FIXTURE_TARGET_DRIFT: 2,
  FIXTURE_UNCONSUMED: 2,
  UNSCRIPTED_LLM_CALL: 2,
  LLM_OUTPUT_INVALID: 2,
  LLM_UNAVAILABLE: 2,
  LLM_AUTH: 2,
  CHILD_SPAWN: 2,
  CHILD_PROTOCOL: 2,
  CHILD_LOAD: 2,
  EXTERNAL_DEPENDENCY: 2,
  MUTANT_COPY: 2,
  VERIFY_FAILED: 3,
  GOLDEN_MISMATCH: 2,
  DEMO_EXPECTATION: 2,
  INTERNAL: 2,
};

export class LaError extends Error {
  code: ErrorCode;
  exitCode: ExitCode;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LaError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
  }
}

export class UnscriptedLlmCallError extends LaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("UNSCRIPTED_LLM_CALL", message, options);
    this.name = "UnscriptedLlmCallError";
  }
}

const MAX_MESSAGE = 500;

// The one line every non-zero exit prints on stderr: `error: <CODE>: <message>`; never a stack.
export function formatErrorLine(err: unknown, secrets: readonly string[]): { line: string; exitCode: ExitCode } {
  if (!(err instanceof LaError)) return { line: "error: INTERNAL: unexpected error (see the log)", exitCode: 2 };
  const message = redactSecrets(err.message, secrets).replace(/\s*[\r\n]+\s*/g, " ").trim().slice(0, MAX_MESSAGE);
  return { line: `error: ${err.code}: ${message}`, exitCode: err.exitCode };
}
