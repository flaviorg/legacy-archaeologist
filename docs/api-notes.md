# API notes (Step 0)

Every library and runtime API this project relies on is checked against the installed version before the code that uses it is written. Each row below was re-run inside this project with exactly the pinned versions.

Environment: Node 24.21.0, npm 11.19.0, macOS. Installed with `npm install --save-exact`: `acorn` 8.19.0, `acorn-walk` 8.3.5, `zod` 4.6.5, `typescript` 7.0.2, `@types/node` 24.19.1 (`npm ls --depth=0` shows exactly these five).

## M0 verification (2026-10-13)

How checked: a typed probe script (`scripts/api-probe.ts` plus `scripts/api-probe-child.ts`, deleted after this file was written) run with `npx tsc --noEmit -p tsconfig.json && node scripts/api-probe.ts`. Child programs were written into a temporary folder under `os.tmpdir()` (resolved with `realpathSync`) inside a subfolder named `probe dir`, so every child path contained a space.

| Item | How checked | Result | Date |
|---|---|---|---|
| `acorn` 8.19.0 value exports and `parse` options | `Object.keys(acorn)`; `parse` with `{ ecmaVersion: "latest", sourceType: "script", locations: true, ranges: true, onComment }` on a 6-line script; `walk.full` over every node | The 22 value exports of the plan's table; every node has `start`, `end`, `range` and `loc`; `onComment` collected `{ type: "Line" }` and `{ type: "Block" }` with `value`. `Token` has no `value` field in the types | 2026-10-13 |
| `acorn` tokenizer over the whole source | `for (const t of acorn.tokenizer(src, opts))`, operator tokens printed as `start-end:text:label` using `src.slice` | `58-59:+:+/-`, `63-64:>:</>/<=/>=`, `77-78:/:/`, `95-96:%:%` on the probe source (the offsets belong to the probe source, which differs from the plan's); labels grouped as in the table | 2026-10-13 |
| Gap tokenizer vs whole source | `acorn.tokenizer` on the text between `left.end` and `right.start` of a `/` expression | Throws `Unterminated regular expression`, so the mutator tokenizes the whole source once | 2026-10-13 |
| `acorn-walk` 8.3.5 | `Object.keys(walk)`; `walk.simple` with a typed `BinaryExpression` visitor; `walk.ancestor` | 11 exports as in the table; `operator`, `left.end`, `right.start` typed; ancestor chain `Program, FunctionDeclaration, BlockStatement, IfStatement, ReturnStatement, BinaryExpression` (last element is the node itself) | 2026-10-13 |
| `with`, shebang | `parse("with (a) { b }")` as script and as module; `parse("#!/usr/bin/env node\n...")` | Script parses; module throws `'with' in strict mode (1:0)` with `loc`; a leading shebang parses | 2026-10-13 |
| `zod` 4.6.5 tagged schema of spec 5.2 | The schema built verbatim; `safeParse` of the bogus inputs and the valid tags; `z.prettifyError` on an ISO failure; `typeof z.toJSONSchema` | Rejects `{ $t: "bogus" }`, `{ $t: "bigint", v: "1.5" }`, `{ $t: "NaN", extra: 1 }`, `{ $t: "Date", v: "garbage" }`, `{ $t: "function", name: "x" }` and a 50,000-key object; accepts every input tag, `"Invalid Date"`, nested objects and `{ $t: "object", v: { $t: "NaN" } }`; first line of the prettified error is `✖ Invalid ISO datetime` | 2026-10-13 |
| `node:module` | `typeof registerHooks`, `typeof syncBuiltinESMExports`; a child importing `main.mjs?la=n` three times, `main.mjs` statically importing `state.mjs` | Both functions exist; without a resolve hook `1, 2, 3`, with a `registerHooks` resolve hook that appends the current query to URLs inside the target `1, 1, 1` | 2026-10-13 |
| `syncBuiltinESMExports` and the ESM `node:dns` binding | A child that statically imports `node:dns` first, patches `dns.lookup` on the CommonJS object, and compares the ESM binding before and after the call | Before: the ESM `lookup` is still the original; after: it is the patch. (When the ESM namespace is first created after the patch, it already sees the patch; the probe imports it first to observe the difference) | 2026-10-13 |
| `node:test` `mock.timers` in a plain script | `enable({ apis: ["Date"], now: 1700000000000 })`, `tick(5000)`, `setTime`, a real `setTimeout`, `performance.now()` | `1700000000000`, `2023-11-14T22:13:20.000Z`, `1700000005000`, back to `1700000000000`; real `setTimeout` fires; `performance.now()` keeps advancing | 2026-10-13 |
| `node:util.parseArgs` | `parseArgs({ args: ["--json"], options: {}, strict: true })` | Throws `code: "ERR_PARSE_ARGS_UNKNOWN_OPTION"`, message starting `Unknown option '--json'` | 2026-10-13 |
| TAP reporter (direct run, `--permission --test-reporter=tap`) | A `.mts` test file with a `#` in its names and four failures | `ok 1 - [x\#c01] partition: ok one` (`#` escaped as `\#`); `assert.fail(msg)` with a single-line message gives `error: '<msg>'`; summary `# tests 5`, `# pass 1`, `# fail 4`; exit 1. **Differences from delta 9:** the reporter quotes the message like `util.inspect`, not like YAML: single quotes by default, `"it's x"` (double quotes) when the message contains `'`, backticks when it contains both `'` and `"`, and a backslash is written as `\\` (also in test names). `assert.equal(a, b, msg)` with a custom message produces a multi-line `error: \|-` block (the message, a blank line, then `90 !== 100`), so a one-line failure message needs `assert.fail(msg)` or `new AssertionError({ message })`. Task 27's TAP parser must handle the three quote styles and the `\\` escape | 2026-10-13 |
| `--permission --test` | `node --permission --allow-fs-read=<tests> --test <file>` with a relative and with an absolute file path | Relative path: fails with `Access to this API has been restricted` at `ChildProcess.spawn`, exit 1. Absolute path: fails earlier with `Could not find '<path>'`, exit 1. Either way `--permission` cannot be combined with `--test`, as the spec says | 2026-10-13 |
| `--permission` with three grants plus an `--import` guard | A child with three `--allow-fs-read=<dir>` (each one argv element, paths with a space) and `--import <file:// URL>` of a guard that replaces `fetch` | Read outside the grants, write, `execSync` and `new Worker` → `ERR_ACCESS_DENIED`; `fetch` → `NO_NETWORK` from the guard; without the guard `fetch` is not blocked | 2026-10-13 |
| Runtime `TZ` | A test file run directly under `--permission` with `TZ=Asia/Kolkata` in the environment and `process.env.TZ = "UTC"` at its top | `new Date(1700000000000).getDate()` is `14` | 2026-10-13 |
| `--test-force-exit` | A test file that leaves a `setInterval` running, with and without the flag, parent timeout 5 s with SIGKILL | With the flag: `# pass 1`, exit 0. Without it: `ok 1` printed, then SIGKILL | 2026-10-13 |
| `spawnSync` kill | `node -e "while(true){}"` with `timeout: 500, killSignal: "SIGKILL"` | `signal: "SIGKILL"`, `error.code: "ETIMEDOUT"` | 2026-10-13 |
| `assert.deepEqual` key order | `node:assert/strict` `deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })` | Passes, so key order needs `taggedEqual` | 2026-10-13 |
| `typescript` 7.0.2 | `npx tsc --noEmit -p tsconfig.json` on the probe, which imports `acorn`, `acorn-walk`, `zod`, `node:module`, `node:test` | Exit 0 with the Task 0 `tsconfig.json` | 2026-10-13 |
| `Function.prototype.toString` under type stripping | `toString()` of a typed function in the probe | `function taggedEqual(a         , b         )          { return a === b; }` (annotations replaced by spaces), hence delta 7 | 2026-10-13 |
| mulberry32 | Constants `0x6D2B79F5`, `Math.imul`, shifts 15, 7, 14, `>>> 0` / 4294967296, seed 42 | `0.6011037519201636`, `0.44829055899754167`, `0.8524657934904099` | 2026-10-13 |
| Fixture arithmetic | `Math.floor(n * 100 + 0.5) / 100` and the away-from-zero variant | `-0.125` → `-0.12` legacy, `-0.13` away from zero; `Math.ceil(-3 / 7)` is `-0`; `Math.ceil(-10 / 7) * 0.015 * 300` = `-4.5`; VIP at 100.00 with tax 0.0725: `107.25` legacy, `96.53` broken | 2026-10-13 |
| Node `--test` globs | Not re-run in the probe; covered by `npm test` from Task 1 on (the `tests/e2e/**` glob matches nothing until Task 1's e2e file exists) | See the progress log of chunk 1 | 2026-10-13 |
| Git in this shell | `git init -b main` | The interactive shell wraps `git` in a function (`__scmb_git`) that fails with `permission denied`; `command git` (that is, `/usr/bin/git`) works. `git rev-parse --show-toplevel` prints the project folder | 2026-10-13 |

## M1 verification (2026-10-13)

The acorn and acorn-walk rows of the M0 table were re-run the same day with the same installed versions, so they stand for M1. Facts found while writing `src/static` (each covered by a unit test):

| Item | How checked | Result | Date |
|---|---|---|---|
| A CommonJS file parsed as `module` | `parse(billing.js, { sourceType: "module" })` | Succeeds: ES5 CommonJS without strict-mode violations is valid module syntax. `parseSource` therefore reports `module` only when the program has an import or export declaration (or the script parse fails); otherwise it re-parses as `script` (see the spec deltas below) | 2026-10-13 |
| `acorn-walk` visitor names in the types | `walk.simple(node, { VariablePattern() {} })` under `tsc` | `VariablePattern` and `MemberPattern` are not in `SimpleVisitors` (TS2353); declaration and assignment-target identifiers do not reach the `Identifier` visitor. Assignment targets are read from `AssignmentExpression.left` / `UpdateExpression.argument` instead | 2026-10-13 |
| Skipping nested functions | `walk.simple(fn.body, visitors, { ...walk.base, Function: () => {} })` | Nested function bodies are not visited (complexity of an outer function ignores inner ones) | 2026-10-13 |
| `ancestor` with the aggregate `Function` visitor | `walk.ancestor(program, { Function(node, _s, ancestors) {} })` | Fires once per function node; `ancestors` ends with the node itself | 2026-10-13 |
| Columns | acorn `loc.start.column` | 0-based UTF-16 code units; the map reports `column + 1` (1-based, like lines) | 2026-10-13 |
| `import.meta.main` | `src/cli.ts` run as `node src/cli.ts` and imported by tests | `true` when run directly (typed in `@types/node` 24.19.1 `module.d.ts`) | 2026-10-13 |
| `TextEncoder` in `src/static` | `new TextEncoder().encode(text).length` | Global (no `node:` import needed), so `files[].bytes` and `sourceBytes` are UTF-8 lengths without breaking dependency rule 2 | 2026-10-13 |

## Fixture behavior, re-derived from billing.js (2026-10-13)

How checked: `TZ=UTC node -e` requiring `fixtures/legacy-billing/billing.js` (152 lines), with a `require.cache` purge before each stateful row. Dates below are UTC. The year in invoice numbers is the real current year here (2026); inside the recorder's child it is the frozen clock's year (2023).

| Call | Observed | Spec 5.10 |
|---|---|---|
| `roundMoney(-0.125)` | `-0.12` | holds (half toward +Infinity) |
| `roundMoney(-2.675)` | `-2.67` | holds |
| `roundMoney(1.005)` / `roundMoney(-1.005)` | `1` / `-1` | holds (float artifact) |
| `applyDiscount(100, "VIP")` | `100` | holds (VIP only when `subtotal > 100`) |
| `applyDiscount(100.01, "VIP")` | `90.009` | recorded as is |
| `applyDiscount(150, "VIP")` | `135` | holds |
| `applyDiscount(80, "STAFF")` | `60` | holds |
| `applyDiscount(50, "NOPE")` | `50` | holds |
| `applyDiscount(10, null)` | throws `TypeError: Cannot read properties of null (reading 'toString')` | holds |
| `lateFee(2023-11-24, 2023-11-14, 300)` (10 days early) | `-4.5` | holds |
| `lateFee(2023-11-24, 2023-11-21, 300)` (3 days early) | `-0` | holds |
| `lateFee(2023-11-24, 2023-12-24, 300)` (30 days late, capped at 3 weeks) | `13.5` | consistent with the cap |
| `formatMoney(-0)` / `formatMoney(-0.4)` | `"0.00"` / `"-0.00"` | holds |
| `formatMoney(123456789)` | `"1,234,567.89"` | thousands separator |
| `prorate(3000, 2023-01-31, 2023-02-15)` | `194` (the 31st counts as the 30th: 2 of 31 days) | holds |
| `prorate(3000, 2023-11-10, 2023-11-19)` | `1000` (10 of 30 days) | holds |
| `nextInvoiceNumber()` three times on one instance | `INV-<year>-1001`, `INV-<year>-1002`, `INV-<year>-1003` | holds |
| `calculateInvoice({ name: "Ann", code: "VIP", state: "CA" }, [{ qty: 4, unitPrice: 25 }], cb)` | `cb(null, { number, customer: "Ann", subtotal: 100, discount: 0, tax: 7.25, total: 107.25, ref: "R<digits>" })`; `global.LAST_INVOICE` set | holds (total `107.25`) |
| `calculateInvoice({ code: null, state: "CA" }, [], cb)` | `cb(Error("no lines"))`, one argument | holds |

## Spec deltas (from the plan)

The deltas of this file (1 to 23 from the plan, 24 on found during implementation) are summarized per feature in `specs/00*/spec.md`, section "Decisions made during implementation"; this file keeps the full text and the Step 0 tables.

1. Repository process files (`AGENTS.md`, `specs/`, `.env.example`, `LICENSE`, `check-secrets`, hook, CI, `docs/` except this file, the full README) move to M8; guardrail tests stay in M0.
2. M9 is not in this plan; it gets its own plan after v1 is validated.
3. `stableStringify` sorts envelope keys but never reorders values under `args`, `value` and `stateAfter` (`OPAQUE_KEYS`).
4. `PlannedCase.origin` gains `"baseline"`; baseline labels carry no `baseline:` prefix.
5. acorn types: `Token` has no `value`; the mutator picks the token in `[left.end, right.start)` whose source text equals the operator; ranges from `node.start`/`node.end`.
6. `buildMap(files, moduleKind, meta)` takes `targetDir`, `targetSha`, `builtinModules` and `fileSha256` from the map stage.
7. `support.mts` is a readable hand-written template; D-08 ("same bodies") is enforced behaviorally.
8. fd 3 lines without the spawn nonce are discarded and counted as `forgedLines`; `CHILD_PROTOCOL` is reserved for nonce-correct lines that fail the schema.
9. TAP facts: `#` escaped as `\#`; failure message quoting (see the TAP row above: `util.inspect`-style quotes, not YAML `''`); `verify` checks the module in `--against` itself before spawning.
10. Error-message normalization replaces the staged or mutant real path and its `file://` URL with `<target>` and strips `?la=<n>`.
11. A leaked async error while a case is active replaces its last step outcome with `timeout` (`leaked-error`).
12. Fake fixtures carry `targetDir`; `--scenario` looks in `fixtures/llm/` then `tests/fixtures/llm/`; the lying fixture is derived by `scripts/make-lying-fixture.ts`.
13. `FIXTURE_UNCONSUMED` (exit 2) is added to the error table.
14. The trace line gains `repairRaw`; `callLlm` strips one surrounding Markdown code fence before `JSON.parse`.
15. Network guard functions throw synchronously, so a target records `threw` with code `NO_NETWORK`.
16. `support.mts` also exports `captureAsync(fn, timeoutMs)`.
17. Boundary expansions apply only to single-step round-0 cases; non-integer expansions are rounded to 9 decimals.
18. `listMutants` returns `{ mutants, invalid, truncated }`; `mutationScore` is `0` when `valid` is 0.
19. Rule evaluation finds a probe's case by canonical steps (`stableStringify`).
20. The job carries `callbackIndex` per case; a load failure is reported as `loadError` on the first case line (`CHILD_LOAD`).
21. The demo test runs `scripts/demo.ts` with its default output prefix; the lying run writes `artifacts/test-demo-lying/`.
22. 40 tasks after Task 0 instead of the spec's 36 (process milestone, M2 split).
23. Rule 6 allowlist: `src/harness/child/main.ts` (reads and deletes `LA_NONCE`) and `src/generate/support-template.ts` (emitted text) may mention `process.env`.

### Implementation deltas found in M1 (2026-10-13)

24. `parseSource` tries `module` first, but a module parse with no import or export declaration is re-parsed as `script` and reported `script` when that succeeds (otherwise every CommonJS file would be `module`, and the plan's billing test expects `script`).
25. `buildMap` meta also carries `tool` (`src/static` may not import `src/infra/version.ts`).
26. `StaticMap.stats` gains `unresolvedIdentifiers` (spec 4.2 names it; the 5.1 type omitted it).
27. `ScopeInfo.moduleBindings` entries carry `functionValued` so `readsModuleState`/`moduleState` skip module-level functions.
28. Magic-number columns are 1-based; the plan's RF-4 example said column 25 for `function f(x){ return x * 37 }`, but `37` sits at 0-based column 26, 1-based 27.
29. The conventions rule 6 scan ignores the quoted side-effect kind name `"process.env"` (a string in `contracts/map.ts` and `static/side-effects.ts`), with a test for the scan itself.
30. The map stage refuses a symlink inside the walked target with `TARGET_SYMLINK` (as the stage will), `--only` accepts a function ID or a bare function name and is `USAGE` for an unknown one, and `--out` inside, equal to or containing the target is `USAGE` from this milestone on.

## Measured isolation behavior (M2, 2026-10-13)

How checked: each target under `tests/fixtures/targets/` staged into a temporary folder and run through `runBatch` (the real spawn of spec 5.4: `--permission`, three `--allow-fs-read`, `--import` of the network guard, the fixed environment), one case per function, `caseTimeoutMs` 300 and watchdog margin 200. The tests in `tests/e2e/harness-isolation.e2e.test.ts` and `tests/e2e/record.e2e.test.ts` assert these outcomes; no isolation gap was found, so nothing in `run-batch.ts`, `freeze.ts` or `net-guard.ts` had to change for Task 16. Task 38 builds `docs/threat-model.md` from this table.

| Target and function | What the target does | Recorded outcome | Error code |
|---|---|---|---|
| `reads-outside.readHosts` | `fs.readFileSync("/etc/hosts")` | `threw` Error "Access to this API has been restricted. Use --allow-fs-read to manage permissions." | `ERR_ACCESS_DENIED` |
| `reads-outside.readOwnData` | reads `data.json` next to itself | `returned` `{ rate: 0.0725 }` | none (inside the grant) |
| `fs-writer.write` | `fs.writeFileSync(__dirname + "/out.txt")` | `threw` "... Use --allow-fs-write ..." | `ERR_ACCESS_DENIED` |
| `spawner.exec` | `child_process.execSync("echo hi")` | `threw` "... Use --allow-child-process ..." | `ERR_ACCESS_DENIED` |
| `spawner.worker` | `new Worker("1 + 1", { eval: true })` | `threw` "... Use --allow-worker ..." | `ERR_ACCESS_DENIED` |
| `net-caller.doFetch` | `fetch("https://example.com/")` | `threw` synchronously, "NO_NETWORK: network access is disabled (https://example.com/)" | `NO_NETWORK` |
| `net-caller.httpRequest` | `http.request("http://example.com/")` | `threw` "NO_NETWORK: ... (http://example.com/)" | `NO_NETWORK` |
| `net-caller.dnsLookup` | `dns.lookup("example.com", cb)` | `threw` "NO_NETWORK: ... (dns lookup example.com)" | `NO_NETWORK` |
| `net-caller.loopbackSocket` | `net.connect(9, "127.0.0.1")` | `threw` "NO_NETWORK: ... (127.0.0.1:9)"; loopback is blocked in the child | `NO_NETWORK` |
| `net-caller-esm.look` | ESM `import { lookup } from "node:dns"` | `threw` "NO_NETWORK: ... (dns lookup example.com)" (the guard's `syncBuiltinESMExports` reaches the named binding) | `NO_NETWORK` |
| `exit-caller.exit3` | `process.exit(3)` | `threw` `{ name: "ProcessExitCalled", message: "process.exit(3) called" }`; same child continues | none |
| `self-killer.killSelf` | `process.kill(process.pid, "SIGKILL")` | `timeout` `child-exit`; next case runs in a fresh child | none |
| `infinite-loop.spin` | `while (true) {}` | `timeout` `watchdog` after the case is re-run once alone | none |
| `output-bomb.bigStdout` | 8 MiB through `process.stdout.write` | `timeout` `output-cap` (killed once the parent counted more than 4 MiB) | none |
| `output-bomb.bigStderr` | 2 MiB through `process.stderr.write` | `timeout` `output-cap` (more than 64 KiB) | none |
| `output-bomb.bigFd3` | 2 MiB without a newline through `fs.writeSync(3, ...)` | `timeout` `output-cap` (line over 1 MiB) | none |
| `fd3-forger.forge` | writes a protocol line with nonce `"0" × 32` to fd 3, then returns 7 | `returned` 7; `forgedLines` 1 | none |
| `env-reader.keys` | `Object.keys(process.env)` | `TZ, LANG, LC_ALL, NODE_OPTIONS, PATH` plus macOS's `__CF_USER_TEXT_ENCODING`; no `LA_NONCE`, no `LLM_API_KEY` | none |

## M2 verification (2026-10-13)

Facts found while writing `src/harness` (each covered by an e2e test in `tests/e2e/record.e2e.test.ts` or `tests/e2e/harness-isolation.e2e.test.ts`):

| Item | How checked | Result | Date |
|---|---|---|---|
| `node:crypto.getRandomValues` | Assignment inside the child | It is an accessor: plain assignment throws `Cannot set property getRandomValues of #<Object> which has only a getter`; `Object.defineProperty` replaces it | 2026-10-13 |
| Main program under `--permission` | `src/harness/child/main.ts` run with the three read grants and no `package.json` in the granted folders | Runs as ESM (syntax detection); the project `package.json` outside the grant is not needed; no warning on stderr | 2026-10-13 |
| `mock.timers` in the child | `mock.timers.enable({ apis: ["Date"], now })` plus `setTime` per case | `Date.now()` and `new Date()` frozen; real `setTimeout` keeps working for the harness's own waits | 2026-10-13 |
| Ordering of 0 ms timers | A target's `setTimeout(fn, 0)` scheduled during a step, then the harness's flush | A harness `setTimeout(…, 0)` created after the step fires after the target's; a single `setImmediate` does not guarantee that, so the flush is a 0 ms timeout followed by one `setImmediate` | 2026-10-13 |
| `process.stdout.write` of 8 MiB from the child (macOS pipe) | `output-bomb` | The write is asynchronous; the child waits for `stdout`/`stderr` to drain before writing the case line, so the parent counts past the cap and kills the child before the case is reported | 2026-10-13 |
| `fs.writeSync(3, …)` of 2 MiB without a newline | `output-bomb.bigFd3` | Blocks in the child until the parent reads; the parent kills it once the line passes 1 MiB | 2026-10-13 |
| `process.kill(process.pid, "SIGKILL")` under `--permission` | `self-killer` | Allowed; the child dies without `done` and the parent records `child-exit` | 2026-10-13 |

### Implementation deltas found in M2 (2026-10-13)

31. `loadModule` (CommonJS) returns a live `Proxy` over `module.exports` whose `default` is `module.exports` itself (unless the module has its own `default` key), not the copy `{ ...exports, default: exports }`: steps that change exported values are seen by later steps and by `stateAfter`.
32. `installWorld` also returns `realNow` (the real `performance.now`, captured before it is replaced); `runCase`'s context gains `now` and `timers` (the real timer functions), because the child replaces `performance.now` and wraps the global timers.
33. New child files: `src/harness/child/job.ts` (structural job types; rule 3 forbids importing `protocol.ts` or `records.ts`) and `src/harness/child/timers.ts` (wraps `setTimeout`, `setInterval`, `setImmediate` on `globalThis` and `node:timers` once; handles created while a case is active are cleared when it ends; the window starts before the module is loaded, so load-time timers belong to the case).
34. The per-case watchdog is armed when the child's `hello` arrives, not when the job is written: spawn time is covered by `spawnTimeoutMs`, so a slow spawn on a loaded machine does not eat the first case's budget. The child writes `hello` before reading the job. The `hello` version is the protocol version `"1"` (the child cannot import `src/infra/version.ts`).
35. The flush after the last step is a real 0 ms timeout followed by one `setImmediate` (see the table); the child then waits for `stdout` and `stderr` to drain before writing the case line.
36. A nonce-correct fd 3 line that fails the schema, or a case line for an unexpected case, marks the case `timeout` (`child-exit`) and the case is re-run once alone; a second violation for the same case throws `CHILD_PROTOCOL`.
37. When the parent gives up on a case (watchdog, child exit, output cap), every step of the case gets the timeout outcome (the child reports a case only when it ends), `stateAfter` is `null`, `consoleLines` 0 and each step's duration is the elapsed time divided by the step count.
38. `recordCases` also returns `loadError` (the record stage turns it into `CHILD_LOAD`). Instability at step 0 stores the two `stateAfter` values as `{ kind: "returned", value }` outcomes, so `instability` keeps one `Outcome` type.
39. The `EXTERNAL_DEPENDENCY` message lists the map's `externalSpecifiers` in the map's (sorted) order: `requires ../shared.js, leftpad; modules with npm or out-of-folder dependencies are not loaded in v1`.
40. `records.json.limits` is `DEFAULT_CASE_LIMITS` (`runRecordStage` has no limits parameter yet; Task 23 can pass the planner's limits).
41. The stage's symlink message is `TARGET_SYMLINK: <relPath> is a symbolic link` (the map stage keeps its own wording). The staged `package.json` replaces a target's own `package.json` (only `type` matters for loading by absolute path); `targetSha` is computed from the original bytes.
42. `.gitignore` re-includes `tests/fixtures/targets/requires-dep/node_modules/` so the vendored stand-in for `leftpad` is versioned.

## M3 verification (2026-10-13)

Facts found while writing `src/contracts/hypotheses.ts`, `src/llm` and `run` (each covered by a test in `tests/unit/{prompts,call-llm,fake-provider,openai-compatible}.unit.test.ts`, `tests/e2e/hypothesize.e2e.test.ts` or `tests/e2e/cli.e2e.test.ts`):

| Item | How checked | Result | Date |
|---|---|---|---|
| Spec 5.2 tagged input schema in zod 4.6.5 | `hypothesisOutputSchema.safeParse` on the plan's table | Rejects `{ $t: "bogus" }`, `{ $t: "bigint", v: "1.5" }`, `{ $t: "NaN", extra: 1 }`, `{ $t: "Date", v: "garbage" }`, `{ $t: "function", name: "x" }`, `{ $t: "circular" }`, a 1,001-character string and a 101-key object; accepts every input tag, `{ $t: "Date", v: "Invalid Date" }` and `{ $t: "object", v: { $t: "NaN" } }`. The annotated `z.ZodType<Tagged>` lazy union type-checks under TypeScript 7.0.2 | 2026-10-13 |
| `z.prettifyError` for the repair message | `{"rules": "nope"}` against `hypothesisOutputSchema` | Multi-line text naming the path (`→ at rules`); `issues[].path` gives the one-line form used in the trace and in the `LLM_OUTPUT_INVALID` message | 2026-10-13 |
| `Request` built from `fetch(url, init)` in a test | `new Request(input, init)` inside the injected `fetch` | `url`, `method`, `headers.get("authorization")` and `json()` readable; nothing touches the network (the guard only patches `fetch`) | 2026-10-13 |
| `AbortSignal.timeout` rejection | Injected `fetch` throwing `new DOMException(..., "TimeoutError")` | Recognized by `name` (`TimeoutError` or `AbortError`), retried once, then `LLM_UNAVAILABLE: openai-compatible: timed out after <ms> ms` | 2026-10-13 |
| Closed loopback port through the CLI | `LLM_BASE_URL=http://127.0.0.1:9/v1`, `LLM_TIMEOUT_MS=1000`, test guard (loopback allowed) | `fetch failed` twice, exit 2 `LLM_UNAVAILABLE`, the key in neither stream | 2026-10-13 |
| Fixture predictions | `billing.js` run under `TZ=UTC` with a frozen `Date` (1700000000000) and the first mulberry32 draw (0.6011037519201636) | Every non-`unknown` prediction in `fixtures/llm/legacy-billing.json` except the three suspicious ones (`roundMoney(-0.125)` → `-0.12`, `applyDiscount(100, "VIP")` → `100`, ten days early `lateFee` → `-4.5`) equals the code's value; `prorate(3000, 2023-11-01)` with no end date is `1400` (14 days counted), `calculateInvoice` for the Oregon customer calls back `{ number: "INV-2023-1001", customer: "Bo", subtotal: 20, discount: 0, tax: 0, total: 20, ref: "R601103" }` | 2026-10-13 |
| `run` on the fixture | `npm run la -- run --target fixtures/legacy-billing` (fake, by default) and `--provider none`, outputs in the session scratchpad | Fake: `run: 7 functions · 85 cases (85 stable) · provider fake (legacy-billing)`, 0 rejected; none: `run: 7 functions · 240 cases (240 stable) · provider none` (`prorate`, `lateFee`, `applyDiscount`, `calculateInvoice` reach the 40-case cap) | 2026-10-13 |

### Implementation deltas found in M3 (2026-10-13)

43. Boundary-expansion labels keep the plan's ` · ` separator (U+00B7, `<source label> · arg <i> -1`) although `PlannedCase.label` is otherwise sanitized to `[\x20-\x7E]`: the sanitization applies to the proposal's label, and the source part is cut so the whole label stays within 120 characters.
44. `runMapStage` also returns `allFunctionIds` (every exported function before `--only`), so the fake's `FIXTURE_TARGET_DRIFT` check sees the whole target when `--only` restricts the map.
45. The trace writer also has `entries()` (the stage reads each call's usage for `hypotheses.json`); `seq` is 1-based; `systemSha256` is `sha256:<hex>` like `targetSha`; `text()` ends with a newline when it has entries.
46. `callLlm`: a provider error on the first call writes no trace entry (there is no raw text); a provider error on the repair call writes an `invalid` entry and then propagates. Provider errors are logged as `llm_call` with `outcome: "error"` and the error code at `warn`. The `LLM_OUTPUT_INVALID` message carries the repair's first issue (the first answer's when the repair call was unscripted). The trace `issues` are the first answer's issues, followed by the repair's prefixed with `repair: `.
47. Planner choices: `ARITY` also covers a proposal with no step or more than 5 steps; `DEPTH` counts containers (an array or plain object is one level, a tag zero, the `object` escape one); a duplicate of an `existing` case is rejected but its `ruleRefs` are not merged into that case (the planner does not mutate its input; survivor proposals carry no rule); expansions that duplicate a case are skipped silently and do not count toward the 4-per-case and 12-per-function caps; expansions stop silently at the 40-case cap (code-made, so no `CAP_CASES` rejection). `canonicalSteps` is exported for rule evaluation (delta 19).
48. `hypothesize.v1` user message: `Parameters:` lists the non-callback parameters (the callback is named in the suffix), `none` when empty; the source fence is one backtick longer than the longest backtick run in the source; a truncated source adds the line `The source below was truncated to 8,192 bytes.`
49. Fake fixture loading: invalid JSON is `FIXTURE_NOT_FOUND` (`invalid fixture: ...`); the schema also requires unique turn ids and a `sha256:<64 hex>` target sha; a turn whose prompt version is unknown is `FIXTURE_NOT_FOUND`; a missing `promptHashes` entry for a prompt that a turn uses is `FIXTURE_PROMPT_DRIFT`; `known:` in the unscripted message lists every turn id.
50. OpenAI-compatible client: a 200 response without `choices[0].message.content` or with a non-JSON body is `LLM_UNAVAILABLE` without retry; an abort from the caller's signal is not retried; the error body is redacted before it is cut to 200 characters; a 401/403 message never includes the body.
51. CLI `run`: option values are validated before the target is touched (`--seed` 0 to 4,294,967,295, `--clock` 0 to 8.64e15, `--case-timeout-ms` 100 to 30,000, `--max-mutants` 1 to 2,000, `--max-rounds` 0 to 3, `--survivors-per-round` 1 to 50, `--inputs-per-survivor` 1 to 5, `--operators` from `AOR,ROR,LOR,NEG,NUM,BLOCK`, `--scenario` letters, digits, `.`, `_`, `-`); `map` refuses the run-only options with `USAGE`; the summary's provider label is `none`, `fake (<scenario>)` or `openai-compatible (<model>)`, and the artifacts path is shown relative to the working directory when inside it. `run` deletes the five artifacts it writes (`map.json`, `hypotheses.json`, `llm-trace.jsonl`, `records.json`, `timings.json`) before starting, so a failed re-run never leaves a stale `records.json`; the trace is still written when hypothesize fails (LLM-04 keeps both raw texts).
52. `scripts/rehash-fixtures.ts` also prints one line per changed prompt hash (`rehash: <file> promptHashes <version> updated`) and skips a file without `targetDir` with exit code 1.

## M4 verification (2026-10-13)

| Item | How checked | Result | Date |
|---|---|---|---|
| TAP failure message quoting (node 24.21, `--test-reporter=tap`) | A test file with `assert.ok(false, msg)` for messages with `"`, `'`, both, all three, a backslash, a tab and non-ASCII | One-line messages are quoted the way `util.inspect` quotes strings: `'...'` by default, `"..."` when the text has `'`, `` `...` `` when it has `'` and `"`, `'...'` with `\'` when it has all three; `\\` and `\t` escaped, non-ASCII kept. Names escape `\` as `\\` and `#` as `\#`. A multi-line message is an `error: \|-` block. This corrects plan delta 9 (YAML `''`), see delta 64 | 2026-10-13 |
| `process.exit` replaced inside a test file run with `--test-force-exit` | A passing file that replaces `process.exit` with a throwing function and leaves an interval | The runner calls `process.exit` itself to force the exit: the replacement throws `ProcessExitCalled` and the file exits 1. Hence delta 55 | 2026-10-13 |
| Global `mock.timers` across tests | `mock.timers.enable({ apis: ["Date"] })` at module level, two tests, `TZ=Asia/Kolkata` | `Date.now()` stays `1700000000000` in both tests; the runner does not reset the global tracker | 2026-10-13 |
| Counters consumed by the runner | `performance.now` and `process.hrtime` replaced by counters, reset in the test body, read after an `await import()` | The first read inside the test is 1 (the runner does not call them between the body's reset and the target's call) | 2026-10-13 |
| Generated tests on the fixture | `npm run la -- run --target fixtures/legacy-billing --out <scratchpad>/la-gen`, then `node --test --test-reporter=tap <out>/tests/billing.characterization.test.mts` | 85 tests, 85 pass; `SPEC.md` shows SB-01 (`roundMoney(-0.125)`), SB-02 (`applyDiscount(100, "VIP")`), SB-03 (`lateFee` ten days early) | 2026-10-13 |
| Refactors | `verify --tests-dir <fake run>/tests --against fixtures/refactors/{modern,broken}` | modern: 85 of 85 pass, exit 0; broken: 5 fail, exit 3 (the three cases of spec 5.10 plus the `roundMoney` boundary cases `-0.135` and `-0.115`, which the rounding change really flips) | 2026-10-13 |
| Baseline tests against the original and the rewrite | `run --provider none` (240 cases), then `verify` against `fixtures/legacy-billing` and `fixtures/refactors/modern` | 240 of 240 pass against both (the rewrite keeps every recorded behavior, including thrown messages, for the baseline's odd inputs) | 2026-10-13 |

### Implementation deltas found in M4 (2026-10-13)

53. Boundary-expansion labels now use ` / ` (`<source label> / arg <i> -1`) instead of ` · `: GEN-02 and spec 5.1 require labels in printable ASCII, and the label is what the emitter writes into the test name. This supersedes delta 43; `plan-cases.unit` was updated.
54. `support.mts` is plain JavaScript inside an `.mts` file (no type annotations), so it reads as ordinary code and acorn parses it for the import check. It is about 560 lines rather than 160, because the serializer, the comparator and the display grammar are duplicated in it (D-08). Its import lines are built from a list in `support-template.ts`, so the repository's import scanner never reads the emitted text as imports of `support-template.ts` (which imports nothing).
55. `support.mts` replaces `process.exit` only while a captured call runs (and restores it afterwards), not for the whole file: node's test runner calls `process.exit` itself for `--test-force-exit`.
56. `loadFresh` (CommonJS) returns the same live `Proxy` view as the recorder (delta 31), not `{ ...exports, default: exports }`. The cache purge and the message normalization use the module's directory as the root (the recorder uses the staged target root; they are the same for a module at the top of the target).
57. `support.mts` normalizes Error messages like the recorder (the module directory and its `file://` URL become `<target>`, `?la=<n>` is removed). It does not track timers, count console lines or flush after the last step: cases with a leaked error are never emitted, and node's runner reports a leak in a test by itself.
58. `describeOutcome(expected, actual, step)` takes the 0-based step index and prints it 1-based (`step 3: expected ...`).
59. Emitter details: the expected Outcome is compact JSON with its fields in a fixed order (`kind` first; `records.json` sorts envelope keys, but the tagged values inside keep their order); a `__proto__` key anywhere is written as `JSON.parse("...")` (arguments as `revive(JSON.parse("..."))`), because an object literal would turn it into a prototype; a sequence is an array literal of captures, one per line; tests are ordered by the module's function order, then case number; the emitter applies the printable-ASCII label rule itself.
60. Generate stage: a second module with the same base name gets its path in the test file name (`lib__a.characterization.test.mts`); `support.mts` is written only when at least one test file is; only `*.characterization.test.mts` and `support.mts` are removed from the tests directory before writing (RF-5).
61. Rule evaluation: a probe is checkable only when its case is characterized (`isCharacterized`: stable, no `timeout` or `no-callback` step, no sandbox-only outcome), slightly stricter than "stable and the last step is not a timeout", so every SB entry has an emitted test that pins it. A `callback` prediction matches when the error slot is empty (absent, `null` or the `undefined` tag) and the second argument (the `undefined` tag when the callback got one argument) equals the value.
62. `src/contracts/mutation.ts` (types only, spec 5.12) exists from M4 so `report.json` and `SPEC.md` can type their mutation part; `OperatorName` in `run.ts` is now an alias of `OperatorId`.
63. `SPEC.md` details: blank lines between blocks and a separator row in every table; the function line is `Side effects: ... Magic numbers: ... Module state read: ...` (the module-level bindings a function reads; the map has no constant values, so spec 5.11's "Module constants used: 0.1, 0.25" is not printed); the Source column is `file:start-end`, plus `constant <v> at line <n>` for each related constant found among the function's magic numbers; a probe cell shows a `returned` value bare and any other outcome with `formatOutcome`, followed by `(predicted ...)`, `(prediction unknown)` or `(not characterized)`; the evidence link text is the case suffix (`c03`); the provider label follows the plan (`provider: fake (scripted) · scenario <s>`), not the spec's sample; tool-made text (the Not characterized reasons) is not escaped, while every LLM string and every identifier is.
64. TAP facts, correcting delta 9: one-line failure messages use `util.inspect` quoting (see the table above), not YAML `''`. `parseTap` reads all three quote styles with their escapes, still accepts `''` inside single quotes, reads the first line of a block message, and stops a name at an unescaped ` # ` (a TAP directive).
65. `verify` details: a killed file's test count is the number of `test(` lines in the file, and every test that did not pass counts as failed; a file that exits non-zero with no failing test (a syntax error, a crash at load) counts all its tests as failed, with the first stderr line as the message; messages are redacted, made one line and cut at 2,000 characters; `file` and `target` in `verify.json` are project-relative like `targetDir`; the `TIMEOUT` line prints the configured `--file-timeout-ms`; a missing tests directory, a directory with no generated file and a file without a `MODULE_NAME` line are `USAGE`; the child's stdout is kept up to 16 MiB and its stderr up to 64 KiB.
66. CLI: `verify --file-timeout-ms` accepts 100 to 3,600,000; `verify` refuses any option that is not its own (`--provider is not an option of verify`), and `map` and `run` refuse `--against` and `--file-timeout-ms`; `verify --out` inside, equal to or containing `--against` is `USAGE`; `run --tests-dir` inside, equal to or containing the target is `USAGE`; `run` also deletes `report.json` and `SPEC.md` before it starts.
67. An ESM namespace lists its exports in alphabetical order, so a CommonJS module's `stateAfter` equals its ESM copy's only when the CommonJS export keys are in alphabetical order too (`taggedEqual` is key-order sensitive by design, D-09). The `cjs-state` target is written that way; a real module with another key order and exported values would fail GEN-09 against an ESM copy.
68. Lying fixture: the first letter of a statement is lowercased only when the second letter is lowercase (`It is not true that VIP customers ...`, not `vIP`); the statement is cut at 300 characters so it still passes the schema; only `hypothesize.v1` turns change.
69. The modern refactor keeps one accident of the object lookup that no recorded case shows yet: a code naming an `Object.prototype` member (`"toString"`) finds that member, so the result is `NaN` (`rateFor`). The error callback is called with one argument, as in `billing.js` (`cb(err, undefined)` would record a second argument).

## M5 and M6 verification (2026-10-13)

| Item | How checked | Result | Date |
|---|---|---|---|
| Whole-source tokenizer vs gap (Step 0 for M5) | `acorn.tokenizer` over `function f(x, a, cents) { if ((x + 1) > a) { return 1; } return x / 100; }`, then over the gap text ` / 100` alone | Whole source: `+` at 33-34, `>` at 38-39, `/` at 66-67; the gap alone throws `Unterminated regular expression (1:2)`, as spec 5.12 says | 2026-10-13 |
| `acorn.getLineInfo` for mutant positions | `getLineInfo("// é\n  a > 1", 9)` | `{ line: 2, column: 4 }` (UTF-16 offsets, acorn's own line breaks); used by `positionOf` in `parser.ts` | 2026-10-13 |
| `acorn-walk` `full` and object keys | `{ 0: "z" }` inside an exported function | `full` does not visit a non-computed property key, so `NUM` handles `Property` keys itself (delta 71) | 2026-10-13 |
| NUM replacement texts | `String(0.1 - 1)`, `String(0.1 + 1)`, `String(0.0725 ± 1)` | `-0.9`, `1.1`, `1.0725`, `-0.9275` (no float noise for the fixture's literals) | 2026-10-13 |
| Round-0 mutation on the fixture (D-11) | `npm run la -- run --target fixtures/legacy-billing --max-rounds 0` (fake, outputs in the session scratchpad) | 133 mutants, 0 invalid, 0 truncated; `mutation: 82.0% (109/133) · AOR 28/30 · ROR 7/10 · LOR 3/3 · NEG 9/9 · NUM 51/67 · BLOCK 11/14`; 24 survivors (19 in `prorate`, 4 in `lateFee`, 1 in `calculateInvoice`). 133 is below 150, so the demo does not need `--max-mutants 100` | 2026-10-13 |
| Survivor round on the fixture | Strict in-process run (`strictFixture: true`, `maxRounds: 1`, `survivorsPerRound: 10`) | Every turn consumed; round 0 82.0% → round 1 90.2% (120/133); 13 proposals, 11 accepted (1 `ARITY`, 1 `DUPLICATE`), 11 new `prorate` cases, 11 mutants killed, 13 survivors left | 2026-10-13 |
| `none` baseline mutation on the fixture | `run --provider none` | 240 cases, `mutation: 31.6% (42/133)`; the run takes about 52 s wall (each surviving mutant replays all 240 cases, about 0.26 s per mutant) | 2026-10-13 |
| Eval table | `node scripts/eval-llm.ts --baseline <none run> --candidate <strict fake run>` | Prints the DEMO-05 table: rules 13 consistent, 3 contradicted, 1 unverified for the fake; inputs proposed 332 vs 35; mutation score 31.6% vs 90.2% (`+58.6 pts`); mixing the `bytes` run and the billing run is `error: USAGE: the two runs have different targetSha`, exit 1 | 2026-10-13 |
| Vendored `bytes@3.1.2` | `npm pack bytes@3.1.2 --offline` into an empty scratch folder (served from the local npm cache, so no network call), extracted into another empty folder | `package.json` `"license": "MIT"`; `index.js` 170 lines with `module.exports = bytes; module.exports.format = format; module.exports.parse = parse`; tarball sha256 `835e37ad...c581`, npm integrity `sha512-/Nf7TyzT...cYbEg==`; `index.js` sha256 `893fcbbb...a37f` | 2026-10-13 |
| `bytes` through the pipeline | `run --target fixtures/third-party/bytes --provider none` | 3 exported functions (`index.js#bytes` as `default`, `format`, `parse`), 111 cases (111 stable), `mutation: 48.6% (36/74)`; the 111 emitted tests pass under plain `node --test`; emitted case IDs equal `replayedCases` (DEMO-06) | 2026-10-13 |

### Implementation deltas found in M5 and M6 (2026-10-13)

70. `Mutant` lives in `src/contracts/mutation.ts` next to the report types. `parser.ts` gains `positionOf(text, offset)` (acorn's `getLineInfo`), so the mutator needs no value import of `acorn`; it uses `acorn-walk`'s `full` and `import type` from `acorn`.
71. Mutator details the plan left open: `NUM` also mutates a non-computed numeric property key (`{ 0: "z" }`, the MUT-02 example), because `acorn-walk` does not visit those keys; method and class-field keys are not mutated; bigint literals are skipped. `AOR` applies to `BinaryExpression` only (`+=` and `**` are untouched). `BLOCK` never touches an empty block and does mutate a nested, non-exported function's single-statement body. Order: file path, mutant start (the operator token's start for `AOR`/`ROR`/`LOR`, so `a + b * c % 2` lists `+`, `*`, `%`), operator order, then walk and replacement order.
72. `mutator.unit`: the plan's NEG/BLOCK example body `if (a) { b = 1; } return a ? 1 : 2;` has two statements, so the function body is a `BLOCK` mutant as well; the test checks "consequent only" on `if (a) { b = 1; }` and the two-statement case separately.
73. Replay: `runChild` takes a `stop` hook (the replay's early exit kills the child without a failure). `replayMutant` compares each case line as it arrives; a `timeout` step or any parent-side failure (watchdog, child exit, output cap) is `timeout` with `killedBy: null`; a timed-out mutant is replayed once more with `steps × caseTimeoutMs` for every case and the re-run's verdict is final (it may also be `killed` or `survived`). `replayCasesBudget` is `min(steps × caseTimeoutMs, max(2000, ceil(10 × recorded)))`, so a full budget below 2,000 ms caps it.
74. `replayMutants` takes `round` (default 0): `no-coverage` is decided only in round 0, from the function's characterized cases; later rounds replay the module's new cases and leave a mutant whose module got none as `survived`. Cases go in case-ID order; batches record `respawns: 0` (one child per replay); `replayedCases` lists every case sent in a job, also after an early exit.
75. Test targets beyond the plan's two: `mutation-loop` (`spin`, kept apart from `mutation-mini` because the baseline's frozen-clock `Date` argument would make the loop run 1.7e12 times while recording), `state-only` (the kill through `stateAfter`: `cjs-state`'s `bump` returns the new total, so its return value changes too, and its keys must stay alphabetical for GEN-09), and `threshold` (the survivor fixtures).
76. `runRecordStage` also returns `timings`, and `runMutateStage` takes it (an extension of the plan's signature) to rewrite `timings.json` with the survivor cases' durations and every replay batch; `records.json` is rewritten when the loop added cases; `llm-trace.jsonl` is rewritten after the loop, also when a survivor call fails. `RunResult.mutation` is no longer nullable, and `mutation.json` joins the artifacts deleted before a run.
77. `roundKilled` is `0` for mutants killed or timed out in round 0, `n` for survivor round `n`, `null` otherwise.
78. CLI: the `mutation: <score>% (...)` line is the second stdout line of `run`; the `mutation: round 0 ... → round n ...` line follows only when rounds exist; its "flagged" count is every `llmSuggestedEquivalent` flag, also on a mutant killed later in the same round.
79. Survivor loop: inputs beyond `inputsPerSurvivor` are cut before the planner and not counted (`inputsProposed` = inputs given to the planner); the planner's `existing` is the function's recorded cases plus the cases planned earlier in the same round, so two survivors of one function number consecutively; a module that fails to load while recording survivor inputs is skipped with a warning; `runSurvivorLoop` also returns `durations` and `rejected`. Survivor rejections (origin `survivor-round`, with `mutantRef`) are appended to `hypotheses.json.rejected` (rewritten after mutate), as `RejectedInput.mutantRef` intends; the eval table's rejected rows count round 0 only, like its proposed and accepted rows.
80. Demo fixture survivor turns (Task 32): the first ten round-0 survivors are all in `prorate` (the 31st-to-30th clamp, the month length, the remaining-days arithmetic); none is equivalent. The one `likelyEquivalent: true` turn (`m-0036`, `startDay === 31` → `=== 0`) is a plausible but wrong judgement ("getDate never returns 0"), kept on purpose to show the flag is advisory: another survivor's input kills that mutant in the same round. This replaces the plan's "a mutant the author judges equivalent". One `invalid_output` turn plus its repair (`m-0041`) shows a repair in the trace.
81. `hypothesize.e2e` HYP-01 now checks that every `hypothesize.v1` turn was consumed instead of calling `assertAllConsumed`, because the demo fixture's survivor turns belong to the mutate stage. The lying-fixture test compares survivor turns as copied unchanged.
82. `bytes` was packed from the local npm cache (`npm pack --offline`); `VENDORED.md` also records npm's sha512 integrity; `Readme.md` and `History.md` were not copied. The pending-marker scan (REP-05) skips `fixtures/third-party/`.
83. `eval-llm`: column labels come from `runLabel` (`none`, `fake (scripted)`, `openai-compatible (<model>)`), because `providerLabel` prints the `provider: ...` form of `SPEC.md`; a zero delta is `0` (`0.0 pts` for the score); the kills-per-input delta is `—` when either side is `n/a`; all six artifacts must share one `targetSha`; `scripts/eval-llm.ts` exports `main(argv, cwd)` for its unit test and exits 1 with `error: USAGE: ...` for a missing option, a missing or invalid file, or an unknown option.
84. DEMO-06 limitation: `replayedCases` holds the cases of modules with at least one replayed mutant, so a module whose characterized cases have no mutant at all (or whose mutants were all cut by `--max-mutants`) would make the emitted set larger. It holds for the fixture, `bytes` and every tiny target used.
85. CLI tests about recording and the provider rule pass `--max-mutants 1 --max-rounds 0`; with mutation on, the two billing runs of one test took 69 s.

## M7 and M8 verification (2026-10-13)

| Item | How checked | Result | Date |
|---|---|---|---|
| The demo (Task 34) | `/usr/bin/time -p node scripts/demo.ts` (stdout and stderr to the session scratchpad) | Exit 0; hero, then the summary on stdout; 17 progress lines and `done in 82.0 s · exit 0` on stderr; real 82.13 s (bound 90 s). Pass A 240 cases `31.6%`, pass B 96 cases `82.0% → 90.2%`, verify modern 96/96, broken 91/96, pass C 111 cases `48.6%` | 2026-10-13 |
| Determinism of the printed blocks | Two demo runs (Task 34's and the one inside `npm run regen`) | Identical summaries except the wording fix of delta 88 made in between | 2026-10-13 |
| `npm test` after Task 35 | `/usr/bin/time -p npm test` | 341 tests (326 + 15), real 110.14 s (bound 180 s); `test:demo` 102.2 s, of which the demo is about 82 s and the lying run about 19 s | 2026-10-13 |
| mermaid-cli 12.0.0 | `LA_DIAGRAMS_OUT=<scratchpad> npm_config_offline=true node scripts/check-diagrams.ts` | Both `docs/diagrams/*.mmd` (and later the README block) rendered offline from the npx cache and the cached Chrome under `~/.cache/puppeteer`; `\n` in a quoted flowchart label renders as a line break | 2026-10-13 |
| The pre-commit hook | `npm run setup:hooks`, then `.githooks/pre-commit` with a file holding `const broken: number = 'x'` | `git config --get core.hooksPath` prints `.githooks`; the hook exits 1 on `TS2322`; no commit was made | 2026-10-13 |
| `check:secrets` | `npm run check:secrets` | `check:secrets: 307 files scanned, 0 findings` (the count grows with the docs) | 2026-10-13 |
| Clean copy (Task 40) | The project copied to the session scratchpad without `node_modules` and `artifacts`, then `npm ci --offline`, `npm run typecheck`, `/usr/bin/time -p npm test`, `npm run check:secrets`, `/usr/bin/time -p node scripts/demo.ts`, `npm run test:live` | `npm ci` from the local cache, 0 vulnerabilities; typecheck 0; 360 tests (345 + 15) pass, real 110.24 s; 0 findings; demo exit 0, real 82.37 s, hero and summary byte-equal to `demo-hero.txt` and `demo-summary.txt`; `test:live` 1 test skipped (no key) | 2026-10-13 |

### Implementation deltas found in M7 and M8 (2026-10-13)

86. `DemoInput` gains `targetLines` (the map stores bytes, not lines) and `thirdPartyLicense`; `demo-hero.ts` exports `count`, `pct`, `functionNameOf`, `verifyCounts` and `SCRIPTED_CAVEAT` for the summary (`verifyCounts` repeats `verifyTotals` because `verify.ts` is not pure).
87. Stdout is the hero followed by the summary, whose leading blank line (spec 10.2) is the separator, so there is exactly one blank line between them; the demo test splits at the first blank line.
88. Summary details the plan left open: the two top hotspots; side effects in `SIDE_EFFECT_KINDS` order; rejected inputs of round 0 only (like the eval table), reasons sorted by count, then name, written `116 rejected (CAP_CASES ×94, DUPLICATE ×22)`; the recording line lists up to three unstable IDs with the differing step and a `not characterized` breakdown by reason; round-0 statuses come from `roundKilled` (a mutant killed in round n was a survivor in round 0); "same N valid mutants as pass A" compares ID, file, position, operator and texts of every non-`error` mutant; SB lines print a `returns`/`returned` value bare and the function's line range; at most five verify failures, then `… and N more in <out>/verify-broken.json`; a verify line shows a `✘` mark when an expectation breaks (the demo exits 2 before printing it); the closing line's "recorded cases" counts characterized cases, which equal the emitted tests.
89. `DEMO_EXPECTATION` (exit 2) is added to the error table for a broken demo expectation (modern refactor failing, broken refactor passing).
90. The offline demo uses the defaults of spec 5.7 for every limit (`loadConfig({})`), whatever `LA_*` variables say, so its blocks always match the goldens; it reads only `LOG_LEVEL` and `LLM_API_KEY` (the latter only so redaction knows it). `--live` loads the full configuration and is `USAGE` (exit 1) unless the provider is `openai-compatible` with a key, also when `loadConfig` itself fails.
91. `--live` writes `eval.md` into `artifacts/demo-live` and `artifacts/demo-live-third-party` and prints both tables plus the live verify counts instead of the hero and the summary (they are built for the scripted pass); live verify results are reported, not enforced. It was not run (no key exists here).
92. `demo.e2e`: one CLI `verify` against the broken refactor is kept for GEN-07's exit code and output lines; the CLI's round-0 → round-1 line (MUT-07) is checked on the lying run's stdout, since the demo prints the summary instead; the score test runs after the artifact golden tests so that a first `npm run regen` writes every golden before it is read; the README regions are written in `before` under `UPDATE_GOLDEN=1`. New file `tests/e2e/demo-script.e2e.test.ts` covers the demo's `--live` and option refusals without running the demo.
93. Task 40's comparison `sed -n '1,/^$/p'` of `npm run demo > file` would include npm's two header lines and the blank line; the clean-copy check runs `node scripts/demo.ts` and compares everything before the first blank line with `demo-hero.txt`.
94. The REP-05 pending-marker scan skips the REP-05 criterion line of `specs/006-demo-and-repo/spec.md`: it is copied verbatim from the design and names the markers it forbids.
95. `check-secrets`: the four patterns run in `KEY_PATTERNS` order and a matched span is masked before the next pattern, so an OpenRouter key is reported once (the generic `sk-` pattern also matches it); a tracked `.env` is reported as `tracked .env file` (line 0) and scanned; files with a NUL byte in the first 8 KiB are skipped; `listScannedFiles` is exported for the count; `artifacts/` and `coverage/` are skipped besides `node_modules` and `.git`.
96. `check-diagrams` writes to `LA_DIAGRAMS_OUT` (default `/private/tmp/la-diagrams`), so a session can keep its scratch files elsewhere.
97. The CI action majors (`checkout@v7`, `setup-node@v7`) follow the author's incident-copilot CI, checked there on 2026-10-04; they were not re-checked here (no network was used), and the workflow comment says so.
98. The flowchart-label convention test removes quoted strings before looking for node shapes, so `\n(` inside a quoted label is not read as a shape.
99. README: the "who decides what" mini table names its last row "Kill verdict and score", so the REP-07 parser's `| Mutation score |` row is unique; the `SPEC.md` excerpt's links are rewritten to `tests/golden/demo/...` so they resolve from the README; the `NUM` sentence says "on well-probed code" because the goldens show `NUM` at 86.6% in the fake run but 28.4% (fixture) and 7.7% (`bytes`) under `none`.

### Deltas from the final adversarial review (2026-10-13)

100. `walkTarget` skips every entry whose name starts with `.` (files and symlinks too, not only directories), so a `.env`, `.npmrc`, `.netrc` or `.DS_Store` next to the target is not mapped, staged under `<out>/stage/original`, hashed into `targetSha` or readable by the child; `node_modules` is still not entered. No fixture holds a dot-file, so no golden or `targetSha` changed. The trust summary's fourth line, the threat model row and the README say so; SAFE-07's text ("the read grant covers everything in the target directory") still holds, now followed by "except dot-files".
101. `verify --tests-dir <dir>` goes through the trust gate when the directory is outside `fixtures/` and `artifacts/` (the test files run as code); the default `<out>/tests` is the tool's own output and is not gated. Exit 4 with `TRUST_REQUIRED: --tests-dir is outside fixtures/ and artifacts/`.
102. `npm run la` runs `src/bin.ts`, which calls `process.loadEnvFile(".env")` only when the file exists and then `runFromProcess()` from `src/cli.ts`. Node 24.21's `--env-file-if-exists=.env` printed `.env not found. Continuing without it.` on every run without a `.env`; `process.loadEnvFile` is silent and, like the flag, does not override a variable already in the environment (checked: `FOO=fromenv` wins over `FOO=fromfile`). `test:live` keeps the flag.
103. The CS-3 check reads only the first argument of `test(...)` calls (`testNames` in `tests/helpers/repo-files.ts`), so an ID in a comment or another string no longer counts.
104. 26 exported symbols that no other file used lost the `export` keyword and the unused `taggedInputSchema` alias was removed; a conventions test now fails on an export no other file under `src/`, `scripts/` or `tests/` names.
105. Portuguese sample text in two unit tests replaced by English and loanword samples with the same code-unit lengths; a conventions test rejects a-tilde, o-tilde and c-cedilla before a or o in versioned files (constitution rule 14).

### Deltas from the CI flake of 2026-10-13

| Item | How checked | Result | Date |
|---|---|---|---|
| `process.exit` with piped stdout | A child writes 1,000,000 bytes with `process.stdout.write` and calls `process.exit(0)`; the parent reads at once, or only after a 2 s busy wait | Read at once: all 1,000,000 bytes. Busy parent: 65,500 bytes arrive and `process.stdout.writableLength` was 934,500 at the exit, so the rest was dropped (writes to a pipe are asynchronous on POSIX) | 2026-10-13 |
| `--test-force-exit` and the reporter | Node 24.21's `lib/internal/test_runner/test.js` (the strings in the `node` binary) | The root test waits for the reporter stream to `unpipe` from `process.stdout`, then calls `process.exit()`; it does not wait for the bytes `process.stdout` still holds | 2026-10-13 |
| A verify child that fills its stdout, then ends with `--test-force-exit` | A generated-looking file whose first test writes to fd 1 until `EAGAIN`, then 20 passing tests; the parent blocked until the child exited (`tests/e2e/verify.e2e.test.ts`) | Through a pipe: `verify.json` said 0 tests, 0 passed, 0 failed, exit 0. With a file: 21 of 21 | 2026-10-13 |
| Stdout as an inherited regular file under `--permission` | `spawn(node, ["--permission", "-e", ...], { stdio: ["ignore", fd, "pipe"] })` with no write grant, 1,000,000 bytes, then `process.exit(0)`, the parent busy for 2 s | `process.stdout` is a `SyncWriteStream`, `writableLength` 0, all 1,000,000 bytes in the file; the grant is not needed for an inherited descriptor | 2026-10-13 |
| The demo under CPU load | `npm run test:demo` in a copy of the repository while 36 `node -e 'for(;;){}'` loops ran on 18 cores (load average 24 to 54), once before the fix and twice after it | 15 of 15 each time (119 s; 115 s and 120 s); every batch in the four `timings.json` files has `respawns: 0`, and no mutant was replayed with the full budget (the only second replays are the survivor round's), so recording and replay kept their verdicts under load. On this Mac a child's stdout pipe took 65,500 bytes before writes queued, more than the demo's 23.5 KB TAP stream, so the loss could not show locally; the Linux runner's channel held less of it | 2026-10-13 |

106. `verify` gives each test file's child a temporary file (under `os.tmpdir()`, outside every grant, removed afterwards) as its stdout instead of a pipe, and reads the TAP stream from it after the child exits. CI run 38382986246 (`ubuntu-latest`) recorded and emitted the 96 golden tests, but `verify-modern.json` said 89 passed and 0 failed: under `--test-force-exit` the runner exits as soon as its reporter has handed the last lines to `process.stdout`, and a pipe that the loaded parent had not drained kept the last seven results in the child's memory, where `process.exit` dropped them. Node writes to a regular file synchronously, so the stream is complete on disk whatever the parent's speed. The parent checks the file's size every 100 ms and kills a file whose stdout passes 16 MiB (its tests count as failed, with `killed: stdout passed 16 MiB`), so a chatty target cannot fill the disk. Independently, a file that exits with fewer TAP results than `test(` lines (an early `process.exit` in the target, or lost output) counts every missing result as failed, with `the file reported <n> of <m> test results before it exited`, so a short stream can no longer read as a pass. No golden changed.

## Suite timing per milestone

| Milestone | `npm test` wall time (macOS) | Tests | Date |
|---|---|---|---|
| M2 | 6.63 s (`/usr/bin/time -p npm test`; node reports 6,416 ms) | 181 | 2026-10-13 |
| M3 | 6.09 s (`/usr/bin/time -p npm test`; node reports 5,934 ms) | 233 | 2026-10-13 |
| M4 | 8.42 s (`/usr/bin/time -p npm test`, now `test:fast` then `test:demo`; node reports 6,339 ms and 1,820 ms) | 287 (281 + 6) | 2026-10-13 |
| M5 and M6 (chunk 6) | 47.05 s (`/usr/bin/time -p npm test`; node reports 7,635 ms for `test:fast` and 39,163 ms for `test:demo`, which now runs two billing runs with mutation and a survivor round) | 324 (316 + 8) | 2026-10-13 |
| M7 and M8 (chunk 7) | 110.14 to 110.24 s (`/usr/bin/time -p npm test`; node reports 7,696 ms for `test:fast` and 102,193 ms for `test:demo`, which now runs the full demo and the lying run); `npm run demo` 82.13 to 82.37 s | 360 (345 + 15) | 2026-10-13 |
