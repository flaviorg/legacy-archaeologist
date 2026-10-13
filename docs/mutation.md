# Mutation score

The mutation score answers one question: **do the recorded cases detect a change to the code?** Each mutant is a copy of the staged target with one small deterministic change; the characterized cases are replayed against it in the same isolated child that recorded them, and compared with the same comparator the emitted tests use.

## Formula

```text
detected      = killed + timeout
valid         = detected + survived + noCoverage
mutationScore = detected / valid × 100      (one decimal; 0 when valid is 0)
```

`error` mutants (the copy fails to load) and `invalid` mutants (the mutated text does not parse) are outside the score. A timeout counts as detected and `no-coverage` counts as valid and not detected, as in Stryker. Same formula as Stryker so the definitions match; the scores are not comparable because the operator sets differ.

## Operators (v1)

| ID | Operator | Mutations (one mutant per applicable node and replacement) | Node types |
|---|---|---|---|
| `AOR` | Arithmetic operator replacement | `+`↔`-`, `*`↔`/`, `%`→`*` | `BinaryExpression` (string concatenation with a literal string operand is skipped) |
| `ROR` | Relational boundary and equality | `<`↔`<=`, `>`↔`>=`, `==`↔`!=`, `===`↔`!==` | `BinaryExpression` |
| `LOR` | Logical operator | `&&`↔`\|\|` | `LogicalExpression` |
| `NEG` | Condition negation | `if (c)` → `if (!(c))` | `IfStatement.test`, `ConditionalExpression.test` |
| `NUM` | Numeric literal | `n` → `n + 1`, `n - 1`, and `0` when `n ≠ 0`, deduplicated by text (up to three); negative replacements parenthesized | `Literal` number (also a non-computed numeric property key), outside `module.exports` assignments |
| `BLOCK` | Block removal | function body or `if` consequent `{ ... }` → `{}` | non-empty `BlockStatement`, except an exported function's body when it is its only statement |

Only nodes inside an **exported function** are mutated. For `AOR`, `ROR` and `LOR` the replaced range is the operator token only, found by one `acorn.tokenizer` pass over the whole source (tokenizing just the text between the operands throws `Unterminated regular expression` on every `/`), so parentheses and comments around the operands survive the splice. Every mutated text is re-parsed and dropped as `invalid` when it does not parse. Order: file, mutant start, operator, replacement; `--max-mutants` (default 200) truncates in that order and reports `truncated`.

## Statuses

| Status | Meaning |
|---|---|
| `killed` | A characterized case of the mutant's module differs in a step's tagged outcome (`outcomesEqual`) or in its tagged `stateAfter` (`taggedEqual`); `killedBy` names the first one |
| `timeout` | The replay watchdog fired, and a re-run with the full `steps × caseTimeoutMs` budget timed out again |
| `survived` | Every characterized case is equal |
| `no-coverage` | The mutated function has no characterized case |
| `error` | The mutant copy fails to load |

The replay budget per case is `clamp(10 × recorded duration, 2,000 ms, steps × caseTimeoutMs)`; a mutant that times out is replayed once more with the full budget before it counts as `timeout`, so a healthy mutant slowed by load is not miscounted.

## Per-operator breakdown

`mutation.json` carries `byOperator`, and `SPEC.md` prints the mutants per function. Read the breakdown, not only the headline: `NUM` makes up to three mutants per literal, so it dominates the count (67 of the fixture's 133 mutants). On well-probed code `NUM` mutants are the easiest to kill and inflate the aggregate; on code with few probes they can drag it down instead.

| Run (goldens) | Score | `AOR` | `ROR` | `LOR` | `NEG` | `NUM` | `BLOCK` |
|---|---|---|---|---|---|---|---|
| fixture, `none` | 31.6% (42/133) | 7/30 | 3/10 | 3/3 | 2/9 | 19/67 | 8/14 |
| fixture, fake (scripted), after round 1 | 90.2% (120/133) | 30/30 | 7/10 | 3/3 | 9/9 | 58/67 | 13/14 |
| `bytes@3.1.2`, `none` | 48.6% (36/74) | 1/4 | 4/11 | 7/10 | 14/17 | 1/13 | 9/19 |

Detected over valid per operator, from `tests/golden/{demo-baseline,demo,third-party/bytes}/mutation.json`.

## The survivor loop

After round 0, up to `survivorsPerRound` survivors (default 10, in ID order) are sent to the LLM with the function source, the mutated line with three lines of context and up to 20 existing case arguments. The answers are validated and planned like any proposal (origin `survivor-round`, with `mutantRef`), **recorded on the original code** (twice, for stability) and replayed against the surviving mutants only. The loop stops after `maxRounds` (default 1) and never asks about the same mutant twice. With the `none` provider it is skipped.

## The "likely equivalent" flag is advisory

An equivalent mutant behaves exactly like the original, so no input can kill it. The LLM may answer `likelyEquivalent: true`; the flag is stored on the mutant as `llmSuggestedEquivalent` with its reason and never changes a status or the score. The demo shows why: its one flagged mutant (`m-0036`) is not equivalent, and another survivor's input kills it in the same round. A hand-reviewed equivalents file and a second score are future work.

## What the score measures

The oracle is reality by construction: every expected value was recorded from the original code. So the score does not grade hand-written assertions; it measures whether the **recorded inputs** are sensitive to changes in the code, replayed in the harness with the comparator the emitted tests use. Running the emitted test file itself against each mutant (a cross-check with the real test runner) is future work; in v1 the replay is the only runner.

Two things the score is not: it is not a correctness claim (characterization records what the code does, quirks included), and it is not comparable with a StrykerJS score (sixteen mutator groups against six operators here).
