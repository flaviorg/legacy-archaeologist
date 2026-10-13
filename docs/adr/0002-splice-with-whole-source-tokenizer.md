# ADR 0002: mutate by string splice, operator tokens from one whole-source tokenizer pass

## Status

Accepted (2026-10-08, design D-02; plan delta 5). Re-verified on 2026-10-13.

## Context

A mutant must change exactly one thing and keep the rest of the file byte for byte, so its reported line and column match the original and comments survive. Regenerating code from the AST (for example with `astring`) reformats the whole file and drops comments. Splicing the whole gap between two operands breaks `if ((a + b) > c)`, and tokenizing only that gap throws `Unterminated regular expression` on every `/`, because a tokenizer that starts on `/` expects a regular expression.

## Decision

Replace by string splice on acorn ranges. For `AOR`, `ROR` and `LOR` the replaced range is the operator token only: one `acorn.tokenizer` pass over the whole source file (same options as the parse), then, for each node, the token whose `start` lies in `[left.end, right.start)` and whose source text equals the node's operator. Every mutated text is re-parsed and dropped as `invalid` when it does not parse.

## Consequences

- `applyMutant` changes only the bytes in the range (MUT-03); parentheses and comments around the operands survive.
- `(cents / 100)`, `Math.ceil(days / 7)` and `(a /*c*/) / (b)` all mutate correctly (`mutator.unit`).
- No extra dependency.
- An operator that needs structural rewriting would not fit; none of the six does.

## Alternatives

- `astring` (code generation from the AST): reformats the file and drops comments.
- Splicing the whole gap between operands: breaks parenthesized expressions and deletes comments.
- Tokenizing only the gap: throws on `/` (verified).
