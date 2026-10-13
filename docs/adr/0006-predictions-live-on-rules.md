# ADR 0006: predictions live on rules, never on cases

## Status

Accepted (2026-10-08, design D-07). Enforced by LLM-03 and dependency rule 8.

## Context

The point of the project is that the real code, not the LLM, writes every expected value. If the model's predicted value travelled with a case, it could leak into a generated assertion, and "AI-generated tests that assert what the model guessed" is exactly the failure mode the project argues against.

## Decision

A case carries inputs only (arguments, label, origin, rule references). Predictions stay on the rule hypotheses in `hypotheses.json`. After recording, the rule evaluator compares each prediction with the recorded outcome of its probe's last step and assigns `consistent`, `contradicted` or `unverified`; a contradiction becomes a suspicious behavior in `SPEC.md`. The test emitter sees the map and the records only: it imports nothing from the evaluator, the hypothesis or report contracts or the LLM layer.

## Consequences

- A lying fixture (every prediction wrong, every statement false, same inputs and labels) produces byte-identical `records.json`, test files and `support.mts`; only `SPEC.md`, `report.json`, `hypotheses.json` and the trace differ (LLM-03, a demo test).
- "Consistent" covers only the probes the model chose, and `SPEC.md` prints them next to the status.
- Test names carry probe labels (chosen by the model, sanitized) but never statements.

## Alternatives

- The LLM writes expected values and the recorder checks them: the model's value would be the default and reality the exception.
- No predictions at all: no way to flag where the code disagrees with a plausible business rule.
