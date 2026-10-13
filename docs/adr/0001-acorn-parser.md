# ADR 0001: acorn and acorn-walk as the parser

## Status

Accepted (2026-10-08, design D-01). Verified in Step 0 on 2026-10-13 with acorn 8.19.0 and acorn-walk 8.3.5.

## Context

The static map, the complexity count and the mutator all need an AST with exact source ranges for legacy JavaScript: ES5 scripts in sloppy mode (including `with`), CommonJS and ES modules. The `typescript` package's compiler API is not an option (TypeScript 7 is used for type checking only), and the old esprima/escodegen family is unmaintained.

## Decision

Parse with `acorn` 8.19.0 (`ecmaVersion: "latest"`, `locations`, `ranges`, `onComment`; `module` first, then `script` when the file has no import or export) and walk with `acorn-walk` 8.3.5. Value imports of `acorn` live only in `src/static/parser.ts`; everything else uses `import type` or the functions that file exports.

## Consequences

- Every node has `start`, `end`, `range` and `loc`, so map lines, columns and mutant splices are exact (UTF-16 offsets).
- Sloppy ES5 parses as `script`; a CommonJS file without import or export is reported as `script` even though it is valid module syntax (delta 24).
- TypeScript, JSX and Flow input are not supported in v1.
- `acorn-walk` does not visit some nodes (non-computed property keys, pattern identifiers through `simple`), so the code reads those fields itself (deltas 71 and M1 notes).

## Alternatives

- `@babel/parser`: heavier; kept as a fallback if a TypeScript adapter ever needs it.
- `oxc-parser`: fast and TypeScript-aware, but a 0.x API; the optional TypeScript adapter would pin it exactly.
- `@typescript-eslint/typescript-estree` and `ts-morph`: need the TypeScript JS API, unavailable with TypeScript 7.
- `esprima` with `escodegen` or `escomplex`: unmaintained.
