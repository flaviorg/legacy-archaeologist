// The LLM port (spec 4.4) and callLlm: Zod validation, one repair attempt, then fail closed (LLM-02).
import { createHash } from "node:crypto";
import * as z from "zod";
import { MAX_RAW_LLM_BYTES } from "../contracts/hypotheses.ts";
import type { Usage } from "../contracts/hypotheses.ts";
import { LaError } from "../infra/errors.ts";
import type { Logger } from "../infra/logger.ts";
import type { PromptSpec } from "../prompts/prompt-spec.ts";
import type { TraceWriter } from "./trace.ts";

export type LlmMessage = { role: "system" | "user"; content: string };
export type LlmCall = { prompt: PromptSpec<unknown, unknown>; input: unknown; signal?: AbortSignal; matchKeys: Record<string, string | number | boolean> };
export type LlmRaw = { text: string; usage: Usage; model: string };

export interface LlmProvider {
  readonly name: "fake" | "openai-compatible";
  complete(call: LlmCall & { messages: LlmMessage[] }): Promise<LlmRaw>;
}

const MAX_REPAIR_ISSUES_CHARS = 2_000;
const MAX_REPAIR_RAW_CHARS = 4_000;
const utf8 = new TextEncoder();

type Validation<O> = { ok: true; data: O } | { ok: false; issues: string[]; pretty: string };

// Real models often wrap JSON in one Markdown fence; strip exactly one surrounding fence (deterministic).
function stripFence(text: string): string {
  const m = /^\s*```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/.exec(text);
  return m ? m[1]! : text;
}

function validate<O>(prompt: PromptSpec<unknown, O>, raw: string): Validation<O> {
  const bytes = utf8.encode(raw).length;
  if (bytes > MAX_RAW_LLM_BYTES) {
    const issue = `raw output exceeds ${MAX_RAW_LLM_BYTES} bytes (${bytes} bytes)`;
    return { ok: false, issues: [issue], pretty: issue };
  }
  let json: unknown;
  try {
    json = JSON.parse(stripFence(raw));
  } catch (err) {
    const issue = `the answer is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, issues: [issue], pretty: issue };
  }
  const parsed = prompt.outputSchema.safeParse(json);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.map(String).join(".")}: ${i.message}` : i.message));
  return { ok: false, issues, pretty: z.prettifyError(parsed.error) };
}

function repairMessage(pretty: string, raw: string): string {
  return [
    "Your previous answer did not match the required JSON schema:",
    pretty.slice(0, MAX_REPAIR_ISSUES_CHARS),
    "Previous answer:",
    raw.slice(0, MAX_REPAIR_RAW_CHARS),
    "Return only the corrected JSON object.",
  ].join("\n");
}

function isUnscripted(err: unknown): boolean {
  return err instanceof LaError && err.code === "UNSCRIPTED_LLM_CALL";
}

export async function callLlm<I, O>(
  provider: LlmProvider,
  prompt: PromptSpec<I, O>,
  input: I,
  ctx: { trace: TraceWriter; secrets: readonly string[]; signal?: AbortSignal; logger?: Logger },
): Promise<O> {
  const anyPrompt = prompt as PromptSpec<unknown, O>;
  const user = prompt.buildUser(input);
  const matchKeys = prompt.matchKeys(input);
  const messages: LlmMessage[] = [{ role: "system", content: prompt.system }, { role: "user", content: user }];
  const systemSha256 = "sha256:" + createHash("sha256").update(prompt.system).digest("hex");

  const ask = async (keys: Record<string, string | number | boolean>, msgs: LlmMessage[]): Promise<LlmRaw> => {
    const started = performance.now();
    try {
      return await provider.complete({ prompt: anyPrompt as PromptSpec<unknown, unknown>, input, matchKeys: keys, messages: msgs, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    } catch (err) {
      ctx.logger?.warn("llm_call", { prompt: prompt.version, provider: provider.name, outcome: "error", code: err instanceof LaError ? err.code : "INTERNAL", durationMs: Math.round(performance.now() - started) });
      throw err;
    }
  };
  const logCall = (raw: LlmRaw, outcome: "ok" | "repaired" | "invalid", started: number): void => {
    ctx.logger?.info("llm_call", {
      prompt: prompt.version,
      provider: provider.name,
      model: raw.model,
      promptTokens: raw.usage.promptTokens,
      completionTokens: raw.usage.completionTokens,
      durationMs: Math.round(performance.now() - started),
      outcome,
    });
  };
  const base = { prompt: prompt.version, provider: provider.name, matchKeys, systemSha256, user };

  // Provider errors on the first call (LLM_UNAVAILABLE, LLM_AUTH, UNSCRIPTED_LLM_CALL) propagate untouched.
  let started = performance.now();
  const first = await ask(matchKeys, messages);
  const firstCheck = validate(anyPrompt, first.text);
  if (firstCheck.ok) {
    logCall(first, "ok", started);
    ctx.trace.append({ ...base, model: first.model, raw: first.text, repairRaw: null, parsed: firstCheck.data, validation: "ok", issues: [], usage: first.usage });
    return firstCheck.data;
  }
  logCall(first, "invalid", started);

  const repairKeys = { ...matchKeys, repair: true };
  const repairMessages: LlmMessage[] = [...messages, { role: "user", content: repairMessage(firstCheck.pretty, first.text) }];
  const fail = (repairRaw: string | null, model: string, usage: Usage, issues: string[], firstIssue: string): LaError => {
    ctx.trace.append({ ...base, model, raw: first.text, repairRaw, parsed: null, validation: "invalid", issues, usage });
    return new LaError("LLM_OUTPUT_INVALID", `${prompt.version} output failed validation twice: ${firstIssue}`);
  };

  started = performance.now();
  let second: LlmRaw;
  try {
    second = await ask(repairKeys, repairMessages);
  } catch (err) {
    // An unscripted repair call fails closed as invalid output; any other provider error propagates.
    if (isUnscripted(err)) throw fail(null, first.model, first.usage, [...firstCheck.issues, "repair: no answer"], firstCheck.issues[0] ?? "invalid output");
    ctx.trace.append({ ...base, model: first.model, raw: first.text, repairRaw: null, parsed: null, validation: "invalid", issues: firstCheck.issues, usage: first.usage });
    throw err;
  }
  const usage: Usage = {
    promptTokens: first.usage.promptTokens + second.usage.promptTokens,
    completionTokens: first.usage.completionTokens + second.usage.completionTokens,
  };
  const secondCheck = validate(anyPrompt, second.text);
  if (secondCheck.ok) {
    logCall(second, "repaired", started);
    ctx.trace.append({ ...base, model: second.model, raw: first.text, repairRaw: second.text, parsed: secondCheck.data, validation: "repaired", issues: firstCheck.issues, usage });
    return secondCheck.data;
  }
  logCall(second, "invalid", started);
  throw fail(second.text, second.model, usage, [...firstCheck.issues, ...secondCheck.issues.map((i) => `repair: ${i}`)], secondCheck.issues[0] ?? "invalid output");
}
