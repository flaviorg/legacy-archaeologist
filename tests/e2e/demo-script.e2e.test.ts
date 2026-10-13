// scripts/demo.ts refusals that need no demo run (the demo itself runs only in tests/demo/demo.e2e.test.ts, D-12).
import test from "node:test";
import assert from "node:assert/strict";
import { runNode } from "../helpers/run-cli.ts";

test("demo --live without LLM_PROVIDER=openai-compatible and a key exits 1 with a USAGE line and runs nothing", async () => {
  const r = await runNode(["scripts/demo.ts", "--live"]);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stderr, "error: USAGE: --live needs LLM_PROVIDER=openai-compatible and LLM_API_KEY\n");
  assert.equal(r.stdout, "");
});

test("demo --live with the provider set but no key is refused the same way", async () => {
  const r = await runNode(["scripts/demo.ts", "--live"], { env: { LLM_PROVIDER: "openai-compatible" } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: USAGE: --live needs LLM_PROVIDER=openai-compatible and LLM_API_KEY$/m);
});

test("demo refuses an unknown option with a USAGE line", async () => {
  const r = await runNode(["scripts/demo.ts", "--fast"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: USAGE: Unknown option '--fast'.*usage: node scripts\/demo\.ts \[--live\]$/m);
});
