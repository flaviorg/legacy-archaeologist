import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG_ENV_KEYS, loadConfig } from "../../src/infra/config.ts";
import type { LaError } from "../../src/infra/errors.ts";

test("[LLM-06] config errors name the variable, never the value", () => {
  assert.throws(() => loadConfig({ LLM_TIMEOUT_MS: "999999999" }), (e: LaError) => e.code === "USAGE" && e.message.includes("LLM_TIMEOUT_MS") && !e.message.includes("999999999"));
  assert.throws(() => loadConfig({ LLM_TIMEOUT_MS: "999999999" }), { message: "LLM_TIMEOUT_MS: expected an integer from 1000 to 120000" });
  assert.throws(() => loadConfig({ LA_MAX_ROUNDS: "1.5" }), { code: "USAGE", message: "LA_MAX_ROUNDS: expected an integer from 0 to 3" });
  assert.throws(() => loadConfig({ LLM_PROVIDER: "secret-ish-value" }), (e: LaError) => e.code === "USAGE" && e.message.startsWith("LLM_PROVIDER:") && !e.message.includes("secret-ish-value"));
  assert.throws(() => loadConfig({ LOG_LEVEL: "loud" }), { code: "USAGE", message: "LOG_LEVEL: expected one of debug, info, warn, error" });
  assert.throws(() => loadConfig({ LLM_BASE_URL: "not a url" }), { code: "USAGE", message: "LLM_BASE_URL: expected an http or https URL" });
});

test("config defaults follow spec 5.7", () => {
  assert.deepEqual(loadConfig({}), { provider: null, baseUrl: "https://openrouter.ai/api/v1", apiKey: "", model: "openrouter/free", timeoutMs: 30000, caseTimeoutMs: 2000, watchdogMarginMs: 1000, maxMutants: 200, maxRounds: 1, logLevel: "info" });
});

test("[LLM-06] openai-compatible without a key fails early with LLM_AUTH", () => {
  assert.throws(() => loadConfig({ LLM_PROVIDER: "openai-compatible" }), { code: "LLM_AUTH", message: "LLM_API_KEY is required for LLM_PROVIDER=openai-compatible" });
});

test("explicit values are parsed and the base URL loses its trailing slash", () => {
  const key = "sk-or-v1-" + "c".repeat(40);
  const c = loadConfig({ LLM_PROVIDER: "openai-compatible", LLM_API_KEY: key, LLM_BASE_URL: "http://127.0.0.1:11434/v1/", LLM_MODEL: "m", LLM_TIMEOUT_MS: "1000", LA_CASE_TIMEOUT_MS: "300", LA_WATCHDOG_MARGIN_MS: "100", LA_MAX_MUTANTS: "2000", LA_MAX_ROUNDS: "0", LOG_LEVEL: "debug" });
  assert.deepEqual(c, { provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", apiKey: key, model: "m", timeoutMs: 1000, caseTimeoutMs: 300, watchdogMarginMs: 100, maxMutants: 2000, maxRounds: 0, logLevel: "debug" });
});

test("an empty variable counts as unset", () => {
  assert.deepEqual(loadConfig({ LLM_PROVIDER: "", LLM_TIMEOUT_MS: "" }), loadConfig({}));
});

test("CONFIG_ENV_KEYS lists every variable loadConfig reads", () => {
  assert.deepEqual([...CONFIG_ENV_KEYS], ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_TIMEOUT_MS", "LA_CASE_TIMEOUT_MS", "LA_WATCHDOG_MARGIN_MS", "LA_MAX_MUTANTS", "LA_MAX_ROUNDS", "LOG_LEVEL"]);
});
