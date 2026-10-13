# ADR 0004: a --permission child with a network guard and an fd 3 nonce, as a seat belt

## Status

Accepted (2026-10-08, design D-05 and D-21; plan delta 8). Measured on 2026-10-13 (`docs/threat-model.md`).

## Context

Recording runs the target's code with inputs an LLM proposed. The tool targets trusted code, but a mistake (a function that writes files, opens a socket, loops forever or prints megabytes) must not damage the machine or corrupt the results. `node:vm` is documented as not a security mechanism; Node's permission model is documented as a seat belt and, on 24.21, does not restrict the network.

## Decision

Run each batch in a child process with `--permission` and read grants for three directories only (the harness, the contracts, the staged copy), a scrubbed environment, and an `--import` guard that replaces every network entry point and syncs the patches to ESM. The protocol travels on fd 3, each line carrying a per-spawn nonce that the child deletes from its environment before any case runs; stdout and stderr are counted and capped, never parsed. A per-case watchdog SIGKILLs and re-spawns.

## Consequences

- Writes, spawns, workers and addons fail with `ERR_ACCESS_DENIED`; network calls throw `NO_NETWORK`; loops, crashes and output bombs become `timeout` with a reason, and the batch continues.
- Lines without the nonce are dropped and counted (`forgedLines`), so stray output cannot forge a result.
- It is still a seat belt: a native socket module would bypass the guard, and a target that reads the nonce from memory could forge a line. The README and the trust gate say "trusted code only".
- The read grant covers the whole staged copy of the target folder; dot-files such as a `.env` are not staged (2026-10-13 review), every other file is.

## Alternatives

- `node:vm`: not a security mechanism.
- Worker threads: share the process; no permission boundary.
- A container per run: strong isolation, but Docker would be a requirement of the demo; recommended in the threat model for untrusted code.
- Protocol on stdout: any `console.log` in the target would corrupt it.
