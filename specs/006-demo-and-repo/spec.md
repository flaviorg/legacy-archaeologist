# 006 · Demo and repository process

Status: implemented (v1)

## Context

`npm ci && npm run demo` runs three passes offline: `none` on the billing fixture, the scripted fake on the same fixture (then `verify` against the modern and the broken refactor), and `none` on the vendored `bytes@3.1.2`. It prints a 12-line hero and the full log, both computed from the artifacts and compared with goldens; the README carries both blocks.
The repository process keeps the claims honest: EARS specs with a coverage check, a conventions test for the dependency rules, goldens regenerated only by code, `check:secrets`, a pre-commit hook and CI.
Code: `scripts/demo.ts`, `src/pipeline/{demo-hero,demo-summary,eval-llm}.ts`, `scripts/{eval-llm,check-secrets,check-diagrams}.ts`, `tests/demo/demo.e2e.test.ts`, `tests/unit/conventions.unit.test.ts`.

## Acceptance criteria

Copied verbatim from the design document, section 8.3.

- **DEMO-01** When `npm run demo` runs with no `.env`, no key and the network guard, it shall exit 0, write `artifacts/demo-baseline/` (pass A, `none`), `artifacts/demo/` (pass B, fake) and `artifacts/demo-third-party/` (pass C, `none` on `bytes`), run the modern refactor (0 failures) and the broken refactor (exactly the failures listed in `tests/golden/demo/verify-broken.json`) on pass B, print the hero and the summary within the demo bound of section 6.1, and print progress lines and the wall time on stderr only.
- **DEMO-02** When `npm run demo` runs with `LLM_API_KEY` set in the environment and without `--live`, it shall still use the fake for pass B and print `provider: fake (scripted)`.
- **DEMO-03** The README region between `<!-- demo-hero:start -->` and `<!-- demo-hero:end -->` shall equal `tests/golden/demo/demo-hero.txt`, the `<details>` region between `<!-- demo-log:start -->` and `<!-- demo-log:end -->` shall equal `tests/golden/demo/demo-summary.txt`, and the mutation scores in both shall equal those in `tests/golden/demo/mutation.json`, `tests/golden/demo-baseline/mutation.json` and `tests/golden/third-party/bytes/mutation.json`.
- **DEMO-04** When `run --provider none` runs on `fixtures/legacy-billing` and on `fixtures/third-party/<name>` (the demo's passes A and C), the artifacts shall equal `tests/golden/demo-baseline/*` and `tests/golden/third-party/<name>/*`, and `SPEC.md` shall carry the label `provider: none (no LLM)` and no rules table.
- **DEMO-05** When `scripts/eval-llm.ts` receives a `none` run and a provider run of the same `targetSha`, it shall print a deterministic table with rules by status, inputs proposed, accepted and rejected by reason, cases recorded, kills per accepted survivor input, both scores and the delta, and shall refuse runs with different `targetSha`.
- **DEMO-06** For every run, the set of case IDs in the emitted test file shall equal `mutation.json.replayedCases`, so the score and the tests cover the same cases.
- **REP-01** `AGENTS.md` shall have at most 100 lines.
- **REP-02** `.env.example` shall list every variable read by `src/infra/config.ts`.
- **REP-03** If any test attempts a connection to a non-loopback host, then the guard shall fail it with `NO_NETWORK`.
- **REP-04** The dependency rules 1 to 6 of section 4.3 shall hold for every file under `src/`.
- **REP-05** The repository shall contain no `TODO`, `TBD`, placeholder text or key-shaped string in versioned files outside `tests/`, and `.githooks/pre-commit` shall exist and be executable.
- **REP-06** Every CLI failure shall exit with the code of section 5.5 and print one `error: <CODE>: <message>` line on stderr with no stack and no secret.
- **REP-07** When a `tests/golden/real-run-*/` directory exists, the README's real-model column shall equal the scores in its `eval.md` files and name its model and date; when none exists, the column shall read `not run`.

## Non-goals

- Publishing to npm or GitHub: nothing is published without the owner's validation.
- A web UI, MCP server or HTTP API: the ports are the CLI and the JSON artifacts.
- A rendered demo SVG card: optional work (M9); v1 shows the hero and the log as text blocks.
- Windows: scripts are portable, but CI runs on Ubuntu only.

## Decisions made during implementation

Numbered deltas refer to the plan (1 to 23) and to `docs/api-notes.md` (24 on).

- Plan delta 1: the repository process files (`AGENTS.md`, `specs/`, `.env.example`, `LICENSE`, `check-secrets`, the hook, CI, `docs/`, the full README) were written in the last milestone; the guardrail tests (network guard, dependency-rule scanners, redaction) existed from M0.
- Plan delta 21: the demo test runs `scripts/demo.ts` with its default output prefix (`artifacts/demo`, `artifacts/demo-baseline`, `artifacts/demo-third-party`); the lying run writes `artifacts/test-demo-lying/`.
- Plan delta 23 and delta 29: the rule 6 scan allows `src/harness/child/main.ts` (`LA_NONCE`) and `src/generate/support-template.ts` (emitted text), and ignores the quoted side-effect kind name `"process.env"`.
- Deltas 81, 82 and 85: HYP-01 checks that every hypothesize turn is consumed; `bytes` was packed from the local npm cache with its license and checksums in `VENDORED.md`, and the pending-marker scan skips `fixtures/third-party/`; record-focused CLI tests pass `--max-mutants 1 --max-rounds 0`.
- Deltas 86 to 99 (`docs/api-notes.md`): the demo's input gains the fixture's line count and the third-party license; stdout is the hero followed by the summary, whose leading blank line separates them; the summary counts round-0 rejections only and lists at most five verify failures; a broken demo expectation is `DEMO_EXPECTATION` (exit 2); the offline demo uses the default limits whatever the environment says; `--live` writes `eval.md` for both targets and prints the two tables; the marker scan skips the REP-05 criterion line; `check:secrets` reports one finding per key; the CI action majors were not re-checked here.
- Measured (2026-10-13, macOS): `npm run demo` 82.1 to 82.4 s (bound 90 s); `npm test` 110.1 to 110.3 s (bound 180 s), also in a clean copy without `node_modules` and `artifacts`. The CI timings are recorded in the README after the first CI run.

- Deltas 102 to 105 (final review): `npm run la` loads `./.env` through `src/bin.ts` without the Node warning; the CS-3 check reads test names only; unused exports are dropped and checked; no Portuguese sample text.

## Test files

| Criterion | Test files |
|---|---|
| DEMO-01 | `tests/demo/demo.e2e.test.ts` |
| DEMO-02 | `tests/demo/demo.e2e.test.ts` |
| DEMO-03 | `tests/demo/demo.e2e.test.ts`, `tests/unit/conventions.unit.test.ts`, `tests/unit/demo-hero.unit.test.ts` |
| DEMO-04 | `tests/demo/demo.e2e.test.ts` |
| DEMO-05 | `tests/unit/eval-llm.unit.test.ts` |
| DEMO-06 | `tests/demo/demo.e2e.test.ts`, `tests/e2e/mutation.e2e.test.ts` |
| REP-01 | `tests/unit/conventions.unit.test.ts` |
| REP-02 | `tests/unit/conventions.unit.test.ts` |
| REP-03 | `tests/e2e/guard.e2e.test.ts`, `tests/unit/no-network.unit.test.ts` |
| REP-04 | `tests/unit/conventions.unit.test.ts` |
| REP-05 | `tests/unit/conventions.unit.test.ts` |
| REP-06 | `tests/e2e/cli.e2e.test.ts`, `tests/unit/errors.unit.test.ts` |
| REP-07 | `tests/unit/conventions.unit.test.ts` |
