import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { HypothesisOutput } from "../../src/contracts/hypotheses.ts";
import { LaError, UnscriptedLlmCallError } from "../../src/infra/errors.ts";
import { callLlm } from "../../src/llm/provider.ts";
import type { LlmCall, LlmProvider, LlmRaw } from "../../src/llm/provider.ts";
import { createTraceWriter } from "../../src/llm/trace.ts";
import { hypothesizePrompt } from "../../src/prompts/v1/hypothesize.ts";
import type { HypothesizeInput } from "../../src/prompts/v1/hypothesize.ts";

type Seen = LlmCall & { messages: { role: "system" | "user"; content: string }[] };

// A provider that returns scripted raw texts (or throws scripted errors) in order and records each call.
function stub(script: (string | Error)[]): LlmProvider & { calls: Seen[] } {
  const calls: Seen[] = [];
  return {
    name: "fake",
    calls,
    async complete(call): Promise<LlmRaw> {
      calls.push(call);
      const next = script[calls.length - 1];
      if (next === undefined) throw new UnscriptedLlmCallError("no scripted turn");
      if (next instanceof Error) throw next;
      return { text: next, usage: { promptTokens: 10, completionTokens: 5 }, model: "stub-model" };
    },
  };
}

const input: HypothesizeInput = {
  functionId: "a.js#f",
  name: "f",
  params: ["x"],
  callbackParam: null,
  source: "function f(x) { return x * 2; }",
  truncated: false,
  sideEffects: [],
  magicNumbers: [2],
  callees: [],
};

const validOutput: HypothesisOutput = {
  rules: [{ key: "doubles", statement: "Returns twice the input value", relatedConstants: [2], probes: [{ label: "two", steps: [{ args: [2] }], prediction: { kind: "returns", value: 4 } }] }],
  partitions: [{ label: "zero", steps: [{ args: [0] }] }],
};

const traceLines = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l));

test("a valid first answer is returned and traced once with validation ok", async () => {
  const p = stub([JSON.stringify(validOutput)]);
  const trace = createTraceWriter([]);
  const logged: { event: string; fields?: Record<string, unknown> }[] = [];
  const logger = { debug() {}, info: (event: string, fields?: Record<string, unknown>) => logged.push({ event, ...(fields ? { fields } : {}) }), warn() {}, error() {} };
  assert.deepEqual(await callLlm(p, hypothesizePrompt, input, { trace, secrets: [], logger }), validOutput);
  assert.equal(p.calls.length, 1);
  assert.deepEqual(p.calls[0]!.messages.map((m) => m.role), ["system", "user"]);
  assert.deepEqual(p.calls[0]!.matchKeys, { functionId: "a.js#f" });
  const [e] = traceLines(trace.text());
  assert.equal(e.seq, 1);
  assert.equal(e.prompt, "hypothesize.v1");
  assert.equal(e.provider, "fake");
  assert.equal(e.model, "stub-model");
  assert.equal(e.validation, "ok");
  assert.equal(e.repairRaw, null);
  assert.equal(e.systemSha256, "sha256:" + createHash("sha256").update(hypothesizePrompt.system).digest("hex"));
  assert.equal(e.user, hypothesizePrompt.buildUser(input));
  assert.deepEqual(e.rejected, []);
  assert.deepEqual(e.usage, { promptTokens: 10, completionTokens: 5 });
  assert.equal(trace.lastSeq(), 1);
  assert.deepEqual(logged.map((l) => [l.event, l.fields?.outcome]), [["llm_call", "ok"]]);
  trace.setRejected(1, [{ label: "zero", reason: "DUPLICATE" }]);
  assert.deepEqual(traceLines(trace.text())[0].rejected, [{ label: "zero", reason: "DUPLICATE" }]);
});

test("[LLM-02] an invalid first answer gets exactly one repair call that includes the validation issues", async () => {
  const p = stub(['{"rules": "nope"}', JSON.stringify(validOutput)]);
  const trace = createTraceWriter([]);
  assert.deepEqual(await callLlm(p, hypothesizePrompt, input, { trace, secrets: [] }), validOutput);
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[1]!.matchKeys.repair, true);
  assert.equal(p.calls[1]!.matchKeys.functionId, "a.js#f");
  assert.equal(p.calls[1]!.messages.length, 3);
  assert.match(p.calls[1]!.messages.at(-1)!.content, /rules/);
  assert.match(p.calls[1]!.messages.at(-1)!.content, /Previous answer:\n\{"rules": "nope"\}/);
  const e = JSON.parse(trace.text());
  assert.equal(e.validation, "repaired");
  assert.equal(e.raw, '{"rules": "nope"}');
  assert.equal(e.repairRaw, JSON.stringify(validOutput));
  assert.deepEqual(e.usage, { promptTokens: 20, completionTokens: 10 });
  assert.ok(e.issues.length >= 1);
});

