# Threat model

**Assumption: the target is code you already run in production or would run on your machine.** The harness reduces the blast radius of mistakes and of hostile test inputs; it is not a sandbox for malicious code. For untrusted code, run the whole tool inside a container or a VM.

The Node permission model is documented as a seat belt, and `node:vm` as not a security mechanism. The isolation here is built from those parts and is described the same way.

## Threats and mitigations

| Threat | Mitigation | Limits | Test |
|---|---|---|---|
| Target code reads files outside its directory | `--permission --allow-fs-read=<harness>,<contracts>,<target real path>` | Node docs: symlinks and some fd operations can bypass; the parent resolves the target's real path and refuses symlinks inside the tree | SAFE-01, SAFE-06 |
| Target code reads secrets that sit next to it (a `.env` in the legacy folder) | Dot-files (`.env`, `.npmrc`, `.netrc`) and dot-directories are never walked, so they are not staged under `<out>/stage/original`, hashed or readable by the child | Every other file of the target is copied in plain text to `<out>/stage/original` and is readable: a `secrets.json` or a `config.js` holding a key would be. Point the tool at the module's folder, not at a repository root, and keep `--out` under the ignored `artifacts/`; said in the `--i-trust-this-code` summary and the README | SAFE-01, SAFE-07 |
| Target code writes files, spawns processes, starts workers, loads addons | Denied by `--permission` (no `--allow-fs-write`, `--allow-child-process`, `--allow-worker`, `--allow-addons`) | Seat belt per Node docs | SAFE-02 |
| Target code calls the network | `--import` guard replaces `fetch`, `net.Socket.prototype.connect`, `net.createConnection`, `tls.connect`, `http`/`https` `request` and `get`, `http2.connect`, `dns.lookup`, `dns.resolve*`, `dns.Resolver`, `dns.promises` and `dgram.createSocket`, synced to ESM with `syncBuiltinESMExports`; loopback blocked in the child, allowed only in the project's own test process | `--permission` does not restrict network on Node 24.21 (verified); a module that ships its own native socket would bypass the guard | SAFE-03 |
| Infinite loop, slow code, output bomb, self-kill, crash | Per-case watchdog with SIGKILL and re-spawn from the next case, stdout/stderr/fd 3 caps, NDJSON resume | A sync loop costs `steps × case timeout + margin` once per case (twice when the re-run fires too) | SAFE-04, SAFE-08 |
| Target code writes to the protocol pipe or to stdout | fd 3 lines carry a per-spawn nonce the target cannot know (deleted from `process.env` before any case runs); stdout and stderr are counted as stray output, never parsed | A target that reads the nonce from the child's memory could forge a line; trusted code only | SAFE-08 |
| Secrets leak into the child or into artifacts | Scrubbed environment (`TZ`, `LANG`, `LC_ALL`, `NODE_OPTIONS`, `PATH`, `LA_NONCE` only); redaction of every output; the trace never includes the key; `check:secrets` in the hook and CI | | SAFE-05, LLM-06 |
| Hostile LLM output (prompt injection through the legacy code's comments or strings reaching the model) | Output is data validated by Zod with caps; labels sanitized; nothing from the model is executed, written to the target or used as an expected value | The model may still propose silly inputs; they are recorded like any other | LLM-03, LLM-04, HYP-04 |
| Mutant copies pile up | `artifacts/<run>/mutants/` deleted after the run (only when its marker file is present); `artifacts/` in `.gitignore` | `--keep-mutants` is future work, so v1 always deletes | MUT-08 |
| The tool gets used on code the user does not own | Trust flag: any target or `--against` directory outside `fixtures/`, and any `--tests-dir` given to `verify` outside `fixtures/` and `artifacts/` (its test files run as code too), needs `--i-trust-this-code`, else the CLI prints the five-line summary below and exits 4 | | SAFE-07 |

The summary printed by the trust gate:

```text
legacy-archaeologist runs the target's code: only point it at code you trust and would already run on this machine.
The recording child cannot write files, spawn processes, start workers or load addons, and reads only the target and the tool's harness.
Network calls are blocked by a guard loaded into the child, not by Node's --permission model; a module with its own native socket code would bypass it.
The read grant covers everything in the target directory except dot-files (.env, .npmrc and the like are never copied); every other file is copied under --out and readable by the child: point the tool at the module's folder, not at a repository root.
For untrusted code, run the whole tool inside a container or a VM.
```

## Measured isolation behavior

Measured on 2026-10-13 (Node 24.21.0, macOS) with the real spawn: each target under `tests/fixtures/targets/` staged into a temporary folder and run through the parent, one case per function, `caseTimeoutMs` 300 and watchdog margin 200. `tests/e2e/harness-isolation.e2e.test.ts` and `tests/e2e/record.e2e.test.ts` assert these outcomes; no isolation gap was found.

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

`verify` runs every generated test file under the same three kinds of grant (the tests directory, the `--against` directory and the harness directory), the same guard and a fixed environment (`TZ`, `LANG`, `LC_ALL`, `NODE_OPTIONS`, `PATH` and `LA_TARGET_DIR`), with `--test-force-exit` and a 30-second file watchdog.
