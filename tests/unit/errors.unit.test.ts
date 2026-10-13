import test from "node:test";
import assert from "node:assert/strict";
import { EXIT_CODES, LaError, UnscriptedLlmCallError, formatErrorLine } from "../../src/infra/errors.ts";

test("[REP-06] formatErrorLine prints one line with code and message, no stack, at most 500 characters", () => {
  const { line, exitCode } = formatErrorLine(new LaError("TARGET_NOT_FOUND", "x".repeat(900) + "\n  at foo"), []);
  assert.match(line, /^error: TARGET_NOT_FOUND: x+/);
  assert.ok(!line.includes("\n"));
  assert.ok(line.length <= "error: TARGET_NOT_FOUND: ".length + 500);
  assert.equal(exitCode, 2);
});

test("[REP-06] an unexpected error becomes INTERNAL with exit 2", () => {
  assert.deepEqual(formatErrorLine(new TypeError("boom"), []), { line: "error: INTERNAL: unexpected error (see the log)", exitCode: 2 });
});

test("[REP-06] the message is redacted and newlines collapse to single spaces", () => {
  const key = "sk-or-v1-" + "a".repeat(40);
  const { line } = formatErrorLine(new LaError("LLM_UNAVAILABLE", `failed with ${key}\n  and custom-secret-value`), ["custom-secret-value"]);
  assert.equal(line, "error: LLM_UNAVAILABLE: failed with [REDACTED] and [REDACTED]");
});

test("exit codes: USAGE 1, VERIFY_FAILED 3, TRUST_REQUIRED 4, everything else 2", () => {
  assert.equal(EXIT_CODES.USAGE, 1);
  assert.equal(EXIT_CODES.VERIFY_FAILED, 3);
  assert.equal(EXIT_CODES.TRUST_REQUIRED, 4);
  for (const code of ["TARGET_NOT_FOUND", "LLM_AUTH", "FIXTURE_UNCONSUMED", "INTERNAL", "CHILD_PROTOCOL", "GOLDEN_MISMATCH"] as const) assert.equal(EXIT_CODES[code], 2);
  const err = new LaError("USAGE", "bad flag");
  assert.equal(err.exitCode, 1);
  assert.ok(err instanceof Error);
});

test("UnscriptedLlmCallError is a LaError with code UNSCRIPTED_LLM_CALL", () => {
  const err = new UnscriptedLlmCallError("no turn for billing.js#roundMoney");
  assert.ok(err instanceof LaError);
  assert.equal(err.code, "UNSCRIPTED_LLM_CALL");
  assert.equal(err.exitCode, 2);
});
