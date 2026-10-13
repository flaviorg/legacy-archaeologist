# 003 · LLM proposals and providers

Status: implemented (v1)

## Context

The LLM proposes, per exported function, business-rule hypotheses with checkable predictions, input partitions and boundary values (`hypothesize.v1`), and extra inputs for surviving mutants (`survivor-inputs.v1`). Every output is validated by a Zod schema with caps, repaired once and then fails closed; the case planner validates, deduplicates, expands and caps the inputs.
Providers: the scripted fake (default for the bundled fixture), `none` (inputs derived from the static map, no LLM at all) and an OpenAI-compatible `fetch` client chosen only through the environment. Every call is written to `llm-trace.jsonl`, redacted.
Code: `src/llm/*.ts`, `src/prompts/**`, `src/contracts/{hypotheses,llm-fixture}.ts`, `src/pipeline/{hypothesize,baseline-inputs,plan-cases}.ts`, `scripts/rehash-fixtures.ts`, `scripts/make-lying-fixture.ts`.

## Acceptance criteria

Copied verbatim from the design document, section 8.3.

- **HYP-01** When the hypothesize stage runs, the system shall call `hypothesize.v1` once per exported function with the function source (truncated at 8,192 bytes with a marker), parameter names, callback flag, side effects, magic numbers and callee names, and write `hypotheses.json` and `llm-trace.jsonl`.
- **HYP-02** The user message of each prompt shall be a pure function of its input (two builds are identical) and shall contain no absolute path and no environment value.
- **HYP-03** When proposals are planned, the system shall assign case IDs by the order of section 5.9, deduplicate identical steps, add boundary expansions for numeric arguments, and cap at 40 cases per function.
- **HYP-04** If a proposal exceeds arity, nesting or size, or carries a malformed or output-only tag, then the system shall reject it (the whole output through Zod, with the repair-then-fail-closed rule of LLM-02; a single input through the planner with a reason code in `hypotheses.json.rejected` and in the trace, without aborting the stage), and no rejected value shall reach `revive` or the child.
- **HYP-05** A prediction in a hypothesis shall never appear as an expected value in `records.json` or in a generated test (the expected value of every emitted test equals the recorded outcome).
- **HYP-06** While `LLM_PROVIDER` is `none`, the system shall derive every proposal from the baseline value table of section 5.2 as a pure function of the static map (two runs produce identical `hypotheses.json`), with `rules: []`, `provider: "none"`, an empty trace, and the same planner, IDs and caps as any other provider.
- **LLM-01** While `LLM_PROVIDER` is `fake`, the system shall answer every call from the fixture whose `targetSha` and `promptHashes` match, and shall fail with `FIXTURE_TARGET_DRIFT` or `FIXTURE_PROMPT_DRIFT` otherwise; while `LLM_PROVIDER` is unset, the CLI shall pick `fake` when a fixture exists for the scenario and `none` otherwise, logging the choice.
- **LLM-02** When a provider's raw text fails the prompt's schema, the system shall make exactly one repair call including the validation issues, and if that also fails, abort with `LLM_OUTPUT_INVALID` and exit 2.
- **LLM-03** When the pipeline runs with the `lying-hypotheses` fixture, `records.json`, every generated test file and `support.mts` shall be byte-identical to the run with the demo fixture, `SPEC.md` shall differ, every rule with at least one checkable probe (non-`unknown` prediction, stable non-timeout recorded case) shall be `contradicted`, and the suspicious count shall equal the number of checkable probes.
- **LLM-04** When the pipeline runs with the `garbage-output` fixture, the system shall exit 2 with `LLM_OUTPUT_INVALID` and write no `records.json`.
- **LLM-05** If the fake receives a call with no matching unconsumed turn, then it shall throw `UNSCRIPTED_LLM_CALL` naming the prompt, the match keys, the consumed and the known turn IDs.
- **LLM-06** The system shall pass every log line, trace line, error message and CLI output through `redactSecrets`, so that a key-shaped string or the configured `LLM_API_KEY` value never appears in any output or artifact.
- **LLM-07** When `LLM_PROVIDER` is `openai-compatible`, the client shall POST to `<LLM_BASE_URL>/chat/completions` with `temperature: 0` and JSON response format, abort after `LLM_TIMEOUT_MS`, retry once on 429, 5xx or network error, and never retry on 4xx other than 429.
- **LLM-08** While `LLM_API_KEY` is absent, `test:live` shall skip; with it, it shall assert structure only.

## Non-goals

- LLM-generated mutants or LLM-judged equivalence: mutants are deterministic AST operators, and a "likely equivalent" answer is only a stored suggestion.
- An Anthropic provider and standalone `hypothesize` command: optional work (M9).
- Asserting free LLM prose: labels and statements are only checked for sanitization and length.

## Decisions made during implementation

