# ADR 0003: an own replay runner instead of StrykerJS or one test run per mutant

## Status

Accepted (2026-10-08, design D-03).

## Context

The score must say whether the recorded cases detect a change, using exactly the comparison the emitted tests make (tagged outcomes with `outcomesEqual`, tagged `stateAfter` with `taggedEqual`), inside the same isolation as the recording. StrykerJS brings its own mutators (so its number would mean something else) and its runner plugins; running `node --test` on the emitted file for every mutant costs a test-runner start per mutant and cannot run under `--permission` as one process.

## Decision

Replay the characterized cases of the mutant's module in the harness child (one child per mutant, the same spawn as the recorder), compare live and stop at the first difference. A timed-out mutant is replayed once more with the full `steps × caseTimeoutMs` budget before it counts as `timeout`. The score uses Stryker's formula.

## Consequences

- About 0.26 s per surviving mutant on the fixture's 240-case baseline; the whole demo runs in about 82 s on the author's Mac.
- The verdict uses the same comparator as the tests, so a killed mutant is one the emitted tests would also catch, except for differences between the replay and the test runner itself.
- Running the emitted file against sampled mutants as a cross-check (`MUT-10`, `--runner node-test`) is future work; if it ever disagrees, the default switches.

## Alternatives

- StrykerJS with its TAP runner: a mature engine, but a different operator set and no recorded-case replay; a recipe to run it on the generated tests is future work, not a dependency.
- `node --test` on the emitted file per mutant: slower, and the verdict would depend on the runner's process model.
