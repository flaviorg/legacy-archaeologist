import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";
import { runNode } from "../helpers/run-cli.ts";

test("[SAFE-03] the child entry blocks loopback too", async () => {
  const entry = pathToFileURL(join(PROJECT_ROOT, "src/harness/child/net-guard-entry.ts")).href;
  const r = await runNode(["--import", entry, "-e", "try{fetch('http://127.0.0.1:9/')}catch(e){console.log(e.code)}"]);
  assert.match(r.stdout, /^NO_NETWORK$/m);
});

test("[REP-03] children started by runNode carry the guard and a minimal env", async () => {
  const r = await runNode(["-e", "try{fetch('https://example.com')}catch(e){console.log(e.code)};console.log(Object.keys(process.env).filter(k=>!k.startsWith('__CF')).sort().join(','))"], { env: { X_TEST: "1" } });
  assert.match(r.stdout, /NO_NETWORK/);
  assert.match(r.stdout, /^HOME,PATH,X_TEST$/m);
});