Numbered deltas refer to the plan (1 to 23) and to `docs/api-notes.md` (24 on).

- Plan delta 4: `PlannedCase.origin` gains `baseline` for the `none` provider's cases; their labels carry no `baseline:` prefix.
- Plan delta 12: fake fixtures carry `targetDir`; `--scenario <name>` looks in `fixtures/llm/` and then `tests/fixtures/llm/`; the lying fixture is derived from the demo fixture by `scripts/make-lying-fixture.ts`, and a unit test keeps the committed file equal to the generator's output (delta 68: the lowercasing and 300-character rules).
- Plan delta 13: `FIXTURE_UNCONSUMED` (exit 2) when a strict run leaves a turn unconsumed.
- Plan delta 14: the trace line gains `repairRaw`; `callLlm` strips one surrounding Markdown code fence before `JSON.parse`.
- Plan delta 17: boundary expansions apply only to single-step round-0 cases; non-integer expansions are rounded to 9 decimals. Delta 53: expansion labels use ` / ` so test names stay printable ASCII.
- Plan delta 19: rule evaluation finds a probe's case by its canonical steps (`stableStringify`).
- Delta 44: `runMapStage` returns every exported function ID, so `FIXTURE_TARGET_DRIFT` sees the whole target under `--only`.
- Deltas 45 to 47: the trace is 1-based and its `systemSha256` is `sha256:<hex>`; a provider error on the first call writes no trace entry; `ARITY` also covers zero or more than 5 steps, `DEPTH` counts containers, a duplicate of an existing case does not merge its `ruleRefs`, and expansions stop silently at the caps.
- Deltas 48 to 52: the `hypothesize.v1` message lists the non-callback parameters and fences the source with one backtick more than its longest run; fixture loading errors (invalid JSON, duplicate turn ids, unknown prompt version) are typed; the OpenAI-compatible client never retries a 200 without content, an abort or a 4xx other than 429, and redacts an error body before cutting it; CLI option ranges; `fixtures:rehash` prints one line per changed hash.
- Deltas 79 and 83: survivor inputs the planner refuses are appended to `hypotheses.json.rejected` with `mutantRef`; the eval table counts round-0 rejections only, and its column labels are `none`, `fake (scripted)` and `openai-compatible (<model>)`.
- Step 0 (2026-10-13): the corrected tagged schema of design 5.2 in zod 4.6.5 rejects every bogus tag of the table and accepts every input tag; `z.prettifyError` names the path; `AbortSignal.timeout` rejects with a `TimeoutError` recognized by name; `openrouter/free` is the default model (listed by the public OpenRouter models endpoint on 2026-10-12).
- Measured: the demo fixture's fake run makes 7 `hypothesize.v1` calls (17 rules, 35 proposed inputs, 0 rejected) and 10 `survivor-inputs.v1` calls (13 inputs proposed, 11 accepted, one repaired answer); the `none` run derives 332 inputs (116 rejected: `CAP_CASES` 94, `DUPLICATE` 22).

## Test files

| Criterion | Test files |
|---|---|
| HYP-01 | `tests/e2e/hypothesize.e2e.test.ts`, `tests/unit/prompts.unit.test.ts` |
| HYP-02 | `tests/unit/prompts.unit.test.ts` |
| HYP-03 | `tests/unit/plan-cases.unit.test.ts` |
| HYP-04 | `tests/e2e/hypothesize.e2e.test.ts`, `tests/unit/call-llm.unit.test.ts`, `tests/unit/plan-cases.unit.test.ts`, `tests/unit/prompts.unit.test.ts` |
| HYP-05 | `tests/demo/demo.e2e.test.ts`, `tests/unit/plan-cases.unit.test.ts` |
| HYP-06 | `tests/e2e/hypothesize.e2e.test.ts`, `tests/unit/baseline-inputs.unit.test.ts` |
| LLM-01 | `tests/e2e/cli.e2e.test.ts`, `tests/e2e/hypothesize.e2e.test.ts`, `tests/unit/fake-provider.unit.test.ts` |
| LLM-02 | `tests/unit/call-llm.unit.test.ts` |
| LLM-03 | `tests/demo/demo.e2e.test.ts`, `tests/unit/lying-fixture.unit.test.ts` |
| LLM-04 | `tests/e2e/cli.e2e.test.ts`, `tests/e2e/hypothesize.e2e.test.ts` |
| LLM-05 | `tests/unit/fake-provider.unit.test.ts` |
| LLM-06 | `tests/demo/demo.e2e.test.ts`, `tests/unit/call-llm.unit.test.ts`, `tests/unit/config.unit.test.ts`, `tests/unit/openai-compatible.unit.test.ts`, `tests/unit/redact.unit.test.ts` |
| LLM-07 | `tests/unit/openai-compatible.unit.test.ts` |
| LLM-08 | `tests/live/real-provider.live.ts` |
