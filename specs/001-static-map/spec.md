# 001 · Static map

Status: implemented (v1)

## Context

The first stage reads a legacy JavaScript folder with acorn and acorn-walk and writes `map.json`: modules, exported functions with their parameters and callback style, a minimal scope resolver, side effects, module state, magic numbers, per-function call lists and cyclomatic complexity with the hotspot list.
Everything in the map is computed by a parser, never guessed; the LLM only reads it. `src/static/**` imports only `acorn`, `acorn-walk` and `src/contracts`, so the map is a pure function of the file contents.
Code: `src/static/*.ts`, `src/pipeline/map.ts`, `src/infra/target-files.ts`, CLI `map`.

## Acceptance criteria

Copied verbatim from the design document, section 8.3.

- **MAP-01** When `map` receives a directory, the system shall parse every `.js`, `.cjs` and `.mjs` file outside `node_modules`, `.git` and other dot-directories with acorn (`sourceType: "module"` first, then `"script"`), record `parse: "ok" | "error"` per file, list per module the literal specifiers that name an npm package or leave the target folder as `externalSpecifiers`, and exit 2 only if no file parses.
- **MAP-02** When a module exports functions through `module.exports = {…}`, `module.exports.x =`, `exports.x =`, `module.exports = function`, `export function`, `export const x = () =>` or `export default`, the system shall list each as an exported function with its `functionId` and parameter names, using `<file>#default` with `exportName: "default"` for an anonymous default export and the declared name otherwise.
- **MAP-03** When an identifier is referenced inside a function, the system shall classify it as local, module-level or global using the hand-written scope resolver, and list module-level bindings written by any function as `moduleState`.
- **MAP-04** When a function references `Date`, `Math.random`, `performance.now`, `process.hrtime`, `crypto`, `fs`, `child_process`, `net`, `http`, `dns`, `console`, `process.env`, timers, `Intl`, writes a global, or writes module state, the system shall record a side effect with kind and line, including through `require` aliases.
- **MAP-05** The system shall compute cyclomatic complexity per function as 1 plus the count of `if`, loops, `?:`, `&&`, `||`, `??`, `case` with test and `catch`, and list the top 5 as hotspots.
- **MAP-06** When a call's callee is a computed member or a non-identifier expression, the system shall record the edge as `dynamic: true, resolved: null` instead of guessing; when the callee is the name of a module-level function of the same file, `resolved` shall be that function's ID, with no analysis of the callee's body.
- **MAP-07** When `buildMap` runs twice on the same contents, or with files in a different order, the output shall be byte-identical, and `targetDir` shall be relative to the project root.
- **MAP-08** When a function's last parameter is invoked as a function inside its body, the system shall mark `style: "callback"` and `callbackParam`.

## Non-goals

- Full TypeScript, JSX, decorators or Flow: v1 parses what acorn parses (JS scripts and modules); a TypeScript adapter is optional work (M9).
- A cross-function call graph: callee names are resolved by name in the same file only, and a callee's body is never followed (M9).
- Running on huge codebases: at most 200 files, 2 MiB and 50 exported functions per run (`--only` narrows it).

## Decisions made during implementation

Numbered deltas refer to the plan (1 to 23) and to `docs/api-notes.md` (24 on).

- Plan delta 5: acorn's `Token` type has no `value` field and operator labels are grouped, so code that needs an operator token picks the token in `[left.end, right.start)` whose source text equals the operator; ranges come from `node.start`/`node.end`.
- Plan delta 6: `buildMap(files, moduleKind, meta)` receives `targetDir`, `targetSha`, `builtinModules` and the per-file sha256 from the map stage, because `src/static` may not import `node:*`.
- Delta 24: `parseSource` tries `module` first, but a module parse with no import or export declaration is re-parsed as `script` and reported `script` when that succeeds (an ES5 CommonJS file is valid module syntax).
- Delta 25: the map's `tool` field is passed in through `meta` (`src/static` may not import `src/infra/version.ts`).
- Delta 26: `StaticMap.stats` carries `unresolvedIdentifiers` (`with` bodies and files with a direct `eval`).
- Delta 27: module-level bindings carry `functionValued`, so `readsModuleState` and `moduleState` skip module-level functions.
- Delta 28: columns are 1-based UTF-16 code units (acorn's 0-based `loc.start.column` plus one), like lines.
- Delta 30: a symlink inside the walked target is `TARGET_SYMLINK`; `--only` accepts a function ID or a bare function name and is `USAGE` for an unknown one; `--out` inside, equal to or containing the target is `USAGE`.
- Step 0 (2026-10-13, `docs/api-notes.md`): acorn 8.19.0 exposes `start`, `end`, `range` and `loc` on every node with `ranges: true`; `acorn-walk` 8.3.5 does not visit `VariablePattern`/`MemberPattern` through `simple` (assignment targets are read from `AssignmentExpression.left`); `TextEncoder` is a global, so byte lengths need no `node:` import.
- Measured: `npm run la -- map --target fixtures/legacy-billing` maps 7 exported functions (1 callback-style), side effects `Date ×3, Math.random ×1, global-write ×1, module-state-write ×1`, 0 unresolved calls; the vendored `bytes@3.1.2` maps 3 exported functions.

- Delta 100 (final review): dot-files are skipped like dot-directories, so they are not mapped or hashed into `targetSha`.

## Test files

| Criterion | Test files |
|---|---|
| MAP-01 | `tests/e2e/cli.e2e.test.ts`, `tests/e2e/record.e2e.test.ts`, `tests/unit/map.unit.test.ts`, `tests/unit/parser.unit.test.ts` |
| MAP-02 | `tests/unit/exports.unit.test.ts`, `tests/unit/map.unit.test.ts` |
| MAP-03 | `tests/unit/map.unit.test.ts`, `tests/unit/scope.unit.test.ts` |
| MAP-04 | `tests/unit/side-effects.unit.test.ts` |
| MAP-05 | `tests/unit/complexity.unit.test.ts` |
| MAP-06 | `tests/unit/calls.unit.test.ts` |
| MAP-07 | `tests/unit/map.unit.test.ts` |
| MAP-08 | `tests/unit/map.unit.test.ts` |
