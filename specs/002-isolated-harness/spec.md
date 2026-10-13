# 002 · Isolated recording harness

Status: implemented (v1)

## Context

The recorder runs the real code to write every expected value. The target is staged (copied with an explicit `package.json`), then each batch of cases runs in one child process with `--permission` (read grants for the harness, the contracts and the staged copy only), an `--import` network guard, a frozen clock, a seeded random re-seeded per case, `TZ=UTC`, a scrubbed environment, a fresh module instance per case and a per-case watchdog.
The protocol travels on fd 3, one NDJSON line per case with a per-spawn nonce; stdout and stderr are stray output, counted and capped. Every batch runs twice and a case that differs is `unstable`.
Code: `src/harness/**`, `src/pipeline/record.ts`, `src/contracts/{tagged,outcomes,records}.ts`.

## Acceptance criteria

Copied verbatim from the design document, section 8.3.

- **REC-01** When a batch is recorded, the child shall see `Date.now()` equal to `world.clockNow`, `Math.random()` equal to the mulberry32 sequence of `world.seed` restarted at every case, `performance.now()` and `process.hrtime` advancing 1 ms per call, and `crypto.randomUUID()`, `crypto.randomBytes()`, `globalThis.crypto.randomUUID()` and `globalThis.crypto.getRandomValues()` deterministic, for a CommonJS target and for an ESM target using named imports, and two batches with the same job shall produce identical outcomes.
- **REC-02** When a case runs, the module shall be loaded fresh (module-level state reset) for CommonJS and for ESM targets, and when a case has several steps they shall run on the same instance in order.
- **REC-03** If a step exceeds `caseTimeoutMs` (callback or promise), or the parent's per-case watchdog of `steps × caseTimeoutMs + margin` fires (synchronous loop, self-kill, crash, exit without `done`) and fires again when the case is re-run once in a fresh child, then the system shall record `{ kind: "timeout", reason }` for that case, re-spawn the child from the next case, and continue; a batch with several such cases shall still complete, with at most one kill per case run, and a multi-step case whose steps each finish within `caseTimeoutMs` shall never be killed.
- **REC-04** When a callback-style function is invoked, the system shall record the callback arguments as `{ kind: "callback", args }`, and when it returns without calling the callback within the timeout, `{ kind: "no-callback" }`; when a function returns a thenable, `{ kind: "promise", status, value }`.
- **REC-05** The system shall serialize `NaN`, `Infinity`, `-Infinity`, `-0`, `undefined`, `bigint`, `Date`, `Error`, functions, circular references, oversize values and plain objects that have a `$t` key with tags such that `revive(toTagged(v))` equals `v` under `Object.is` semantics for the representable subset.
- **REC-06** When the two runs of a batch disagree on any step of a case, the system shall mark the case `unstable`, store both outcomes, exclude it from tests and from mutation kills, and list it in `SPEC.md`.
- **REC-07** The system shall write no measured duration into `records.json`; step and batch durations shall go to `timings.json`, and two recordings of the same job shall produce byte-identical `records.json`.
- **SAFE-01** When the target code reads a file outside the granted directories, the child shall record `threw` with `ERR_ACCESS_DENIED`.
- **SAFE-02** When the target code writes a file, spawns a process or starts a worker, the child shall record `threw` with `ERR_ACCESS_DENIED`.
- **SAFE-03** When the target code calls `fetch`, `http.request`, `dns.lookup` (through `require` or an ESM named import) or opens a socket to any host, including loopback, the child shall record `threw` with code `NO_NETWORK`.
- **SAFE-04** When the child writes more than 4 MiB to stdout, 64 KiB to stderr or a line over 1 MiB to fd 3, the parent shall kill it, record the current case as `timeout` with reason `output-cap`, and continue.
- **SAFE-05** The child's environment shall contain none of the parent's variables except the fixed set `TZ`, `LANG`, `LC_ALL`, `NODE_OPTIONS`, `PATH`, `LA_NONCE`, and `LLM_API_KEY` set in the parent shall not be visible in the child; `LA_NONCE` shall be absent from `process.env` by the time the first case runs.
- **SAFE-06** When the target path is given as a relative path or through a symlinked directory (such as `os.tmpdir()` on macOS), the CLI shall resolve it to its real path and proceed; if any entry inside the walked target tree is a symlink (`node_modules`, `.git` and other dot-directories are not walked), then the CLI shall refuse with `TARGET_SYMLINK` and exit 2.
- **SAFE-07** If the target's real path is outside `<project>/fixtures/` and `--i-trust-this-code` is absent, then the CLI shall print the threat summary (including the note that the read grant covers everything in the target directory) and exit 4 without spawning anything.
- **SAFE-08** When the target code writes to stdout, stderr or fd 3 directly, or kills its own process, the parent shall count the stray bytes, ignore any fd 3 line without the spawn nonce, record the current case as `timeout` with reason `child-exit` when the child died, re-spawn, and complete the batch.

## Non-goals

