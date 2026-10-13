# ADR 0007: support.mts duplicates the recorder's world, verified behaviorally

## Status

Accepted (2026-10-08, design D-08; plan delta 7). Implemented in M4.

## Context

The generated tests must run in the legacy repository without legacy-archaeologist installed. They need the recorder's world (frozen clock, seeded random and stubs, `TZ=UTC`, the resolve hook), the tagged serializer and the comparator. The design first said a unit test would check that the emitted text includes the tool's function bodies; but `Function.prototype.toString()` of a type-stripped `.ts` function returns its text with every annotation replaced by spaces (verified), so string inclusion would make the emitted file unreadable.

## Decision

`src/generate/support-template.ts` holds `support.mts` as readable, hand-written plain JavaScript (about 560 lines) that imports only `node:*` modules. Equality with the tool is enforced by behavior: `emit-tests.unit` imports the emitted file and checks `toTagged`, `revive`, `outcomesEqual`, `taggedEqual`, `stateAfterOf` and `describeOutcome` against the tool's own on a fixed table; `generate.e2e` prints the same world probes from two children, one using `support.mts` and one using the recorder's `freeze.ts`.

## Consequences

- Generated tests run with `node --test` inside a `"type": "commonjs"` package with no dependency (GEN-05), in any order and with any `TZ` (GEN-01).
- Two copies of the serializer and comparator exist; the behavioral tests are what keeps them in agreement.
- `support.mts` replaces `process.exit` only while a captured call runs, because the test runner calls it for `--test-force-exit` (delta 55).

## Alternatives

- Import the tool's modules from the generated tests: ties the legacy repository to this one.
- String inclusion of the tool's function bodies: unreadable output under type stripping (verified).
- Publish a small runtime package: out of scope (nothing is published).
