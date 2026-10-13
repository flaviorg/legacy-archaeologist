# ADR 0008: a `none` baseline and a conditional provider default

## Status

Accepted (2026-10-08, design D-18 and D-22).

## Context

The demo's LLM is a scripted fake, so its survivor inputs were written by the author after seeing the survivors; a reader may reasonably think the scripted score is rigged. A user pointing the tool at their own code with no key must still get something useful, and an explicit choice must never be overridden.

## Decision

Ship a `none` provider: deterministic inputs from a baseline value table derived from the static map (parameter positions, structured seeds, magic-number boundaries), no rules and no survivor round, through the same planner, recorder, mutator and generator. The demo prints its score next to the scripted one, and the hero's score line says *scripted: author-written survivor inputs; proves the loop, not the model*. Provider rule: `--provider`, then `LLM_PROVIDER`; when neither is set, `fake` if a fixture exists for the scenario, otherwise `none`, logged as `provider_defaulted`. Before publication the owner runs one real model and the README shows it as the middle column.

## Consequences

- The demo shows a score nobody scripted (`none` 31.6% on the fixture) beside the scripted one (90.2%), on the same 133 mutants.
- A real target with no key still gets a map, tests, a `SPEC.md` and a score.
- Explicit `fake` without a fixture is `NO_PROVIDER`; explicit `openai-compatible` without a key is `LLM_AUTH`.
- The baseline is a floor built from the map alone, not a benchmark.

## Alternatives

- Always `fake`: fails on any target without a fixture.
- Always `none`: the demo would not exercise the LLM path at all.
- Only a real model: needs a key in CI and in the demo.
