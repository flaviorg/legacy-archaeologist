// CLI entry (spec 5.5): parseArgs with strict: true, the trust gate, exit codes and one `error: <CODE>: <message>` line.
import { statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./infra/config.ts";
import type { Config } from "./infra/config.ts";
import { LaError, formatErrorLine } from "./infra/errors.ts";
import { createLogger } from "./infra/logger.ts";
import type { LogLevel, Logger } from "./infra/logger.ts";
import { ARTIFACTS_DIR, FIXTURES_DIR, isInsideOrEqual, relativeToProject, resolveOutDir, resolveTarget } from "./infra/paths.ts";
import { formatMapSummary, runMapStage } from "./pipeline/map.ts";
import { OPERATOR_NAMES, defaultScenario, resolveRunPaths, resolveScenarioPath, runPipeline } from "./pipeline/run.ts";
import type { MutationReport, OperatorId } from "./contracts/mutation.ts";
import type { RunResult } from "./pipeline/run.ts";
import { formatVerify, runVerify, verifyTotals } from "./pipeline/verify.ts";

export type Io = { stdout(s: string): void; stderr(s: string): void };

const OPTIONS = {
  target: { type: "string" },
  out: { type: "string" },
  only: { type: "string" },
  "i-trust-this-code": { type: "boolean" },
  "log-level": { type: "string" },
  provider: { type: "string" },
  scenario: { type: "string" },
  seed: { type: "string" },
  clock: { type: "string" },
  "case-timeout-ms": { type: "string" },
  "max-mutants": { type: "string" },
  "max-rounds": { type: "string" },
  "survivors-per-round": { type: "string" },
  "inputs-per-survivor": { type: "string" },
  operators: { type: "string" },
  "tests-dir": { type: "string" },
  against: { type: "string" },
  "file-timeout-ms": { type: "string" },
} as const;

// Options only `run` accepts; `map` refuses them.
const RUN_ONLY = ["provider", "scenario", "seed", "clock", "case-timeout-ms", "max-mutants", "max-rounds", "survivors-per-round", "inputs-per-survivor", "operators", "tests-dir"] as const;
// Options only `verify` accepts; `map` and `run` refuse them.
const VERIFY_ONLY = ["against", "file-timeout-ms"] as const;
// Everything `verify` accepts.
const VERIFY_OPTIONS: readonly string[] = ["against", "out", "tests-dir", "file-timeout-ms", "i-trust-this-code", "log-level"];
const PROVIDERS = ["none", "fake", "openai-compatible"] as const;
type ProviderName = (typeof PROVIDERS)[number];

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const USAGE_TEXT = [
  "usage: la map --target <dir> [--out <dir>] [--only <functionId,...>] [--i-trust-this-code] [--log-level <level>]",
  "       la run --target <dir> [--out <dir>] [--only <functionId,...>] [--provider none|fake|openai-compatible] [--scenario <name>] [--seed <n>] [--clock <ms>] [--case-timeout-ms <ms>] [--max-mutants <n>] [--max-rounds <n>] [--survivors-per-round <n>] [--inputs-per-survivor <n>] [--operators AOR,ROR,...] [--tests-dir <dir>] [--i-trust-this-code]",
  "       la verify --against <dir> [--out <dir>] [--tests-dir <dir>] [--file-timeout-ms <ms>] [--i-trust-this-code]",
].join("\n");

// Printed when a target outside fixtures/ is given without --i-trust-this-code (SAFE-07, spec 6.3).
const THREAT_SUMMARY: readonly string[] = [
  "legacy-archaeologist runs the target's code: only point it at code you trust and would already run on this machine.",
  "The recording child cannot write files, spawn processes, start workers or load addons, and reads only the target and the tool's harness.",
  "Network calls are blocked by a guard loaded into the child, not by Node's --permission model; a module with its own native socket code would bypass it.",
  "The read grant covers everything in the target directory except dot-files (.env, .npmrc and the like are never copied); every other file is copied under --out and readable by the child: point the tool at the module's folder, not at a repository root.",
  "For untrusted code, run the whole tool inside a container or a VM.",
];

function firstSentence(message: string): string {
  const line = message.split("\n")[0] ?? message;
  const dot = line.indexOf(". ");
  return dot === -1 ? line : line.slice(0, dot);
}

// Code that will run (a target, an --against copy, a --tests-dir) needs --i-trust-this-code outside the trusted roots.
function trustGate(dirReal: string, trusted: boolean, io: Io, logger: Logger, gate: { roots: readonly string[]; what: string } = { roots: [FIXTURES_DIR], what: "the target is outside fixtures/" }): void {
  if (gate.roots.some((root) => isInsideOrEqual(dirReal, root))) return;
  if (trusted) {
    logger.info("trust_gate", { decision: "trusted", target: dirReal });
    return;
  }
  logger.warn("trust_gate", { decision: "refused", target: dirReal });
  io.stderr(THREAT_SUMMARY.join("\n") + "\n");
  throw new LaError("TRUST_REQUIRED", `${gate.what}; read the summary above and re-run with --i-trust-this-code`);
}

type Values = { target?: string; out?: string; only?: string; "i-trust-this-code"?: boolean; "log-level"?: string } & { [K in (typeof RUN_ONLY)[number] | (typeof VERIFY_ONLY)[number]]?: string };

const firstUsageLine = (): string => USAGE_TEXT.split("\n")[0]!;

function parseOnly(raw: string | undefined): string[] | undefined {
  return raw?.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

function mapCommand(values: Values, io: Io, logger: Logger): number {
  if (values.target === undefined || values.target === "") throw new LaError("USAGE", `map needs --target <dir>; ${firstUsageLine()}`);
  const runOnly = RUN_ONLY.find((k) => values[k] !== undefined);
  if (runOnly) throw new LaError("USAGE", `--${runOnly} is an option of run, not of map`);
  const verifyOnly = VERIFY_ONLY.find((k) => values[k] !== undefined);
  if (verifyOnly) throw new LaError("USAGE", `--${verifyOnly} is an option of verify, not of map`);
  const targetReal = resolveTarget(values.target);
  if (!statSync(targetReal).isDirectory()) {
    throw new LaError("USAGE", `--target must be a directory; pass the folder that contains ${basename(targetReal)} and use --only to pick functions`);
  }
  trustGate(targetReal, values["i-trust-this-code"] === true, io, logger);
  const outDir = resolveOutDir(values.out ?? join("artifacts", basename(targetReal)));
  if (isInsideOrEqual(outDir, targetReal) || isInsideOrEqual(targetReal, outDir)) {
    throw new LaError("USAGE", "--out must not be inside, equal to or contain the target");
  }
  const only = parseOnly(values.only);
  const { map } = runMapStage({ targetReal, outDir, ...(only ? { only } : {}), logger });
  io.stdout(formatMapSummary(map) + "\n");
  return 0;
}

function intOption(values: Values, key: (typeof RUN_ONLY)[number] | (typeof VERIFY_ONLY)[number], min: number, max: number, fallback: number): number {
  const raw = values[key];
  if (raw === undefined) return fallback;
  const n = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new LaError("USAGE", `--${key}: expected an integer from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}`);
  return n;
}

function parseOperators(raw: string | undefined): OperatorId[] {
  if (raw === undefined) return [...OPERATOR_NAMES];
  const names = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const unknown = names.filter((n) => !OPERATOR_NAMES.includes(n as OperatorId));
  if (names.length === 0 || unknown.length > 0) throw new LaError("USAGE", `--operators: expected a comma-separated list of ${OPERATOR_NAMES.join(", ")}`);
  return OPERATOR_NAMES.filter((n) => names.includes(n));
}

// Provider rule (D-22, spec 5.7): --provider > LLM_PROVIDER > fake when a fixture exists for the scenario, else none.
function chooseProvider(flag: string | undefined, config: Config, scenario: string, logger: Logger): ProviderName {
  if (flag !== undefined && !PROVIDERS.includes(flag as ProviderName)) throw new LaError("USAGE", `--provider: expected one of ${PROVIDERS.join(", ")}`);
  const explicit = (flag as ProviderName | undefined) ?? config.provider;
  const fixture = resolveScenarioPath(scenario);
  if (explicit === null) {
    const provider: ProviderName = fixture ? "fake" : "none";
    const reason = fixture ? `LLM_PROVIDER is unset and ${relativeToProject(fixture)} exists for scenario ${scenario}` : `LLM_PROVIDER is unset and no fixture exists for scenario ${scenario}`;
    logger.info("provider_defaulted", { provider, reason });
    return provider;
  }
  if (explicit === "fake" && fixture === null) {
    throw new LaError("NO_PROVIDER", `the fake provider needs a fixture for scenario ${scenario}: none at fixtures/llm/${scenario}.json or tests/fixtures/llm/${scenario}.json`);
  }
  if (explicit === "openai-compatible" && config.apiKey === "") throw new LaError("LLM_AUTH", "LLM_API_KEY is required for the openai-compatible provider");
  return explicit;
}

function shownPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function formatRunSummary(r: RunResult, provider: ProviderName, scenario: string, config: Config): string {
  const fns = r.map.modules.reduce((n, m) => n + m.functions.length, 0);
  const stable = r.records.cases.filter((c) => c.determinism === "stable").length;
  const label = provider === "fake" ? `fake (${scenario})` : provider === "openai-compatible" ? `openai-compatible (${config.model})` : "none";
  const count = (n: number): string => n.toLocaleString("en-US");
  return `run: ${count(fns)} function${fns === 1 ? "" : "s"} · ${count(r.records.cases.length)} cases (${count(stable)} stable) · provider ${label} · artifacts ${shownPath(r.outDir)}`;
}

/** `mutation: 63.6% (28/44) · AOR 5/6 · ROR ... · 0 truncated · 3 invalid` (spec 5.12; every operator of the run). */
function formatMutationSummary(m: MutationReport): string {
  const count = (n: number): string => n.toLocaleString("en-US");
  const ops = m.operators.map((op) => {
    const o = m.score.byOperator[op];
    return `${op} ${count(o.killed + o.timeout)}/${count(o.killed + o.timeout + o.survived + o.noCoverage)}`;
  });
  return [`mutation: ${m.score.mutationScore.toFixed(1)}% (${count(m.score.detected)}/${count(m.score.valid)})`, ...ops, `${count(m.truncated)} truncated`, `${count(m.invalid)} invalid`].join(" · ");
}

/** `mutation: round 0 63.6% → round 1 88.6% (5 survivors left, 1 flagged "likely equivalent" by the LLM, advisory)`; null without rounds. */
function formatRoundsSummary(m: MutationReport): string | null {
  const first = m.rounds[0];
  const last = m.rounds.at(-1);
  if (!first || !last) return null;
  const count = (n: number): string => n.toLocaleString("en-US");
  const left = m.mutants.filter((x) => x.status === "survived").length;
  const flagged = m.mutants.filter((x) => x.llmSuggestedEquivalent !== null).length;
  return `mutation: round 0 ${first.scoreBefore.toFixed(1)}% → round ${last.round} ${last.scoreAfter.toFixed(1)}% (${count(left)} survivor${left === 1 ? "" : "s"} left, ${count(flagged)} flagged "likely equivalent" by the LLM, advisory)`;
}

async function runCommand(values: Values, config: Config, io: Io, logger: Logger): Promise<number> {
  if (values.target === undefined || values.target === "") throw new LaError("USAGE", `run needs --target <dir>; ${USAGE_TEXT.split("\n")[1]!.trim()}`);
  const verifyOnly = VERIFY_ONLY.find((k) => values[k] !== undefined);
  if (verifyOnly) throw new LaError("USAGE", `--${verifyOnly} is an option of verify, not of run`);
  const seed = intOption(values, "seed", 0, 4_294_967_295, 42);
  const clockNow = intOption(values, "clock", 0, 8_640_000_000_000_000, 1_700_000_000_000);
  const caseTimeoutMs = intOption(values, "case-timeout-ms", 100, 30_000, config.caseTimeoutMs);
  const maxMutants = intOption(values, "max-mutants", 1, 2000, config.maxMutants);
  const maxRounds = intOption(values, "max-rounds", 0, 3, config.maxRounds);
  const survivorsPerRound = intOption(values, "survivors-per-round", 1, 50, 10);
  const inputsPerSurvivor = intOption(values, "inputs-per-survivor", 1, 5, 5);
  const operators = parseOperators(values.operators);
  if (values.provider !== undefined && !PROVIDERS.includes(values.provider as ProviderName)) throw new LaError("USAGE", `--provider: expected one of ${PROVIDERS.join(", ")}`);
  if (values.scenario !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values.scenario)) throw new LaError("USAGE", "--scenario: expected a fixture name such as legacy-billing (letters, digits, '.', '_' and '-')");

  const { targetReal } = resolveRunPaths(values.target, values.out, process.cwd());
  trustGate(targetReal, values["i-trust-this-code"] === true, io, logger);
  const scenario = values.scenario ?? defaultScenario(targetReal);
  const provider = chooseProvider(values.provider, config, scenario, logger);
  const only = parseOnly(values.only);
  const result = await runPipeline({
    target: values.target,
    cwd: process.cwd(),
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(only ? { only } : {}),
    provider,
    scenario,
    seed,
    clockNow,
    caseTimeoutMs,
    watchdogMarginMs: config.watchdogMarginMs,
    maxMutants,
    maxRounds,
    survivorsPerRound,
    inputsPerSurvivor,
    operators,
    ...(values["tests-dir"] !== undefined ? { testsDir: values["tests-dir"] } : {}),
    strictFixture: false,
    config,
    logger,
  });
  io.stdout(formatRunSummary(result, provider, scenario, config) + "\n");
  io.stdout(formatMutationSummary(result.mutation) + "\n");
  const rounds = formatRoundsSummary(result.mutation);
  if (rounds !== null) io.stdout(rounds + "\n");
  return 0;
}

async function verifyCommand(values: Values, io: Io, logger: Logger): Promise<number> {
  const foreign = Object.keys(values).find((k) => !VERIFY_OPTIONS.includes(k));
  if (foreign) throw new LaError("USAGE", `--${foreign} is not an option of verify`);
  if (values.against === undefined || values.against === "") throw new LaError("USAGE", `verify needs --against <dir>; ${USAGE_TEXT.split("\n")[2]!.trim()}`);
  const fileTimeoutMs = intOption(values, "file-timeout-ms", 100, 3_600_000, 30_000);
  const againstReal = resolveTarget(values.against);
  if (!statSync(againstReal).isDirectory()) throw new LaError("USAGE", "--against must be a directory that contains the module the tests load");
  trustGate(againstReal, values["i-trust-this-code"] === true, io, logger);
  const outDir = resolveOutDir(values.out ?? join("artifacts", basename(againstReal)));
  if (isInsideOrEqual(outDir, againstReal) || isInsideOrEqual(againstReal, outDir)) {
    throw new LaError("USAGE", "--out must not be inside, equal to or contain the --against directory");
  }
  const testsDir = values["tests-dir"] !== undefined ? resolveOutDir(values["tests-dir"]) : join(outDir, "tests");
  // The test files run as code too; the default <out>/tests holds what this tool generated.
  if (values["tests-dir"] !== undefined) {
    trustGate(testsDir, values["i-trust-this-code"] === true, io, logger, { roots: [FIXTURES_DIR, ARTIFACTS_DIR], what: "--tests-dir is outside fixtures/ and artifacts/" });
  }
  const report = await runVerify({ testsDir, againstReal, fileTimeoutMs, reportPath: join(outDir, "verify.json"), logger });
  io.stdout(formatVerify(report, fileTimeoutMs).join("\n") + "\n");
  const { failed } = verifyTotals(report);
  if (failed > 0) throw new LaError("VERIFY_FAILED", `${failed.toLocaleString("en-US")} failing tests`);
  return 0;
}

export async function main(argv: string[], env: Record<string, string | undefined>, io: Io): Promise<number> {
  const write = (line: string): void => io.stderr(line + "\n");
  const secrets = [env.LLM_API_KEY ?? ""].filter((s) => s !== "");
  let logger = createLogger({ level: "info", secrets, write });
  try {
    let parsed: ReturnType<typeof parseArgs<{ args: string[]; options: typeof OPTIONS; strict: true; allowPositionals: true }>>;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
    } catch (err) {
      throw new LaError("USAGE", firstSentence(err instanceof Error ? err.message : String(err)));
    }
    const config = loadConfig(env);
    const level = parsed.values["log-level"] ?? config.logLevel;
    if (!LOG_LEVELS.includes(level as LogLevel)) throw new LaError("USAGE", `--log-level: expected one of ${LOG_LEVELS.join(", ")}`);
    logger = createLogger({ level: level as LogLevel, secrets: [config.apiKey].filter((s) => s !== ""), write });

    const [command, ...extra] = parsed.positionals;
    if (command === undefined) throw new LaError("USAGE", `missing command; ${firstUsageLine()} (or: la run --target <dir>)`);
    if (extra.length > 0) throw new LaError("USAGE", `unexpected argument: ${extra[0]}`);
    switch (command) {
      case "map":
        return mapCommand(parsed.values, io, logger);
      case "run":
        return await runCommand(parsed.values, config, io, logger);
      case "verify":
        return await verifyCommand(parsed.values, io, logger);
      default:
        throw new LaError("USAGE", `unknown command: ${command} (commands in this version: map, run, verify)`);
    }
  } catch (err) {
    const { line, exitCode } = formatErrorLine(err, secrets);
    if (err instanceof LaError) logger.error("command_failed", { code: err.code });
    else logger.error("internal_error", { error: err instanceof Error ? err : String(err), stack: err instanceof Error ? (err.stack ?? "") : "" });
    io.stderr(line + "\n");
    return exitCode;
  }
}

// Runs the CLI on this process's argv, environment and streams, and sets the exit code.
export async function runFromProcess(): Promise<void> {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    stdout: (s) => {
      process.stdout.write(s);
    },
    stderr: (s) => {
      process.stderr.write(s);
    },
  });
}

if (import.meta.main) await runFromProcess();
