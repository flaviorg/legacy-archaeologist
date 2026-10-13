import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LaError, UnscriptedLlmCallError } from "../../src/infra/errors.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";
import { computeTargetSha, walkTarget } from "../../src/infra/target-files.ts";
import { createFakeProvider, promptHash, PROMPTS } from "../../src/llm/fake-provider.ts";
import { hypothesizePrompt } from "../../src/prompts/v1/hypothesize.ts";
import { survivorInputsPrompt } from "../../src/prompts/v1/survivor-inputs.ts";
import { tmpDir } from "../helpers/tmp-target.ts";

const FIXTURE = join(PROJECT_ROOT, "tests/fixtures/llm/unit-mini.json");
const TARGET = join(PROJECT_ROOT, "tests/fixtures/targets/two-functions");
const IDS = ["index.js#a", "index.js#b"];
const targetSha = computeTargetSha(walkTarget(TARGET).map((e) => ({ relPath: e.relPath, bytes: readFileSync(e.absPath) })));

type Fixture = { targetSha: string; promptHashes: Record<string, string>; turns: Record<string, unknown>[] } & Record<string, unknown>;
const load = (): Fixture => JSON.parse(readFileSync(FIXTURE, "utf8"));

function variant(t: TestContext, change: (f: Fixture) => void): string {
  const f = load();
  change(f);
  const path = join(tmpDir(t), "fixture.json");
  writeFileSync(path, JSON.stringify(f));
  return path;
}

const call = (matchKeys: Record<string, string | number | boolean>, prompt = hypothesizePrompt) => ({
  prompt: prompt as never,
  input: {},
  matchKeys,
  messages: [{ role: "system" as const, content: "s".repeat(40) }, { role: "user" as const, content: "u".repeat(40) }],
});

const code = (c: string) => (err: unknown) => err instanceof LaError && err.code === c;

test("promptHash is sha256 of the version, a newline and the system text", () => {
  assert.equal(promptHash(hypothesizePrompt), "sha256:" + createHash("sha256").update("hypothesize.v1\n" + hypothesizePrompt.system).digest("hex"));
  assert.deepEqual(PROMPTS.map((p) => p.version), ["hypothesize.v1", "survivor-inputs.v1"]);
});

test("[LLM-01] the fake answers from the fixture whose targetSha and prompt hashes match", async () => {
  const fake = createFakeProvider({ fixturePath: FIXTURE, targetSha, functionIds: IDS });
  assert.equal(fake.name, "fake");
  const raw = await fake.complete(call({ functionId: "index.js#a" }));
  const turn = load().turns.find((x) => x.id === "hyp-a")!;
  assert.equal(raw.text, JSON.stringify(turn.output));
  assert.deepEqual(raw.usage, turn.usage);
  assert.equal(raw.model, "fake");
  assert.deepEqual(fake.consumedIds(), ["hyp-a"]);
});

