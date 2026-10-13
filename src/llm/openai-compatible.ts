// Real provider for any OpenAI-compatible chat completions endpoint (spec 7.4). fetch is injectable for tests.
// Two attempts on 429, 5xx, network error or timeout; 401/403 are LLM_AUTH; headers are never logged.
import { LaError } from "../infra/errors.ts";
import { redactSecrets } from "../infra/redact.ts";
import type { LlmProvider, LlmRaw } from "./provider.ts";

const ATTEMPTS = 2;
const MAX_BODY_CHARS = 200;

type Attempt = { kind: "ok"; raw: LlmRaw } | { kind: "retry"; error: LaError } | { kind: "fatal"; error: LaError };

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

export function createOpenAiCompatibleProvider(opts: { baseUrl: string; apiKey: string; model: string; timeoutMs: number; fetch?: typeof fetch }): LlmProvider {
  const doFetch = opts.fetch ?? fetch;
  const url = opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const secrets = [opts.apiKey];
  const bodyExcerpt = (text: string): string => redactSecrets(text, secrets).replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS);

  const attempt = async (messages: { role: string; content: string }[], signal?: AbortSignal): Promise<Attempt> => {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model: opts.model, temperature: 0, response_format: { type: "json_object" }, messages }),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) return { kind: "fatal", error: new LaError("LLM_UNAVAILABLE", "openai-compatible: request aborted") };
      if (isTimeout(err)) return { kind: "retry", error: new LaError("LLM_UNAVAILABLE", `openai-compatible: timed out after ${opts.timeoutMs} ms`) };
      const reason = err instanceof Error ? (err.message || err.name) : String(err);
      return { kind: "retry", error: new LaError("LLM_UNAVAILABLE", `openai-compatible: request failed: ${redactSecrets(reason, secrets).slice(0, MAX_BODY_CHARS)}`) };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        return { kind: "fatal", error: new LaError("LLM_AUTH", `openai-compatible: HTTP ${res.status}: the endpoint refused the API key (check LLM_API_KEY and LLM_BASE_URL)`) };
      }
      const error = new LaError("LLM_UNAVAILABLE", `openai-compatible: HTTP ${res.status}: ${bodyExcerpt(text)}`);
      return res.status === 429 || res.status >= 500 ? { kind: "retry", error } : { kind: "fatal", error };
    }
    let data: { model?: unknown; choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return { kind: "fatal", error: new LaError("LLM_UNAVAILABLE", "openai-compatible: the response body is not JSON") };
    }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { kind: "fatal", error: new LaError("LLM_UNAVAILABLE", "openai-compatible: the response has no message content") };
    const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      kind: "ok",
      raw: {
        text: content,
        usage: { promptTokens: count(data.usage?.prompt_tokens), completionTokens: count(data.usage?.completion_tokens) },
        model: typeof data.model === "string" ? data.model : opts.model,
      },
    };
  };

  return {
    name: "openai-compatible",
    async complete(call): Promise<LlmRaw> {
      let last: LaError | undefined;
      for (let i = 0; i < ATTEMPTS; i++) {
        const result = await attempt(call.messages, call.signal);
        if (result.kind === "ok") return result.raw;
        if (result.kind === "fatal") throw result.error;
        last = result.error;
      }
      throw last ?? new LaError("LLM_UNAVAILABLE", "openai-compatible: no attempt was made");
    },
  };
}
