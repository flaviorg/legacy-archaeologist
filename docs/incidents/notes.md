# Incident notes

Only failures that really happened while building the project, with the symptom, the cause and the fix. Each also left a test or a note in `docs/api-notes.md`.

| Date | Symptom | Cause | Fix |
|---|---|---|---|
| 2026-10-13 | `git init` and `git status` failed with `permission denied` in the build shell | The interactive shell wraps `git` in a function (`__scmb_git`) that cannot run there | Used `command git` (`/usr/bin/git`); recorded in `docs/api-notes.md` |
| 2026-10-13 | A generated test file whose tests all passed exited 1 under `--test-force-exit` | `support.mts` replaced `process.exit` for the whole file, and the test runner calls `process.exit` itself to force the exit | `process.exit` is replaced only while a captured call runs (delta 55) |
| 2026-10-13 | Recording a looping test target under the `none` baseline ran for a very long time | The baseline passes the frozen clock's `Date` as an argument, and the loop counted up to it (about 1.7e12 iterations) | The looping function moved to its own target, `mutation-loop`, recorded with a hand-written case (delta 75) |
| 2026-10-13 | Two CLI tests took 69 s once mutation joined `run` | They ran the billing fixture through the whole pipeline only to check recording and the provider rule | They pass `--max-mutants 1 --max-rounds 0` (delta 85) |
| 2026-10-13 | The first `npm run regen` of the full demo goldens failed one test | The test comparing the hero's scores with the `mutation.json` goldens ran before the tests that write those goldens | The score test runs after the artifact golden tests, so one `regen` writes everything first (delta 92) |
| 2026-10-13 | The pending-marker scan failed on `specs/006-demo-and-repo/spec.md` | The REP-05 criterion, copied verbatim from the design, names the markers it forbids | The scan skips the REP-05 criterion line itself (delta 94) |
