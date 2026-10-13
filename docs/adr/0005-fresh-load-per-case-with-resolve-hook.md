# ADR 0005: a fresh module instance per case, with a query-propagating resolve hook

## Status

Accepted (2026-10-08, design D-06 and D-17). Verified on 2026-10-13.

## Context

Legacy modules keep state (counters, caches). A case must not see what the previous case did, or the recorded value depends on the order of cases and the generated tests fail when run alone. One child per case would cost a process start per case, twice per batch.

## Decision

One child per batch, a fresh module instance per case. CommonJS: purge the target's keys from `require.cache` and load with `createRequire`. ESM: `import()` the entry with a unique `?la=<n>` query, and register a `module.registerHooks` resolve hook that passes the same query on to every URL inside the target directory, so statically imported files are fresh too. The emitted `support.mts` registers the same hook, so generated tests get a fresh instance per test.

## Consequences

- REC-02 holds for CommonJS and ESM, including state in a statically imported file (`esm-two-files`: `1, 1, 1` with the hook, `1, 2, 3` without).
- The modern refactor (TypeScript ESM) and the legacy CommonJS fixture run the same tests (GEN-06).
- State kept outside the module (globals) is not reset; global writes are reported in the map and `SPEC.md`.
- `require(esm)` keeps state after a cache purge, which is why ESM always goes through `import()`.

## Alternatives

- One child per case: simplest isolation, about 80 ms per case and run.
- A cache purge for ESM too: does not reset `require(esm)` (verified).
- Re-importing the entry with a query but without the hook: static imports keep their state (verified).
