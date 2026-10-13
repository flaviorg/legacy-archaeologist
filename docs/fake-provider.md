# The fake provider

The demo and `npm test` run with no key and no network. The LLM's part is played by a scripted fake that answers from a JSON fixture, or skipped entirely with the `none` provider. The fake proves the **mechanics** (contracts, caps, recording, scoring, the survivor loop, reporting), not the model's quality.

## What is scripted and what cannot be

| Scripted in `fixtures/llm/legacy-billing.json` | Cannot be scripted, by construction |
|---|---|
| The 7 `hypothesize.v1` answers: rule statements, predictions, probe inputs and labels, partitions, notes | Any expected value: every outcome in `records.json` and in the tests is recorded from `billing.js` in the isolated child |
| The 11 `survivor-inputs.v1` answers for the first 10 round-0 survivors, including one invalid answer with its repair and one `likelyEquivalent: true` answer | Any kill verdict or score: replay, the comparator and Stryker's formula are code |
| | Any rule status: `consistent`, `contradicted` or `unverified` comes from comparing a prediction with the recorded outcome |
| | Any change to the target: there is no code path that writes to it |

The survivor turns were written by the author **after** reading the real round-0 survivors in `mutation.json` (all ten were in `prorate`). The demo's one `likelyEquivalent: true` answer (`m-0036`) is a plausible but wrong judgement kept on purpose: another survivor's input kills that mutant in the same round, which shows the flag is advisory. That is why the hero line reads *scripted: author-written survivor inputs; proves the loop, not the model*, and why the demo also prints the `none` score, which nobody scripted.

The fake ignores the `system` and `user` texts except for their hash: it cannot "read" the code.

## Organization

- `src/llm/provider.ts`: the port and `callLlm` (builds the messages, validates with the prompt's Zod schema, repairs once, fails closed, writes the trace).
- `src/llm/fake-provider.ts`: `createFakeProvider({ fixturePath, targetSha, functionIds })` reads one fixture, validated by `llmFixtureSchema` at load time. An invalid fixture, a `targetSha` mismatch or a `when.functionId` that is not in the map fails before the run starts.
- `src/llm/openai-compatible.ts`: the real client, with an injectable `fetch` for its unit tests.
- Demo fixtures live in `fixtures/llm/<scenario>.json` (the scenario defaults to the target's base name); test-only fixtures in `tests/fixtures/llm/`.

## Fixture format

```json
{
  "schemaVersion": 1,
  "scenario": "legacy-billing",
  "targetDir": "fixtures/legacy-billing",
  "targetSha": "sha256:688d8c7a…",
  "promptHashes": { "hypothesize.v1": "sha256:…", "survivor-inputs.v1": "sha256:…" },
  "turns": [
    { "id": "hyp-applyDiscount", "prompt": "hypothesize.v1", "when": { "functionId": "billing.js#applyDiscount" },
      "output": { "rules": [ { "key": "vip-threshold", "statement": "…", "relatedConstants": [100], "probes": [ … ] } ], "partitions": [ … ] } },
    { "id": "survivor-m-0041-invalid", "prompt": "survivor-inputs.v1", "when": { "round": 1, "mutantId": "m-0041" },
      "error": { "kind": "invalid_output", "raw": "…" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `targetSha` | Must equal the current target's sha, otherwise `FIXTURE_TARGET_DRIFT` (function and mutant IDs would be meaningless). `npm run fixtures:rehash` updates it |
| `promptHashes` | `"sha256:" + sha256(version + "\n" + system)` per prompt; a mismatch is `FIXTURE_PROMPT_DRIFT` with the instruction to run `fixtures:rehash` |
| `turns[].when` | Equality on a subset of the prompt's match keys: `hypothesize.v1` → `{ functionId }`; `survivor-inputs.v1` → `{ round, mutantId }` |
| `output` or `error` | Exactly one. The output is validated by the prompt's schema when the fixture loads, so a bad script fails in `tests/unit/fake-provider.unit.test.ts`, not mid-demo. Errors: `timeout`, `rate_limit`, `server_error`, `invalid_output` (raw text that fails Zod, used to test repair and fail-closed) |
| `usage` | Optional token counts; without it, about 4 characters per token |

Rules: a turn is consumed once per run; a call with no matching unconsumed turn throws `UNSCRIPTED_LLM_CALL` naming the prompt, the match keys, the consumed IDs and the known IDs; the demo runs the fake in strict mode, so a turn that is never consumed fails the run with `FIXTURE_UNCONSUMED`. A repair call carries `repair: true` in its keys; when it is unscripted, `callLlm` fails closed with `LLM_OUTPUT_INVALID`.

## Scenarios

| Scenario | File | What it proves |
|---|---|---|
| `legacy-billing` | `fixtures/llm/legacy-billing.json` | The demo: 7 hypothesis turns and 11 survivor turns, consumed in strict mode; golden artifacts |
| `lying-hypotheses` | `tests/fixtures/llm/lying-hypotheses.json` | Same inputs, labels and survivor turns, but every prediction wrong and every statement false (derived by `scripts/make-lying-fixture.ts`). `records.json`, the test file and `support.mts` stay byte-identical; `SPEC.md`, `report.json`, `hypotheses.json` and the trace differ (LLM-03) |
| `garbage-output` | `tests/fixtures/llm/garbage-output.json` | Output that fails Zod on the first call and on the repair: exit 2, `LLM_OUTPUT_INVALID`, no `records.json` (LLM-04) |
| `oversize-inputs` | `tests/fixtures/llm/oversize-inputs.json` | Oversize and malformed output rejected by Zod; within limits, the planner rejects `ARITY` and `DEPTH` with reasons (LLM-04, HYP-04) |
| `survivor-equivalent` | `tests/fixtures/llm/survivor-equivalent.json` | `likelyEquivalent: true` with no inputs: the mutant stays `survived`, the flag is stored, the score is unchanged (MUT-09) |
| `survivor-mini` | `tests/fixtures/llm/survivor-mini.json` | The survivor loop on a tiny target (MUT-06, MUT-07) |

## The `none` provider

`LLM_PROVIDER=none` skips the LLM entirely: `baseline-inputs.ts` derives partitions from parameter positions, structured seeds and magic-number boundaries, as a pure function of the map (HYP-06). There are no rules, no survivor round and an empty trace. It is the provider the CLI falls back to when a target has no fixture and no key is configured, and it gives the demo a score nobody scripted.

## Real mode

`LLM_PROVIDER=openai-compatible` with `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL` (default `https://openrouter.ai/api/v1` and `openrouter/free`). The client sends `{ model, temperature: 0, response_format: { type: "json_object" }, messages }`, times out after `LLM_TIMEOUT_MS`, retries once on 429, 5xx and network errors, and never logs request headers. `npm run test:live` runs the hypothesize stage with the real provider and asserts structure only; it is skipped without a key.

`npm run demo -- --live` replaces pass B with the configured provider (`artifacts/demo-live/`), runs it on `bytes` too (`artifacts/demo-live-third-party/`) and writes the `eval-llm` table (`eval.md`) next to each. Before publication the owner runs it once and commits the redacted trace, `hypotheses.json`, `mutation.json`, `SPEC.md` and `eval.md` of both targets under `tests/golden/real-run-<model>-<date>/`, labeled as a single run, not a benchmark.
