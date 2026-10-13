// node scripts/demo.ts [--live]: the one-command offline demo (spec 1.4, 5.13, DEMO-01).
// Pass A: `none` on fixtures/legacy-billing → artifacts/demo-baseline. Pass B: the scripted fake (strict) on the same
// fixture → artifacts/demo, then `verify` of pass B's tests against fixtures/refactors/modern (must pass) and
// fixtures/refactors/broken (must fail). Pass C: `none` on the vendored bytes@3.1.2 → artifacts/demo-third-party.
// Stdout: the hero, then the full summary (both golden-compared). Stderr: one progress line per stage and the wall time.
// The provider of every pass is explicit, so LLM_PROVIDER and LLM_API_KEY in the environment change nothing (DEMO-02).
// --live replaces pass B with the configured openai-compatible provider for the owner's single real run (spec 7.4).
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { OPERATOR_IDS } from "../src/contracts/mutation.ts";
import { loadConfig } from "../src/infra/config.ts";
import type { Config } from "../src/infra/config.ts";
import { LaError, formatErrorLine } from "../src/infra/errors.ts";
import { createLogger } from "../src/infra/logger.ts";
import type { LogLevel, Logger } from "../src/infra/logger.ts";
import { PROJECT_ROOT, relativeToProject } from "../src/infra/paths.ts";
import { redactSecrets } from "../src/infra/redact.ts";
import { VERSION } from "../src/infra/version.ts";
import { buildHero, verifyCounts } from "../src/pipeline/demo-hero.ts";
import type { DemoInput, PassArtifacts } from "../src/pipeline/demo-hero.ts";
import { buildDemoSummary } from "../src/pipeline/demo-summary.ts";
import { evalLlm, renderEvalTable } from "../src/pipeline/eval-llm.ts";
import { runPipeline } from "../src/pipeline/run.ts";
import type { RunOptions, RunResult } from "../src/pipeline/run.ts";
import { runVerify } from "../src/pipeline/verify.ts";
import type { VerifyReport } from "../src/pipeline/verify.ts";

export const FIXTURE = "fixtures/legacy-billing";
const THIRD_PARTY = "fixtures/third-party/bytes";
const THIRD_PARTY_NAME = "bytes@3.1.2";
const THIRD_PARTY_LICENSE = "MIT";
const MODERN = "fixtures/refactors/modern";
const BROKEN = "fixtures/refactors/broken";
const WORLD = { clockNow: 1_700_000_000_000, seed: 42 } as const;
const FILE_TIMEOUT_MS = 30_000;
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

type Io = { stdout(s: string): void; stderr(s: string): void };
type Ctx = { config: Config; logger: Logger; io: Io; secrets: string[] };

function progress(ctx: Ctx, pass: string): (line: string) => void {
  return (line) => ctx.io.stderr(redactSecrets(`[${pass}] ${line}`, ctx.secrets) + "\n");
}

function runPass(ctx: Ctx, pass: string, target: string, out: string, provider: RunOptions["provider"], strictFixture: boolean): Promise<RunResult> {
  return runPipeline({
    target,
    cwd: PROJECT_ROOT,
    out,
    provider,
    seed: WORLD.seed,
    clockNow: WORLD.clockNow,
    caseTimeoutMs: ctx.config.caseTimeoutMs,
    watchdogMarginMs: ctx.config.watchdogMarginMs,
    maxMutants: ctx.config.maxMutants,
    maxRounds: ctx.config.maxRounds,
    survivorsPerRound: 10,
    inputsPerSurvivor: 5,
    operators: [...OPERATOR_IDS],
    strictFixture,
    config: ctx.config,
    logger: ctx.logger,
    onProgress: progress(ctx, pass),
  });
}

