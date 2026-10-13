# AGENTS.md

Instructions for coding agents (and people) working in this repository. The rules behind them are in `specs/constitution.md`; the acceptance criteria are in `specs/00*/spec.md`.

## Commands

| Command | What it does |
|---|---|
| `npm test` | `test:fast` (unit and tiny-target e2e files, concurrently) then `test:demo` (the demo target alone). Offline |
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7 is used for type checking only) |
| `npm run demo` | The offline demo: `none` and fake passes on the billing fixture, two `verify` runs, `none` on `bytes` |
| `npm run regen` | Rewrites `tests/golden/**` and the two README demo regions from a real demo run |
| `npm run fixtures:rehash` | Updates `targetSha` and `promptHashes` in the fake fixtures and regenerates the lying fixture |
| `npm run check:secrets` | Scans the tree for key-shaped strings (pre-commit and CI) |
| `npm run diagrams:check` | Renders every Mermaid diagram with mermaid-cli 12.0.0 (local only; needs `npx`) |
| `npm run la -- <map\|run\|verify> ...` | The CLI, for example `npm run la -- run --target fixtures/legacy-billing` |
| `npm run setup:hooks` | Points Git at `.githooks/` (once per clone) |

Node 24.21 or a later 24.x (`engine-strict`). Dependencies are exact versions; add none without the owner.

## Layers and dependency rules

`src/contracts` (types and Zod schemas) · `src/static` (acorn map) · `src/harness` (staged copy and the `--permission` child) · `src/llm` and `src/prompts` (providers) · `src/pipeline` (stages) · `src/mutation` · `src/generate` (tests and `SPEC.md`) · `src/infra` · `src/cli.ts` (with `src/bin.ts`, the `npm run la` entry that loads `./.env` when present).

1. `src/contracts/**` imports only `zod` and other contracts; `tagged.ts` and `outcomes.ts` import only each other.
2. `src/static/**` imports only `acorn`, `acorn-walk` and contracts; value imports of `acorn` live only in `src/static/parser.ts`.
3. `src/harness/child/**` imports only `node:*`, `src/contracts/tagged.ts` and `src/contracts/outcomes.ts` (the child's read grant has no `node_modules`).
4. `src/llm/**` never imports `src/harness` or `src/mutation`.
5. Pure modules (`src/generate/**`, the mutator, the score, the planner, the baseline inputs, the rule evaluator, `eval-llm`, `demo-hero`, `demo-summary`) use no `node:fs`, no `node:child_process`, no `process.env`.
6. Only `src/cli.ts`, `src/infra/config.ts` and `scripts/*.ts` read `process.env` (plus the child's `LA_NONCE` and the emitted text of `support-template.ts`).
7. Erasable TypeScript only: no `enum`, `namespace`, parameter properties or decorators; relative imports end in `.ts`.
8. `src/generate/emit-tests.ts` and `support-template.ts` never see a rule status, a hypothesis or an LLM type.

`tests/unit/conventions.unit.test.ts` checks rules 1 to 6 and 8; `tsc` checks rule 7.

## The model proposes, code decides

The LLM proposes rule hypotheses, inputs and survivor inputs; Zod and the planner validate them. Expected values are recorded from the real code; kill verdicts and the score are computed by code. Two places enforce it: dependency rule 8 (the emitter is blind to statuses and statements) and LLM-03 (a lying fake changes no byte of `records.json`, the test file or `support.mts`).

## Working rules

- TDD: write the failing test first. A test that proves an EARS criterion starts its name with the ID in brackets (`[MUT-04] ...`); every ID in `specs/` needs one (CS-3).
- `npm test` is offline: the guard in `tests/setup/no-network.ts` fails any non-loopback connection, and children get an explicit minimal environment. Build key-shaped test values at run time (`"sk-or-v1-" + "a".repeat(40)`).
- Every e2e test copies its tiny target from `tests/fixtures/targets/` with `tmpTarget`; only `tests/demo/demo.e2e.test.ts` runs the billing fixture end to end.
- Goldens change only through `npm run regen`, and every changed golden is reviewed by hand before it is kept. No golden may hold a timestamp, a duration or an absolute path.
- Changed `fixtures/legacy-billing` or a prompt: run `npm run fixtures:rehash`, then `npm run regen`.
- The demo fixture's survivor turns are written after reading the real round-0 survivors in `mutation.json`, and the README says so.
- A new library or runtime API: check it against the installed version first and record it in `docs/api-notes.md`.
- Trusted code only: the isolation is a seat belt. Never point the tool at code you would not run.
- No commit, push or publish without the owner. Never write a secret into a file; `.env` stays ignored.
- Everything in English. Never copy course material into the repository.
