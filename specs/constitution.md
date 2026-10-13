# Constitution

The rules every change to legacy-archaeologist keeps. The feature specs (`specs/001-*` to `specs/006-*`) hold the acceptance criteria; this file holds what no criterion may break.

## The model proposes; deterministic code verifies, decides and measures

1. The LLM proposes business-rule hypotheses, input partitions, boundary values and extra inputs for surviving mutants. Zod schemas and the case planner validate every proposal before anything runs.
2. Expected values come from execution, never from the LLM. Every expected value in `records.json` and in a generated test was recorded from the real code in an isolated child, twice. Predictions live on rules and only classify them.
3. Kill verdicts and the mutation score are computed by code (replay, one comparator, Stryker's formula). An LLM "likely equivalent" flag is advisory and never changes the number.
4. The tool never writes to the target. There is no code path that edits the legacy code, and a full run leaves the target's `targetSha` unchanged.

## Safety

5. Trusted code only. The `--permission` child, the network guard, the fd 3 nonce and the watchdogs are a seat belt, not a sandbox. Targets outside `fixtures/` need `--i-trust-this-code`.
6. Offline by default. The demo and `npm test` use the scripted fake provider or `none`, never the network and never a key. A real provider is chosen only through the environment (`LLM_PROVIDER`, `LLM_API_KEY`).
7. Secrets never leave. Every string that leaves the process goes through `redactSecrets`; `.env` is ignored by Git; `check:secrets` runs in the pre-commit hook and in CI.

## Dependencies

8. Exact versions, a lockfile and `engine-strict`. Three runtime dependencies: `acorn` 8.19.0, `acorn-walk` 8.3.5, `zod` 4.6.5. Development dependencies: `typescript` 7.0.2 (type checking only) and `@types/node` 24.19.1. Nothing else.
9. Every library or runtime API is checked against the installed version before code relies on it ("Step 0", recorded in `docs/api-notes.md`).
10. The dependency rules of `docs/architecture.md` are checked by `tests/unit/conventions.unit.test.ts`.

## Tests

11. TDD: the test for a criterion fails before the implementation. A test that proves an EARS criterion starts its name with the ID in brackets (`[REC-03] ...`), and every ID in `specs/` has such a test (CS-3).
12. `npm test` never uses the network: a guard is loaded with `--import` and every child gets an explicit minimal environment. Key-shaped test values are built at run time.
13. Goldens under `tests/golden/` are written only by code (`npm run regen`) and reviewed by hand before they are kept. No golden contains a wall-clock value, a measured duration or an absolute path.

## Writing

14. Everything is in English: code, comments, identifiers, test names, CLI output, logs, prompts, fixtures and docs.
15. Claims in the README and `docs/` are the measured ones: recorded cases, the mutation score with its formula and operator set, flagged behaviors. No claim of correctness or of capturing all behavior.
16. No course material is copied into the repository.

## Publication

17. Nothing is committed, pushed or published without the owner's validation. Until a real-model run is committed under `tests/golden/real-run-*/`, the README's real-model column reads `not run` and the README promises no future run.
