import test from "node:test";
import assert from "node:assert/strict";
import { LaError } from "../../src/infra/errors.ts";
import { createOpenAiCompatibleProvider } from "../../src/llm/openai-compatible.ts";
import { hypothesizePrompt } from "../../src/prompts/v1/hypothesize.ts";

type Scripted = Response | Error | (() => Response);

// Returns the scripted responses (or throws the scripted errors) in order and records each Request.
function fakeFetch(responses: Scripted[], seen: Request[]): typeof fetch {
  let i = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(input, init));
    const next = responses[i++];
    if (next === undefined) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
}

const ok200 = () => new Response(JSON.stringify({ model: "served-model", choices: [{ message: { content: '{"rules":[],"partitions":[]}' } }], usage: { prompt_tokens: 12, completion_tokens: 7 } }), { status: 200, headers: { "content-type": "application/json" } });
const status = (s: number, body = "upstream says no") => () => new Response(body, { status: s });
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

const call = {
  prompt: hypothesizePrompt as never,
  input: {},
  matchKeys: { functionId: "a.js#f" },
  messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "usr" }],
};
const make = (responses: Scripted[], seen: Request[] = [], apiKey = "k".repeat(24)) =>
  createOpenAiCompatibleProvider({ baseUrl: "https://llm.example/v1", apiKey, model: "m", timeoutMs: 1000, fetch: fakeFetch(responses, seen) });
const code = (c: string) => (err: unknown) => err instanceof LaError && err.code === c;

test("[LLM-07] posts to <base>/chat/completions with temperature 0 and JSON mode", async () => {
  const seen: Request[] = [];
  const p = make([ok200], seen);
  assert.equal(p.name, "openai-compatible");
  const raw = await p.complete(call);
  assert.equal(seen[0]!.url, "https://llm.example/v1/chat/completions");
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.headers.get("content-type"), "application/json");
  const body = await seen[0]!.json();
  assert.equal(body.temperature, 0);
  assert.equal(body.model, "m");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.messages, call.messages);
  assert.equal(seen[0]!.headers.get("authorization")!.length, "Bearer ".length + 24);
  assert.deepEqual(raw, { text: '{"rules":[],"partitions":[]}', usage: { promptTokens: 12, completionTokens: 7 }, model: "served-model" });
});

test("[LLM-07] retries once on 429, 5xx, network error and timeout, then LLM_UNAVAILABLE", async () => {
  let seen: Request[] = [];
  await make([status(429), ok200], seen).complete(call);
  assert.equal(seen.length, 2);
  seen = [];
  await assert.rejects(make([status(500), status(503)], seen).complete(call), (err: unknown) => code("LLM_UNAVAILABLE")(err) && /HTTP 503/.test((err as Error).message));
  assert.equal(seen.length, 2);
  seen = [];
  await make([new TypeError("fetch failed"), ok200], seen).complete(call);
  assert.equal(seen.length, 2);
  seen = [];
  await assert.rejects(make([timeoutError(), timeoutError()], seen).complete(call), (err: unknown) => code("LLM_UNAVAILABLE")(err) && /timed out after 1000 ms/.test((err as Error).message));
  assert.equal(seen.length, 2);
});

test("[LLM-07] never retries other 4xx; 401 and 403 are LLM_AUTH without the key", async () => {
  const key = "secret-key-" + "x".repeat(20);
  let seen: Request[] = [];
  await assert.rejects(make([status(400)], seen).complete(call), (err: unknown) => code("LLM_UNAVAILABLE")(err) && /HTTP 400: upstream says no/.test((err as Error).message));
  assert.equal(seen.length, 1);
  for (const s of [401, 403]) {
    seen = [];
    await assert.rejects(make([status(s, `bad key ${key}`)], seen, key).complete(call), (err: unknown) => {
      assert.ok(code("LLM_AUTH")(err));
      assert.ok(!(err as Error).message.includes(key));
      return true;
    });
    assert.equal(seen.length, 1);
  }
});

test("[LLM-06] a key-shaped string in an error body is redacted", async () => {
  const leaked = "sk-or-v1-" + "b".repeat(40);
  await assert.rejects(make([status(500, `oops ${leaked} and ${leaked}`), status(500, `oops ${leaked} and ${leaked}`)]).complete(call), (err: unknown) => {
    assert.ok(code("LLM_UNAVAILABLE")(err));
    assert.ok(!(err as Error).message.includes(leaked));
    assert.match((err as Error).message, /\[REDACTED\]/);
    return true;
  });
  const long = "y".repeat(1_000);
  await assert.rejects(make([status(418, long)]).complete(call), (err: unknown) => (err as Error).message.length < 300);
});

test("a response without message content is LLM_UNAVAILABLE", async () => {
  await assert.rejects(make([() => new Response(JSON.stringify({ choices: [] }), { status: 200 })]).complete(call), code("LLM_UNAVAILABLE"));
});
