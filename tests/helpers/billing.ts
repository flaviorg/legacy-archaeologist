// The billing fixture's text and static map, built in-process for unit tests (no child process).
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import type { FunctionInfo, StaticMap } from "../../src/contracts/map.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";
import { buildMap } from "../../src/static/map.ts";

export const billingText: string = readFileSync(join(PROJECT_ROOT, "fixtures/legacy-billing/billing.js"), "utf8");

export const billingMap: StaticMap = buildMap([{ path: "billing.js", text: billingText }], "commonjs", {
  targetDir: "fixtures/legacy-billing",
  targetSha: "sha256:" + "0".repeat(64),
  builtinModules,
  fileSha256: { "billing.js": "0".repeat(64) },
  tool: { name: "legacy-archaeologist", version: "0.0.0" },
});

export function billingFn(name: string): FunctionInfo {
  const fn = billingMap.modules[0]!.functions.find((f) => f.name === name);
  if (!fn) throw new Error(`no billing function ${name}`);
  return fn;
}

// A synthetic function with the given parameters (no side effects, no magic numbers) for planner tests.
export function syntheticFn(params: string[], overrides: Partial<FunctionInfo> = {}): FunctionInfo {
  return { ...billingFn("roundMoney"), id: "t.js#f", name: "f", exportName: "f", params, callbackParam: null, style: "sync", magicNumbers: [], writesModuleState: [], ...overrides };
}