test("[LLM-02] two invalid answers abort with LLM_OUTPUT_INVALID and the trace keeps both raw texts", async () => {
  const p = stub(["not json", '{"rules": []}']);
  const trace = createTraceWriter([]);
  await assert.rejects(callLlm(p, hypothesizePrompt, input, { trace, secrets: [] }), (err: unknown) => {
    assert.ok(err instanceof LaError);
    assert.equal(err.code, "LLM_OUTPUT_INVALID");
    assert.match(err.message, /^hypothesize\.v1 output failed validation twice: /);
    return true;
  });
  const e = JSON.parse(trace.text());
  assert.equal(e.validation, "invalid");
  assert.equal(e.raw, "not json");
  assert.equal(e.repairRaw, '{"rules": []}');
  assert.equal(e.parsed, null);
});

test("[LLM-02] an unscripted repair call fails closed with LLM_OUTPUT_INVALID", async () => {
  const p = stub(['{"rules": "nope"}']);
  const trace = createTraceWriter([]);
  await assert.rejects(callLlm(p, hypothesizePrompt, input, { trace, secrets: [] }), (err: unknown) => err instanceof LaError && err.code === "LLM_OUTPUT_INVALID");
  assert.equal(p.calls.length, 2);
  const e = JSON.parse(trace.text());
  assert.equal(e.validation, "invalid");
  assert.equal(e.repairRaw, null);
});

test("[LLM-02] a provider error is not repaired", async () => {
  const p = stub([new LaError("LLM_UNAVAILABLE", "simulated outage")]);
  const trace = createTraceWriter([]);
  await assert.rejects(callLlm(p, hypothesizePrompt, input, { trace, secrets: [] }), (err: unknown) => err instanceof LaError && err.code === "LLM_UNAVAILABLE");
  assert.equal(p.calls.length, 1);
  const unscripted = stub([]);
  await assert.rejects(callLlm(unscripted, hypothesizePrompt, input, { trace, secrets: [] }), (err: unknown) => err instanceof LaError && err.code === "UNSCRIPTED_LLM_CALL");
  assert.equal(trace.text(), "");
});

test("[HYP-04] a raw text over MAX_RAW_LLM_BYTES is invalid without parsing", async () => {
  const p = stub(["{" + "x".repeat(70_000), JSON.stringify(validOutput)]);
  const trace = createTraceWriter([]);
  assert.deepEqual(await callLlm(p, hypothesizePrompt, input, { trace, secrets: [] }), validOutput);
  const e = JSON.parse(trace.text());
  assert.equal(e.validation, "repaired");
  assert.match(e.issues[0], /exceeds 65536 bytes/);
  assert.ok(p.calls[1]!.messages.at(-1)!.content.length < 7_000, "the previous answer is cut in the repair message");
});

test("a fenced JSON answer is accepted", async () => {
  const p = stub(["```json\n" + JSON.stringify(validOutput, null, 2) + "\n```"]);
  const trace = createTraceWriter([]);
  assert.deepEqual(await callLlm(p, hypothesizePrompt, input, { trace, secrets: [] }), validOutput);
  assert.equal(JSON.parse(trace.text()).validation, "ok");
});

test("[LLM-06] trace lines redact key-shaped strings and the configured key", async () => {
  const key = "sk-or-v1-" + "z".repeat(40);
  const configured = "local-secret-value-1";
  const leaky: HypothesisOutput = { rules: [], partitions: [{ label: `leak ${key} and ${configured}`, steps: [{ args: [configured] }] }] };
  const p = stub([JSON.stringify(leaky)]);
  const trace = createTraceWriter([configured]);
  await callLlm(p, hypothesizePrompt, input, { trace, secrets: [configured] });
  const text = trace.text();
  assert.ok(!text.includes(key));
  assert.ok(!text.includes(configured));
  assert.ok(text.includes("[REDACTED]"));
  assert.equal(text.split("\n").length, 2, "one line plus the trailing newline");
});
