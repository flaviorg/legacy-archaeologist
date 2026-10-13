# Research

Sources behind the README's claims and the design choices, with the date each was checked. One short phrase per source at most; nothing is copied.

| Source | Used for | Checked |
|---|---|---|
| Michael Feathers, *Working Effectively with Legacy Code* (2004), via secondary sources: https://www.infoq.com/news/2007/03/characterization-testing and https://daedtech.com/characterization-tests/ | The framing: legacy code as code without tests, and a characterization test as one that records what the code does rather than what it should do (the book itself was not consulted) | 2026-10-08 |
| Inozemtseva and Holmes, "Coverage Is Not Strongly Correlated with Test Suite Effectiveness", ICSE 2014: https://cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf | 31,000 generated suites for five Java systems; low to moderate correlation between coverage and mutation-based effectiveness once suite size is controlled. Caveat: Java systems, so the claim is about the general relationship | 2026-10-08 |
| Schäfer, Nadi, Eghbali and Tip, "An Empirical Evaluation of Using Large Language Models for Automated Unit Test Generation" (TestPilot), arXiv 2302.06527 | 25 npm packages, 70.2% median statement coverage with LLM-written tests whose expectations the model chose: a coverage number, not a measure of behavior capture | 2026-10-08 |
| "Mutation-Guided LLM-based Test Generation at Meta" (ACH), FSE Companion 2025, arXiv 2501.12862 | Mutation-guided LLM test generation in industry; its LLM equivalence detector's recall (0.47 before preprocessing) is why the equivalence flag here is advisory. ACH's results are not ours: it uses the LLM to create mutants | 2026-10-08 |
| Stryker docs, mutant states and metrics: https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/ and supported mutators: https://stryker-mutator.io/docs/mutation-testing-elements/supported-mutators/ | The score formula (timeouts detected, no-coverage in the denominator) and the operator-set comparison | 2026-10-08 |
| StrykerJS TAP runner: https://stryker-mutator.io/docs/stryker-js/tap-runner/ | Positioning: Stryker can run `node:test` files, so a cross-check recipe is possible future work | 2026-10-08 |
| Node.js docs, permissions: https://nodejs.org/api/permissions.html | The permission model as a seat belt, stable in Node 24; network not restricted on the pinned 24.21 (verified locally) | 2026-10-08 |
| Node.js docs, `node:vm`: https://nodejs.org/api/vm.html | `node:vm` is not a security mechanism, so the harness uses a child process | 2026-10-08 |
| Node.js docs, test runner: https://nodejs.org/api/test.html | `mock.timers` for `Date`, the TAP reporter, coverage still experimental | 2026-10-08 |
| Diffblue Cover: https://www.diffblue.com and https://docs.diffblue.com/get-started | The closest conceptual predecessor (vendor claims, not verified) | 2026-10-08 |
| Pythagora: https://github.com/Pythagora-io/pythagora | The closest JavaScript predecessor; deprecated in favor of GPT Pilot per its README | 2026-10-12 |
| Keploy: https://github.com/keploy/keploy | Network-level record and replay, for the comparison | 2026-10-12 |
| TestPilot repository: https://github.com/githubnext/testpilot | Archived 2025-02-03 | 2026-10-08 |
| Qodo Cover: https://github.com/qodo-ai/qodo-cover | Marked no longer maintained | 2026-10-08 |
| CoverUp, arXiv 2403.16218 | Coverage-guided LLM tests for Python, for the comparison | 2026-10-08 |
| Mutahunter: https://github.com/codeintegrity-ai/mutahunter | LLM-created mutants, for the comparison | 2026-10-08 |
| `bytes@3.1.2` on npm (MIT) | The second target the author did not write; vendored unmodified with its license (`fixtures/third-party/bytes/VENDORED.md`) | 2026-10-13 |

Not claimed: no reliable, citable statistic was found for the share of untested legacy code or the cost of maintaining it, so the README states none.
