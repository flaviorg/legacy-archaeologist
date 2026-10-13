// The only module besides src/cli.ts and scripts/ that reads environment values (dependency rule 6);
// it receives them as a plain object, so tests pass explicit config objects.
import * as z from "zod";
import { LaError } from "./errors.ts";
import type { LogLevel } from "./logger.ts";

export type Config = {
  provider: "none" | "fake" | "openai-compatible" | null;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  caseTimeoutMs: number;
  watchdogMarginMs: number;
  maxMutants: number;
  maxRounds: number;
  logLevel: LogLevel;
};

export const CONFIG_ENV_KEYS = [
  "LLM_PROVIDER",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_TIMEOUT_MS",
  "LA_CASE_TIMEOUT_MS",
  "LA_WATCHDOG_MARGIN_MS",
  "LA_MAX_MUTANTS",
  "LA_MAX_ROUNDS",
  "LOG_LEVEL",
] as const;

type EnvKey = (typeof CONFIG_ENV_KEYS)[number];

const PROVIDERS = ["none", "fake", "openai-compatible"] as const;
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

const DEFAULTS = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "openrouter/free",
} as const;

// Spec 5.7 ranges.
const INT_RANGES: Record<"LLM_TIMEOUT_MS" | "LA_CASE_TIMEOUT_MS" | "LA_WATCHDOG_MARGIN_MS" | "LA_MAX_MUTANTS" | "LA_MAX_ROUNDS", { min: number; max: number; def: number }> = {
  LLM_TIMEOUT_MS: { min: 1000, max: 120_000, def: 30_000 },
  LA_CASE_TIMEOUT_MS: { min: 100, max: 30_000, def: 2000 },
  LA_WATCHDOG_MARGIN_MS: { min: 100, max: 10_000, def: 1000 },
  LA_MAX_MUTANTS: { min: 1, max: 2000, def: 200 },
  LA_MAX_ROUNDS: { min: 0, max: 3, def: 1 },
};

// An empty value counts as unset, so a blank line in .env falls back to the default.
function read(env: Record<string, string | undefined>, key: EnvKey): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

// Errors name the variable and the expected shape, never the value (LLM-06).
function intVar(env: Record<string, string | undefined>, key: keyof typeof INT_RANGES): number {
  const { min, max, def } = INT_RANGES[key];
  const raw = read(env, key);
  if (raw === undefined) return def;
  const schema = z.string().regex(/^-?\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new LaError("USAGE", `${key}: expected an integer from ${min} to ${max}`);
  return parsed.data;
}

function enumVar<T extends string>(env: Record<string, string | undefined>, key: EnvKey, values: readonly [T, ...T[]]): T | undefined {
  const raw = read(env, key);
  if (raw === undefined) return undefined;
  const parsed = z.enum(values).safeParse(raw);
  if (!parsed.success) throw new LaError("USAGE", `${key}: expected one of ${values.join(", ")}`);
  return parsed.data;
}

function urlVar(env: Record<string, string | undefined>, key: EnvKey, def: string): string {
  const raw = read(env, key) ?? def;
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(raw);
  if (!parsed.success) throw new LaError("USAGE", `${key}: expected an http or https URL`);
  return parsed.data.replace(/\/+$/, "");
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const provider = enumVar(env, "LLM_PROVIDER", PROVIDERS) ?? null;
  const apiKey = read(env, "LLM_API_KEY") ?? "";
  const config: Config = {
    provider,
    baseUrl: urlVar(env, "LLM_BASE_URL", DEFAULTS.baseUrl),
    apiKey,
    model: read(env, "LLM_MODEL") ?? DEFAULTS.model,
    timeoutMs: intVar(env, "LLM_TIMEOUT_MS"),
    caseTimeoutMs: intVar(env, "LA_CASE_TIMEOUT_MS"),
    watchdogMarginMs: intVar(env, "LA_WATCHDOG_MARGIN_MS"),
    maxMutants: intVar(env, "LA_MAX_MUTANTS"),
    maxRounds: intVar(env, "LA_MAX_ROUNDS"),
    logLevel: enumVar(env, "LOG_LEVEL", LOG_LEVELS) ?? "info",
  };
  if (provider === "openai-compatible" && apiKey === "") {
    throw new LaError("LLM_AUTH", "LLM_API_KEY is required for LLM_PROVIDER=openai-compatible");
  }
  return config;
}
