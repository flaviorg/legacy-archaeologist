// The scripted fake provider (spec 7): answers from one JSON fixture, checked at load against the target and the
// prompts. It ignores the system and user texts except through the prompt hash: the fake cannot read the code.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type * as z from "zod";
import { llmFixtureSchema } from "../contracts/llm-fixture.ts";
import type { LlmFixtureTurn } from "../contracts/llm-fixture.ts";
import { stableStringify } from "../contracts/stable-json.ts";
import { LaError, UnscriptedLlmCallError } from "../infra/errors.ts";
import { relativeToProject } from "../infra/paths.ts";
import type { PromptSpec } from "../prompts/prompt-spec.ts";
import { hypothesizePrompt } from "../prompts/v1/hypothesize.ts";
import { survivorInputsPrompt } from "../prompts/v1/survivor-inputs.ts";
import type { LlmProvider, LlmRaw } from "./provider.ts";

export const PROMPTS: readonly PromptSpec<unknown, unknown>[] = [hypothesizePrompt as PromptSpec<unknown, unknown>, survivorInputsPrompt as PromptSpec<unknown, unknown>];

export function promptHash(prompt: PromptSpec<unknown, unknown>): string {
  return "sha256:" + createHash("sha256").update(prompt.version + "\n" + prompt.system).digest("hex");
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  return issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message;
}

const tokens = (chars: number): number => Math.ceil(chars / 4);

export type FakeProvider = LlmProvider & { assertAllConsumed(): void; consumedIds(): string[] };

export function createFakeProvider(opts: { fixturePath: string; targetSha: string; functionIds: readonly string[] }): FakeProvider {
  const shown = relativeToProject(opts.fixturePath);
  if (!existsSync(opts.fixturePath)) throw new LaError("FIXTURE_NOT_FOUND", `fixture not found: ${shown}`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(opts.fixturePath, "utf8"));
  } catch (err) {
    throw new LaError("FIXTURE_NOT_FOUND", `invalid fixture: ${shown} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = llmFixtureSchema.safeParse(json);
  if (!parsed.success) throw new LaError("FIXTURE_NOT_FOUND", `invalid fixture: ${firstIssue(parsed.error)}`);
  const fixture = parsed.data;

  if (fixture.targetSha !== opts.targetSha) {
    throw new LaError("FIXTURE_TARGET_DRIFT", `${shown} was written for target ${fixture.targetSha.slice(7, 15)}, the target is ${opts.targetSha.slice(7, 15)}; run npm run fixtures:rehash after checking the turns`);
  }
  const known = new Set(opts.functionIds);
  const unknownIds = [...new Set(fixture.turns.map((t) => t.when.functionId).filter((id) => typeof id === "string" && !known.has(id)))];
  if (unknownIds.length > 0) throw new LaError("FIXTURE_TARGET_DRIFT", `${shown} scripts functions the map does not have: ${unknownIds.join(", ")}`);

  const byVersion = new Map(PROMPTS.map((p) => [p.version, p] as const));
  const used = new Set(fixture.turns.map((t) => t.prompt));
  for (const version of used) {
    if (!byVersion.has(version)) {
      const turn = fixture.turns.find((t) => t.prompt === version)!;
      throw new LaError("FIXTURE_NOT_FOUND", `invalid fixture: turn ${turn.id}: unknown prompt ${version}`);
    }
  }
  for (const prompt of PROMPTS) {
    const recorded = fixture.promptHashes[prompt.version];
    const missing = recorded === undefined && used.has(prompt.version);
    if (missing || (recorded !== undefined && recorded !== promptHash(prompt))) {
      throw new LaError("FIXTURE_PROMPT_DRIFT", `${shown}: the ${prompt.version} prompt changed since the fixture was written; run npm run fixtures:rehash`);
    }
  }
  for (const turn of fixture.turns) {
    if (turn.output === undefined) continue;
    const check = byVersion.get(turn.prompt)!.outputSchema.safeParse(turn.output);
    if (!check.success) throw new LaError("FIXTURE_NOT_FOUND", `invalid fixture: turn ${turn.id}: ${firstIssue(check.error)}`);
  }

  const consumed: string[] = [];
  const matches = (turn: LlmFixtureTurn, version: string, keys: Record<string, string | number | boolean>): boolean => {
    if (turn.prompt !== version || consumed.includes(turn.id)) return false;
    if ((turn.when.repair === true) !== (keys.repair === true)) return false;
    return Object.entries(turn.when).every(([k, v]) => keys[k] === v);
  };

  return {
    name: "fake",
    async complete(call): Promise<LlmRaw> {
      const version = call.prompt.version;
      const turn = fixture.turns.find((t) => matches(t, version, call.matchKeys));
      if (!turn) {
        throw new UnscriptedLlmCallError(`no scripted turn for ${version} ${stableStringify(call.matchKeys)}; consumed: [${consumed.join(", ")}]; known: [${fixture.turns.map((t) => t.id).join(", ")}]`);
      }
      consumed.push(turn.id);
      if (turn.error) {
        if (turn.error.kind !== "invalid_output") throw new LaError("LLM_UNAVAILABLE", `fake: simulated ${turn.error.kind}`);
      }
      const text = turn.error?.kind === "invalid_output" ? turn.error.raw : JSON.stringify(turn.output);
      const promptChars = call.messages.reduce((n, m) => n + m.content.length, 0);
      return { text, usage: turn.usage ?? { promptTokens: tokens(promptChars), completionTokens: tokens(text.length) }, model: "fake" };
    },
    assertAllConsumed(): void {
      const dead = fixture.turns.filter((t) => !consumed.includes(t.id)).map((t) => t.id);
      if (dead.length > 0) throw new LaError("FIXTURE_UNCONSUMED", `turns never used: ${dead.join(", ")}`);
    },
    consumedIds(): string[] {
      return [...consumed];
    },
  };
}