- Executing untrusted code safely: the Node permission model is a seat belt, not a sandbox (trusted code only; `--i-trust-this-code` outside `fixtures/`).
- Network isolation through `--permission`: Node 24.21 does not block `fetch` under `--permission`; the `--import` guard does.
- Stateful web apps, DOM, browsers and databases: `fs`, `net`, `http`, `dgram`, `dns` and `child_process` are blocked in the child, so such calls record `threw`.
- Targets that require npm packages or files above their folder: skipped with `EXTERNAL_DEPENDENCY` in v1 (M9).

## Decisions made during implementation

Numbered deltas refer to the plan (1 to 23) and to `docs/api-notes.md` (24 on).

- Plan delta 8: fd 3 lines without the spawn nonce are discarded and counted as `forgedLines`; `CHILD_PROTOCOL` is reserved for a nonce-correct line that fails the protocol schema (delta 36: the case becomes `timeout` (`child-exit`), and the same case doing it twice is exit 2).
- Plan delta 10: error messages are normalized: the staged or mutant real path and its `file://` URL become `<target>`, and `?la=<n>` is removed.
- Plan delta 11: an `uncaughtException` or `unhandledRejection` while a case is active replaces its last step outcome with `timeout` (`leaked-error`).
- Plan delta 15: the guard functions throw synchronously, so a target records `threw` with code `NO_NETWORK`.
- Plan delta 20: the job carries `callbackIndex` per case; a load failure arrives as `loadError` on the first case line and becomes a `CHILD_LOAD` entry in `records.json.loadErrors`.
- Delta 31: a CommonJS module is returned as a live `Proxy` over `module.exports` (with `default` pointing at it), so steps that change exported values are seen by later steps and by `stateAfter`.
- Deltas 32 to 35: the child keeps the real `performance.now` and timer functions for its own waits; `job.ts` and `timers.ts` hold the child's job types and timer tracking (rule 3 forbids importing `protocol.ts`); the watchdog is armed when the child's `hello` arrives; the flush after the last step is a real 0 ms timeout plus one `setImmediate`, then the child waits for stdout and stderr to drain.
- Deltas 37 to 41: when the parent gives up on a case every step gets the timeout outcome; `recordCases` returns `loadError`; the `EXTERNAL_DEPENDENCY` message lists the specifiers in sorted order; `records.json.limits` is `DEFAULT_CASE_LIMITS`; the staged `package.json` replaces the target's own, and `targetSha` is computed from the original bytes.
- Step 0 (2026-10-13): repeated `--allow-fs-read=<dir>` arguments with spaces work as single argv elements; `--permission` cannot be combined with `--test`; `mock.timers` freezes `Date` while real `setTimeout` keeps firing; `node:crypto.getRandomValues` is an accessor, replaced with `Object.defineProperty`; `syncBuiltinESMExports` makes an ESM named import of `node:dns` see the guard.
- Measured: every isolation outcome of the threat model (`docs/threat-model.md`, "Measured isolation behavior") was observed with the real spawn; no isolation gap was found. The demo records 240 (`none`), 96 (fake) and 111 (`bytes`) cases, all stable, with 0 timeouts.

- Deltas 100 and 101 (final review): dot-files next to the target are not walked, so a `.env` is neither staged nor readable by the child, and the summary says so after "covers everything in the target directory"; `verify --tests-dir` outside `fixtures/` and `artifacts/` needs `--i-trust-this-code` too.

## Test files

| Criterion | Test files |
|---|---|
| REC-01 | `tests/e2e/record.e2e.test.ts` |
| REC-02 | `tests/e2e/record.e2e.test.ts` |
| REC-03 | `tests/e2e/record.e2e.test.ts` |
| REC-04 | `tests/e2e/record.e2e.test.ts` |
| REC-05 | `tests/e2e/record.e2e.test.ts`, `tests/unit/outcomes.unit.test.ts`, `tests/unit/tagged.unit.test.ts` |
| REC-06 | `tests/e2e/record.e2e.test.ts` |
| REC-07 | `tests/e2e/record.e2e.test.ts` |
| SAFE-01 | `tests/e2e/harness-isolation.e2e.test.ts` |
| SAFE-02 | `tests/e2e/harness-isolation.e2e.test.ts` |
| SAFE-03 | `tests/e2e/guard.e2e.test.ts`, `tests/e2e/harness-isolation.e2e.test.ts`, `tests/unit/no-network.unit.test.ts` |
| SAFE-04 | `tests/e2e/harness-isolation.e2e.test.ts` |
| SAFE-05 | `tests/e2e/harness-isolation.e2e.test.ts` |
| SAFE-06 | `tests/e2e/cli.e2e.test.ts`, `tests/e2e/harness-isolation.e2e.test.ts`, `tests/unit/paths.unit.test.ts` |
| SAFE-07 | `tests/e2e/cli.e2e.test.ts` |
| SAFE-08 | `tests/e2e/harness-isolation.e2e.test.ts`, `tests/e2e/record.e2e.test.ts`, `tests/unit/protocol.unit.test.ts` |
