import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig } from "../../src/infra/config.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";
import { createOpenAiCompatibleProvider } from "../../src/llm/openai-compatible.ts";
import { runHypothesizeStage } from "../../src/pipeline/hypothesize.ts";
import { runMapStage } from "../../src/pipeline/map.ts";
import { tmpDir } from "../helpers/tmp-target.ts";

// Runs only with a real key (npm run test:live); never part of npm test. Asserts structure only.
test("[LLM-08] the hypothesize stage with a real provider returns at least one rule and every input accepted or rejected with a reason", { skip: !process.env.LLM_API_KEY, timeout: 600_000 }, async (t) => {
  const config = loadConfig({ ...process.env, LLM_PROVIDER: "openai-compatible" });
  const secrets = [config.apiKey];
  const logger = createLogger({ level: "warn", secrets });
  const llm = createOpenAiCompatibleProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, timeoutMs: config.timeoutMs });
  const out = tmpDir(t, "la-live-");
  const { map, files } = runMapStage({ targetReal: join(PROJECT_ROOT, "fixtures/legacy-billing"), outDir: out, logger });
  const r = await runHypothesizeStage({ map, files, provider: { kind: "llm", llm, name: "openai-compatible", model: config.model }, outDir: out, logger, secrets });
  const rules = r.hypotheses.functions.reduce((n, f) => n + f.output.rules.length, 0);
  assert.ok(rules >= 1, "at least one rule");
  const proposals = r.hypotheses.functions.reduce((n, f) => n + f.output.partitions.length + f.output.rules.reduce((m, rule) => m + rule.probes.length, 0), 0);
  const accepted = r.planned.filter((c) => c.origin !== "boundary-expansion").length;
  assert.equal(accepted + r.hypotheses.rejected.length, proposals);
  assert.ok(r.hypotheses.rejected.every((x) => x.reason.length > 0));
});
