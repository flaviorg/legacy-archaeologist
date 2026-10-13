# 004 · Generated tests, SPEC.md and verify

Status: implemented (v1)

## Context

After the survivor loop, the generate stage emits one `node:test` file per module (`.mts`, a self-contained `support.mts` that reproduces the recorder's world) from the map and the records only, and a `SPEC.md` where every rule links to test names and source lines, with a suspicious-behaviors list where a prediction disagrees with what the code does, flagged for humans and never fixed.
`verify --against <dir>` runs each generated file directly under the same `--permission` grants and guard, with `--test-force-exit` and a file watchdog, and parses the TAP stream.
Code: `src/generate/*.ts`, `src/pipeline/{evaluate-rules,generate,tap,verify}.ts`, `fixtures/refactors/{modern,broken}`.

## Acceptance criteria

Copied verbatim from the design document, section 8.3.

- **GEN-01** When `generate` runs, the system shall emit one `node:test` file per module whose tests, executed with `node --test` against the original target, all pass in any test order and with any `TZ` in the environment, including two cases of the same file that depend on `Math.random`, the counters or the clock (each test re-seeds the world through `loadFresh` before invoking), and an ESM target whose state lives in a statically imported file (the emitted `support.mts` sets `TZ=UTC` and registers the query-propagating resolve hook).
- **GEN-02** Each emitted test shall be named `[<caseId>] <origin>: <label>` where `<origin>` is `probe <BR-ids>`, `partition`, `boundary of <caseId>`, `survivor <mutantId>` or `baseline`, with labels sanitized to printable ASCII and at most 120 characters, and no test name shall contain a rule statement.
- **GEN-03** The system shall write `SPEC.md` with, per function, signature, source lines, complexity, side effects, magic numbers, the rules table with status, probe count, probe inputs and observed outcomes, and links to test names and test file lines, the suspicious behaviors section, the "Not characterized" table and the provider label.
- **GEN-04** The system shall not emit a test for a case whose outcome is `timeout` or `no-callback`, whose determinism is `unstable`, or whose outcome carries an Error tag with code `NO_NETWORK` or `ERR_ACCESS_DENIED` (a sandbox-only outcome), and shall list each such case in `SPEC.md` under "Not characterized" with its reason.
- **GEN-05** The emitted `support.mts` shall import only `node:*` modules, and the emitted `.mts` files shall run with `node --test` from inside a package whose `package.json` says `"type": "commonjs"`, so the generated tests run in a repository that does not contain legacy-archaeologist.
- **GEN-06** When `verify --against fixtures/refactors/modern` runs, all emitted tests shall pass, including the 3-step `nextInvoiceNumber` sequence (which proves a fresh ESM instance per test), and the command shall exit 0.
- **GEN-07** When `verify --against fixtures/refactors/broken` runs, exactly the cases listed in `tests/golden/demo/verify-broken.json` shall fail, the output shall show expected and actual for each, the command shall exit 3, and each of the two changes in the broken refactor shall be the cause of at least one listed failure.
- **GEN-08** When `verify --against <dir>` runs, the emitted tests shall resolve `<dir>/<module name>` against the extensions `.js`, `.cjs`, `.mjs`, `.ts`, `.mts` in that order and load ESM with `import()` and CJS with `createRequire`; when no candidate exists, `verify` shall report `MODULE_NOT_FOUND_IN_AGAINST` and exit 2; when a test file is killed by the file watchdog, `verify` shall report it as a timeout and exit 3; a passing file whose target leaves a timer running shall exit 0 (`--test-force-exit`).
- **GEN-09** When a target exports non-function values, the emitted tests shall assert `stateAfter` with `taggedEqual` on tagged values (synthetic CJS `default` key excluded, function values dropped), and the tests emitted from a CommonJS target shall pass against that target and against an ESM copy of it.
- **SUS-01** When a rule's probe prediction differs from the recorded outcome of the probe's last step, the system shall mark the rule `contradicted` and add an `SB-nn` entry with hypothesis, predicted, observed, source lines, and the test that pins the observed behavior.
- **SUS-02** When a rule has only `unknown` predictions or only unstable probes, the system shall mark it `unverified`, never `consistent`; when every checked probe matches, the status shall be `consistent` with the number of probes checked.
- **SUS-03** After a full `run`, the target directory's `targetSha` shall be unchanged (the tool never writes to the target).

## Non-goals

- Fixing or refactoring the legacy code: the tool records what it does and flags what looks wrong (SUS-03 asserts the target is unchanged).
- Claiming to capture all behavior or prove correctness: characterization tests record behavior on the inputs that were tried.
- Coverage reporting as a quality claim: the project's metric is the mutation score.

## Decisions made during implementation

Numbered deltas refer to the plan (1 to 23) and to `docs/api-notes.md` (24 on).

- Plan delta 3: `stableStringify` sorts envelope keys but never reorders the values under `args`, `value` and `stateAfter`, whose key order is behavior (D-09).
- Plan delta 7: `support.mts` is a readable hand-written template, and D-08 ("same bodies") is enforced behaviorally: `emit-tests.unit` checks its pure functions against the tool's own, and `generate.e2e` compares the world it builds with the recorder's from two children. Delta 54: plain JavaScript in an `.mts` file, about 560 lines.
- Plan delta 9 as corrected by delta 64: TAP escapes `#` as `\#` and quotes one-line failure messages the way `util.inspect` quotes strings (not YAML `''`); `parseTap` reads all three quote styles. `verify` checks the module in `--against` before spawning, so `MODULE_NOT_FOUND_IN_AGAINST` is exit 2.
- Plan delta 16: `support.mts` also exports `captureAsync(fn, timeoutMs)` for promise outcomes.
- Deltas 55 to 57: `support.mts` replaces `process.exit` only while a captured call runs (the runner calls it for `--test-force-exit`), returns the same live CommonJS `Proxy` as the recorder and normalizes Error messages like the recorder.
- Deltas 58 to 61: `describeOutcome` prints 1-based steps; expected outcomes are compact JSON with a fixed field order and `__proto__` keys go through `JSON.parse`; a second module with the same base name gets its path in the test file name; a probe is checkable only when its case is characterized, so every SB entry has an emitted test that pins it.
- Delta 63: `SPEC.md` prints `Module state read` (the map stores no constant values), the Source column as `file:start-end` plus related constants found among the magic numbers, and the provider label `provider: fake (scripted)` / `provider: none (no LLM)`.
- Deltas 65 to 67: `verify` counts every test of a killed or crashed file as failed, keeps `file` and `target` project-relative, refuses foreign options; an ESM namespace lists exports alphabetically, so GEN-09 holds against an ESM copy only when the CommonJS export keys are alphabetical too.
- Delta 69: the modern refactor keeps the object-lookup accident (`"toString"` as a code gives `NaN`) and calls the error callback with one argument.
- Delta 106: `verify` gives each file's child a temporary file as stdout (node writes it synchronously, so `--test-force-exit` cannot drop the end of the TAP stream when a loaded machine delays the parent), kills a file whose stdout passes 16 MiB, and counts every test without a TAP result as failed, so a short stream never reads as a pass.
- Step 0 (2026-10-13): runtime `process.env.TZ = "UTC"` overrides the environment inside a file run under `--permission`; a passing file that leaves a timer exits 0 only with `--test-force-exit`; `node:assert/strict` `deepEqual` ignores key order, hence `taggedEqual`.
- Measured (demo): 96 tests from the fake run pass against `fixtures/refactors/modern`; 5 of them fail against `fixtures/refactors/broken` (`roundMoney` c01, c07, c08 from the rounding change, `applyDiscount` c01 and `calculateInvoice` c02 from the `>=` threshold); `SPEC.md` shows SB-01 to SB-03.

## Test files

| Criterion | Test files |
|---|---|
| GEN-01 | `tests/e2e/generate.e2e.test.ts` |
| GEN-02 | `tests/unit/emit-tests.unit.test.ts` |
| GEN-03 | `tests/unit/write-spec.unit.test.ts` |
| GEN-04 | `tests/e2e/generate.e2e.test.ts`, `tests/unit/emit-tests.unit.test.ts`, `tests/unit/outcomes.unit.test.ts`, `tests/unit/write-spec.unit.test.ts` |
| GEN-05 | `tests/e2e/generate.e2e.test.ts` |
| GEN-06 | `tests/demo/demo.e2e.test.ts` |
| GEN-07 | `tests/demo/demo.e2e.test.ts` |
| GEN-08 | `tests/e2e/verify.e2e.test.ts`, `tests/unit/tap.unit.test.ts` |
| GEN-09 | `tests/e2e/verify.e2e.test.ts`, `tests/unit/emit-tests.unit.test.ts`, `tests/unit/outcomes.unit.test.ts` |
| SUS-01 | `tests/e2e/suspicious.e2e.test.ts`, `tests/unit/evaluate-rules.unit.test.ts` |
| SUS-02 | `tests/unit/evaluate-rules.unit.test.ts`, `tests/unit/write-spec.unit.test.ts` |
| SUS-03 | `tests/demo/demo.e2e.test.ts`, `tests/e2e/cli.e2e.test.ts` |
