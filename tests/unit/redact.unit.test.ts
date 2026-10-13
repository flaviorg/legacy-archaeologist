import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../../src/infra/redact.ts";
import { createLogger } from "../../src/infra/logger.ts";

test("[LLM-06] key-shaped strings and the configured key are redacted", () => {
  const key = "sk-or-v1-" + "a".repeat(40), custom = "my-local-key-12345";
  const out = redactSecrets(`a ${key} b ${"AIza" + "B".repeat(35)} c ${custom}`, [custom]);
  assert.equal(out, "a [REDACTED] b [REDACTED] c [REDACTED]");
});

test("[LLM-06] Anthropic and generic sk- keys are redacted; short extra values are not", () => {
  const out = redactSecrets(`${"sk-ant-" + "x".repeat(30)} ${"sk-" + "y".repeat(24)} short`, ["short"]);
  assert.equal(out, "[REDACTED] [REDACTED] short");
});

test("[LLM-06] the logger redacts and writes one JSON line per event", () => {
  const custom = "my-local-key-12345";
  const lines: string[] = [];
  const log = createLogger({ level: "info", secrets: [custom], write: (line) => lines.push(line) });
  log.info("x", { k: custom, nested: { arr: [`token ${custom}`] }, key: "sk-or-v1-" + "b".repeat(40) });
  assert.equal(lines.length, 1);
  const line = lines[0] ?? "";
  assert.ok(!line.includes("\n"));
  assert.ok(!line.includes(custom));
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed.level, "info");
  assert.equal(parsed.event, "x");
  assert.equal(typeof parsed.ts, "string");
  assert.deepEqual([parsed.k, parsed.nested, parsed.key], ["[REDACTED]", { arr: ["token [REDACTED]"] }, "[REDACTED]"]);
});

test("[LLM-06] a secret containing JSON-escaped characters is still redacted", () => {
  const custom = 'quote"and\\slash';
  const lines: string[] = [];
  createLogger({ level: "info", secrets: [custom], write: (l) => lines.push(l) }).warn("y", { v: custom });
  assert.ok(!(lines[0] ?? "").includes("quote"));
});

test("the logger drops events below its level", () => {
  const lines: string[] = [];
  const log = createLogger({ level: "warn", write: (l) => lines.push(l) });
  log.debug("a"); log.info("b"); log.warn("c"); log.error("d");
  assert.deepEqual(lines.map((l) => (JSON.parse(l) as { event: string }).event), ["c", "d"]);
});
