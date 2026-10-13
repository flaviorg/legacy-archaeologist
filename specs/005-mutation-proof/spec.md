# 005 · Mutation proof

Status: implemented (v1)

## Context

The mutator applies six AST operators (`AOR`, `ROR`, `LOR`, `NEG`, `NUM`, `BLOCK`) inside exported functions by string splice on acorn ranges, the operator token located by one tokenizer pass over the whole source. Each mutant copy is derived from the staged copy and replayed in the same isolated child against the characterized cases, compared with the same comparator the emitted tests use.
The score uses Stryker's formula; the bounded survivor loop asks the LLM for extra inputs, records them on the original code and re-runs only the survivors. Tests and `SPEC.md` are emitted after the loop, so the score and the emitted file cover the same cases.
Code: `src/mutation/*.ts`, `src/pipeline/mutate.ts`, `src/harness/run-batch.ts` (replay).

## Acceptance criteria

Copied verbatim from the design document, section 8.3.

- **MUT-01** When `listMutants` runs on a file, the system shall produce, for each of the 6 operators (`AOR`, `ROR`, `LOR`, `NEG`, `NUM`, `BLOCK`), exactly the replacements of section 5.12 at nodes inside exported functions, with IDs in the order file, range start, operator, replacement.
- **MUT-02** When a mutant's text fails to parse, the system shall drop it and count it as `invalid`, outside the score.
- **MUT-03** `applyMutant` shall change only the bytes in the mutant's range, leaving the rest of the file byte-identical; for `AOR`, `ROR` and `LOR` the range shall be the operator token only, so parentheses and comments around the operands are preserved.
- **MUT-04** When a mutant is replayed, the system shall classify it `killed` with `killedBy` the first characterized case whose tagged outcome (`outcomesEqual`) or tagged `stateAfter` (`taggedEqual`) differs, `survived` when all equal, `timeout` when the replay watchdog fires or a case times out and a re-run with the full `steps × caseTimeoutMs` budget times out again, `no-coverage` when the function has no characterized case, and `error` when the mutant fails to load; the union of the case IDs used in any replay shall be written as `replayedCases`.
- **MUT-05** The system shall compute `mutationScore = (killed + timeout) / (killed + timeout + survived + noCoverage) × 100`, excluding `error` and `invalid`, with one decimal, and the same per operator in `byOperator`.
- **MUT-06** The survivor loop shall stop after `maxRounds` rounds (default 1) even when survivors remain, shall consider at most `survivorsPerRound` survivors per round, shall never ask the LLM about the same mutant twice, and shall be skipped with the `none` provider.
- **MUT-07** When the LLM proposes inputs for a survivor, the system shall record them on the original code (twice), add them as cases with origin `survivor-round` and `mutantRef`, and re-run only the surviving mutants.
- **MUT-08** When a run ends, `artifacts/<run>/mutants/` shall be removed unless `--keep-mutants` was given.
- **MUT-09** When the LLM answers `likelyEquivalent: true`, the mutant's status and the score shall be unchanged, and the flag shall be stored as `llmSuggestedEquivalent`.

## Non-goals

- A complete mutation engine: six operators inside exported functions only. Same formula as Stryker so the definitions match; the scores are not comparable because the operator sets differ.
- LLM-generated mutants or LLM-judged equivalence: the "likely equivalent" flag is advisory and never changes the score.
- Running the emitted test file against each mutant (`--runner node-test`, `MUT-10`), `--equivalents`, `--keep-mutants`, `BOOL` and `STR`: optional work (M9).

## Decisions made during implementation

Numbered deltas refer to the plan (1 to 23) and to `docs/api-notes.md` (24 on).

- MUT-08 is copied verbatim; `--keep-mutants` is an M9 option (design 2.2), so in v1 the `mutants/` directory is always removed and the CLI refuses the flag with `USAGE`.
- Plan delta 5 and Step 0: tokenizing only the gap between the operands throws `Unterminated regular expression` on `/`; one pass over the whole source finds every operator at the right offset (re-checked on 2026-10-13).
- Plan delta 18: `listMutants` returns `{ mutants, invalid, truncated }`; `mutationScore` is 0 when `valid` is 0.
- Deltas 70 to 72: `Mutant` lives in `src/contracts/mutation.ts`; `parser.ts` gains `positionOf`; `NUM` also mutates a non-computed numeric property key (acorn-walk does not visit it); mutants are ordered by the mutant's start; `BLOCK` never touches an empty block.
- Deltas 73 and 74: any parent-side failure during a replay counts as `timeout`; a timed-out mutant is replayed once more with `steps × caseTimeoutMs` and that verdict is final; `killedBy` is null for `timeout`; `no-coverage` is decided in round 0 only.
- Deltas 76 to 78: `runMutateStage` rewrites `records.json`, `timings.json` and the trace after the loop; `roundKilled` is 0 for round 0, `n` for survivor round `n`; the CLI prints the round-0 versus round-n line.
- Delta 80: the demo fixture's survivor turns were written after reading the real round-0 survivors (all ten in `prorate`); its one `likelyEquivalent: true` answer is a plausible but wrong judgement, kept to show the flag is advisory.
- Delta 84: DEMO-06 holds when every module with characterized cases has at least one replayed mutant (true for the fixture, `bytes` and every test target).
- Measured: the fixture has 133 mutants, 0 invalid, 0 truncated (below 150, so the demo needs no `--max-mutants 100`, D-11); `none` 31.6% (42/133); fake round 0 82.0% (109/133) and round 1 90.2% (120/133) with 13 survivors left; `bytes` 48.6% (36/74) with 38 survivors.

## Test files

| Criterion | Test files |
|---|---|
| MUT-01 | `tests/unit/mutator.unit.test.ts` |
| MUT-02 | `tests/unit/mutator.unit.test.ts` |
| MUT-03 | `tests/unit/mutator.unit.test.ts` |
| MUT-04 | `tests/e2e/mutation.e2e.test.ts`, `tests/unit/outcomes.unit.test.ts` |
| MUT-05 | `tests/e2e/mutation.e2e.test.ts`, `tests/unit/mutation-score.unit.test.ts` |
| MUT-06 | `tests/e2e/survivor-loop.e2e.test.ts` |
| MUT-07 | `tests/demo/demo.e2e.test.ts`, `tests/e2e/survivor-loop.e2e.test.ts` |
| MUT-08 | `tests/e2e/mutation.e2e.test.ts` |
| MUT-09 | `tests/e2e/survivor-loop.e2e.test.ts` |