async function verifyPass(ctx: Ctx, pass: string, testsOut: string, against: string, reportName: string): Promise<VerifyReport> {
  const report = await runVerify({
    testsDir: join(PROJECT_ROOT, ...testsOut.split("/"), "tests"),
    againstReal: realpathSync(join(PROJECT_ROOT, ...against.split("/"))),
    fileTimeoutMs: FILE_TIMEOUT_MS,
    reportPath: join(PROJECT_ROOT, ...testsOut.split("/"), reportName),
    logger: ctx.logger,
  });
  const c = verifyCounts(report);
  progress(ctx, pass)(`verify --against ${against} done · ${c.passed.toLocaleString("en-US")}/${c.tests.toLocaleString("en-US")} passed`);
  return report;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

function toPass(r: RunResult): PassArtifacts {
  return {
    outDir: relativeToProject(r.outDir),
    map: r.map,
    hypotheses: r.hypotheses,
    records: r.records,
    mutation: r.mutation,
    report: r.report,
    testFiles: r.testFiles.map((f) => relativeToProject(f)),
    specLines: lineCount(readFileSync(join(r.outDir, "SPEC.md"), "utf8")),
  };
}

function targetLines(r: RunResult): number {
  const root = join(PROJECT_ROOT, ...r.map.targetDir.split("/"));
  return r.map.files.reduce((n, f) => n + lineCount(readFileSync(join(root, ...f.path.split("/")), "utf8")), 0);
}

async function offline(ctx: Ctx): Promise<void> {
  const baseline = await runPass(ctx, "pass A", FIXTURE, "artifacts/demo-baseline", "none", false);
  const fake = await runPass(ctx, "pass B", FIXTURE, "artifacts/demo", "fake", true);
  const verifyModern = await verifyPass(ctx, "pass B", "artifacts/demo", MODERN, "verify-modern.json");
  if (verifyCounts(verifyModern).failed !== 0) throw new LaError("DEMO_EXPECTATION", `the modern refactor failed ${verifyCounts(verifyModern).failed} recorded cases; it must pass all of them`);
  const verifyBroken = await verifyPass(ctx, "pass B", "artifacts/demo", BROKEN, "verify-broken.json");
  if (verifyCounts(verifyBroken).failed === 0) throw new LaError("DEMO_EXPECTATION", "the broken refactor passed every recorded case; it must fail at least one");
  const thirdParty = await runPass(ctx, "pass C", THIRD_PARTY, "artifacts/demo-third-party", "none", false);
  const input: DemoInput = {
    version: VERSION,
    world: WORLD,
    caseTimeoutMs: ctx.config.caseTimeoutMs,
    watchdogMarginMs: ctx.config.watchdogMarginMs,
    targetLines: targetLines(baseline),
    baseline: toPass(baseline),
    fake: toPass(fake),
    thirdParty: toPass(thirdParty),
    thirdPartyName: THIRD_PARTY_NAME,
    thirdPartyLicense: THIRD_PARTY_LICENSE,
    verifyModern,
    verifyBroken,
  };
  ctx.io.stdout(redactSecrets(buildHero(input) + buildDemoSummary(input), ctx.secrets));
}

function writeEval(ctx: Ctx, baseline: RunResult, live: RunResult): string {
  const table = renderEvalTable(evalLlm(baseline, live));
  writeFileSync(join(live.outDir, "eval.md"), redactSecrets(table, ctx.secrets));
  return table;
}

// The owner's single real-model run (spec 7.4): never part of npm test or CI (no key exists there).
async function live(ctx: Ctx): Promise<void> {
  const baseline = await runPass(ctx, "pass A", FIXTURE, "artifacts/demo-baseline", "none", false);
  const real = await runPass(ctx, "pass B live", FIXTURE, "artifacts/demo-live", "openai-compatible", false);
  const modern = await verifyPass(ctx, "pass B live", "artifacts/demo-live", MODERN, "verify-modern.json");
  const broken = await verifyPass(ctx, "pass B live", "artifacts/demo-live", BROKEN, "verify-broken.json");
  const thirdParty = await runPass(ctx, "pass C", THIRD_PARTY, "artifacts/demo-third-party", "none", false);
  const realThirdParty = await runPass(ctx, "pass C live", THIRD_PARTY, "artifacts/demo-live-third-party", "openai-compatible", false);
  const lines = [
    `legacy-archaeologist ${VERSION} · demo --live · provider: openai-compatible (${ctx.config.model}) · a single run, not a benchmark`,
    "",
    `## ${FIXTURE} (artifacts/demo-live/eval.md)`,
    "",
    writeEval(ctx, baseline, real).trimEnd(),
    "",
    `verify --against ${MODERN}: ${verifyCounts(modern).failed} failed · verify --against ${BROKEN}: ${verifyCounts(broken).failed} failed`,
    "",
    `## ${THIRD_PARTY} (artifacts/demo-live-third-party/eval.md)`,
    "",
    writeEval(ctx, thirdParty, realThirdParty).trimEnd(),
  ];
  ctx.io.stdout(redactSecrets(lines.join("\n") + "\n", ctx.secrets));
}

export async function main(argv: string[], env: Record<string, string | undefined>, io: Io): Promise<number> {
  const started = performance.now();
  const secrets = [env.LLM_API_KEY ?? ""].filter((s) => s !== "");
  try {
    let isLive: boolean;
    try {
      isLive = parseArgs({ args: argv, options: { live: { type: "boolean" } }, strict: true, allowPositionals: false }).values.live === true;
    } catch (err) {
      throw new LaError("USAGE", `${err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err)}; usage: node scripts/demo.ts [--live]`);
    }
    const level = env.LOG_LEVEL !== undefined && LOG_LEVELS.includes(env.LOG_LEVEL as LogLevel) ? (env.LOG_LEVEL as LogLevel) : "warn";
    let config: Config;
    if (isLive) {
      let liveConfig: Config | null = null;
      try {
        liveConfig = loadConfig(env);
      } catch {
        liveConfig = null;
      }
      if (liveConfig === null || liveConfig.provider !== "openai-compatible" || liveConfig.apiKey === "") {
        throw new LaError("USAGE", "--live needs LLM_PROVIDER=openai-compatible and LLM_API_KEY");
      }
      config = liveConfig;
    } else {
      // Offline: the defaults of spec 5.7 for every limit, so the printed blocks match their goldens whatever the
      // environment says; the key (if any) is kept only so redaction knows it.
      config = { ...loadConfig({}), apiKey: env.LLM_API_KEY ?? "" };
    }
    const logger = createLogger({ level, secrets, write: (line) => io.stderr(line + "\n") });
    const ctx: Ctx = { config, logger, io, secrets };
    if (isLive) await live(ctx);
    else await offline(ctx);
    io.stderr(`done in ${((performance.now() - started) / 1000).toFixed(1)} s · exit 0\n`);
    return 0;
  } catch (err) {
    const { line, exitCode } = formatErrorLine(err, secrets);
    if (!(err instanceof LaError)) {
      createLogger({ level: "error", secrets, write: (l) => io.stderr(l + "\n") }).error("internal_error", { error: err instanceof Error ? err : String(err), stack: err instanceof Error ? (err.stack ?? "") : "" });
    }
    io.stderr(line + "\n");
    return exitCode;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), process.env, {
    stdout: (s) => {
      process.stdout.write(s);
    },
    stderr: (s) => {
      process.stderr.write(s);
    },
  });
  process.exitCode = code;
}