test("[LLM-01] a different targetSha or an unknown when.functionId is FIXTURE_TARGET_DRIFT; a changed prompt hash is FIXTURE_PROMPT_DRIFT", (t) => {
  assert.throws(() => createFakeProvider({ fixturePath: FIXTURE, targetSha: "sha256:" + "f".repeat(64), functionIds: IDS }), code("FIXTURE_TARGET_DRIFT"));
  assert.throws(() => createFakeProvider({ fixturePath: FIXTURE, targetSha, functionIds: ["index.js#a"] }), (err: unknown) => code("FIXTURE_TARGET_DRIFT")(err) && /index\.js#b/.test((err as Error).message));
  const drifted = variant(t, (f) => { f.promptHashes["hypothesize.v1"] = "sha256:" + "0".repeat(64); });
  assert.throws(() => createFakeProvider({ fixturePath: drifted, targetSha, functionIds: IDS }), (err: unknown) => code("FIXTURE_PROMPT_DRIFT")(err) && /run npm run fixtures:rehash/.test((err as Error).message));
  const missingHash = variant(t, (f) => { delete f.promptHashes["hypothesize.v1"]; });
  assert.throws(() => createFakeProvider({ fixturePath: missingHash, targetSha, functionIds: IDS }), code("FIXTURE_PROMPT_DRIFT"));
  assert.throws(() => createFakeProvider({ fixturePath: join(tmpDir(t), "nope.json"), targetSha, functionIds: IDS }), code("FIXTURE_NOT_FOUND"));
  const broken = variant(t, (f) => { f.schemaVersion = 2; });
  assert.throws(() => createFakeProvider({ fixturePath: broken, targetSha, functionIds: IDS }), (err: unknown) => code("FIXTURE_NOT_FOUND")(err) && /^invalid fixture: /.test((err as Error).message));
});

test("[LLM-01] a scripted output that fails its prompt schema fails at load", (t) => {
  const bad = variant(t, (f) => { f.turns[0]!.output = { rules: "nope", partitions: [] }; });
  assert.throws(() => createFakeProvider({ fixturePath: bad, targetSha, functionIds: IDS }), (err: unknown) => code("FIXTURE_NOT_FOUND")(err) && /^invalid fixture: turn hyp-a: /.test((err as Error).message));
  const unknownPrompt = variant(t, (f) => { f.turns[0]!.prompt = "hypothesize.v9"; });
  assert.throws(() => createFakeProvider({ fixturePath: unknownPrompt, targetSha, functionIds: IDS }), (err: unknown) => code("FIXTURE_NOT_FOUND")(err) && /hypothesize\.v9/.test((err as Error).message));
  const survivor = variant(t, (f) => {
    f.promptHashes["survivor-inputs.v1"] = promptHash(survivorInputsPrompt);
    f.turns.push({ id: "surv", prompt: "survivor-inputs.v1", when: { round: 1, mutantId: "m-0001" }, output: { inputs: [], likelyEquivalent: "yes", reason: "x" } });
  });
  assert.throws(() => createFakeProvider({ fixturePath: survivor, targetSha, functionIds: IDS }), (err: unknown) => code("FIXTURE_NOT_FOUND")(err) && /turn surv: /.test((err as Error).message));
});

test("[LLM-05] an unscripted call names the prompt, the match keys, the consumed and the known turn ids", async () => {
  const fake = createFakeProvider({ fixturePath: FIXTURE, targetSha, functionIds: IDS });
  await fake.complete(call({ functionId: "index.js#a" }));
  await assert.rejects(fake.complete(call({ functionId: "zzz" })), (err: unknown) => {
    assert.ok(err instanceof UnscriptedLlmCallError);
    assert.equal(err.code, "UNSCRIPTED_LLM_CALL");
    assert.match(err.message, /^no scripted turn for hypothesize\.v1 \{"functionId":"zzz"\}; consumed: \[hyp-a\]; known: \[hyp-a, hyp-b\]$/);
    return true;
  });
});

test("[LLM-05] a turn is consumed once; a repair call matches only a repair turn", async (t) => {
  const path = variant(t, (f) => {
    f.turns.unshift({ id: "hyp-a-repair", prompt: "hypothesize.v1", when: { functionId: "index.js#a", repair: true }, output: { rules: [], partitions: [] } });
  });
  const fake = createFakeProvider({ fixturePath: path, targetSha, functionIds: IDS });
  await fake.complete(call({ functionId: "index.js#a" }));
  assert.deepEqual(fake.consumedIds(), ["hyp-a"]);
  await assert.rejects(fake.complete(call({ functionId: "index.js#a" })), code("UNSCRIPTED_LLM_CALL"));
  await fake.complete(call({ functionId: "index.js#a", repair: true }));
  assert.deepEqual(fake.consumedIds(), ["hyp-a", "hyp-a-repair"]);
  await assert.rejects(fake.complete(call({ functionId: "index.js#b", repair: true })), code("UNSCRIPTED_LLM_CALL"));
  await assert.rejects(fake.complete(call({ functionId: "index.js#b" }, survivorInputsPrompt as never)), code("UNSCRIPTED_LLM_CALL"));
});

test("assertAllConsumed lists dead turns with FIXTURE_UNCONSUMED", async () => {
  const fake = createFakeProvider({ fixturePath: FIXTURE, targetSha, functionIds: IDS });
  await fake.complete(call({ functionId: "index.js#a" }));
  assert.throws(() => fake.assertAllConsumed(), (err: unknown) => code("FIXTURE_UNCONSUMED")(err) && (err as Error).message === "turns never used: hyp-b");
  await fake.complete(call({ functionId: "index.js#b" }));
  fake.assertAllConsumed();
});

test("simulated timeout, rate limit and server error become LLM_UNAVAILABLE; invalid_output returns its raw text", async (t) => {
  const path = variant(t, (f) => {
    f.turns = ["timeout", "rate_limit", "server_error"].map((kind, i) => ({ id: `err-${kind}`, prompt: "hypothesize.v1", when: { functionId: "index.js#a", attempt: i }, error: { kind } }));
    f.turns.push({ id: "garbage", prompt: "hypothesize.v1", when: { functionId: "index.js#b" }, error: { kind: "invalid_output", raw: '{ "rules": "not an array" }' } });
  });
  const fake = createFakeProvider({ fixturePath: path, targetSha, functionIds: IDS });
  for (const [i, kind] of ["timeout", "rate_limit", "server_error"].entries()) {
    await assert.rejects(fake.complete(call({ functionId: "index.js#a", attempt: i })), (err: unknown) => code("LLM_UNAVAILABLE")(err) && (err as Error).message === `fake: simulated ${kind}`);
  }
  const raw = await fake.complete(call({ functionId: "index.js#b" }));
  assert.equal(raw.text, '{ "rules": "not an array" }');
  assert.deepEqual(raw.usage, { promptTokens: 20, completionTokens: Math.ceil(raw.text.length / 4) });
});
