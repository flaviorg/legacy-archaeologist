// The demo's hero block (spec 1.3 item 3): at most 12 lines, printed first by scripts/demo.ts and pasted into the
// README by `npm run regen`. Pure: every value is read from the artifacts of the three passes and the two verify
// reports, never typed by hand.
import type { HypothesesFile } from "../contracts/hypotheses.ts";
import type { StaticMap } from "../contracts/map.ts";
import type { MutationReport } from "../contracts/mutation.ts";
import { isCharacterized } from "../contracts/outcomes.ts";
import type { RecordsFile } from "../contracts/records.ts";
import type { ReportFile } from "../contracts/report.ts";
import { formatOutcome, formatTagged } from "../generate/format-value.ts";
import type { VerifyReport } from "./verify.ts";

export type PassArtifacts = {
  outDir: string; // project-relative, POSIX
  map: StaticMap;
  hypotheses: HypothesesFile;
  records: RecordsFile;
  mutation: MutationReport;
  report: ReportFile;
  testFiles: string[]; // project-relative, POSIX
  specLines: number;
};

export type DemoInput = {
  version: string;
  world: { clockNow: number; seed: number };
  caseTimeoutMs: number;
  watchdogMarginMs: number;
  /** Line count of the fixture's source files (the map stores bytes, not lines). */
  targetLines: number;
  baseline: PassArtifacts;
  fake: PassArtifacts;
  thirdParty: PassArtifacts;
  thirdPartyName: string; // "bytes@3.1.2"
  thirdPartyLicense: string; // "MIT"
  verifyModern: VerifyReport;
  verifyBroken: VerifyReport;
};

// An author choice: the fixture's negative late fee for early payment is the most legible quirk for a first read,
// so the hero features the first suspicious behavior of lateFee (said in the README too).
const HERO_FEATURED_FUNCTION = "billing.js#lateFee";

export const SCRIPTED_CAVEAT = "scripted: author-written survivor inputs; proves the loop, not the model";

export const count = (n: number): string => n.toLocaleString("en-US");
export const pct = (n: number): string => `${n.toFixed(1)}%`;

/** `billing.js#applyDiscount#c01` → `applyDiscount`; `billing.js#lateFee` → `lateFee`. */
export function functionNameOf(id: string): string {
  return id.split("#")[1] ?? id;
}

export function verifyCounts(r: VerifyReport): { tests: number; passed: number; failed: number } {
  return r.files.reduce((acc, f) => ({ tests: acc.tests + f.tests, passed: acc.passed + f.passed, failed: acc.failed + f.failed }), { tests: 0, passed: 0, failed: 0 });
}

function exportedFunctions(map: StaticMap): number {
  return map.modules.reduce((n, m) => n + m.functions.filter((f) => f.exported).length, 0);
}

function featuredLine(d: DemoInput): string | null {
  const sb = d.fake.report.suspicious.find((s) => s.functionId === HERO_FEATURED_FUNCTION);
  if (!sb) return null;
  const observed = sb.observed.kind === "returned" ? `returns ${formatTagged(sb.observed.value)}` : formatOutcome(sb.observed);
  const credit = sb.observed.kind === "returned" && typeof sb.observed.value === "number" && sb.observed.value < 0 ? " (a credit)" : "";
  return `  ✔ ${functionNameOf(sb.functionId)} ${sb.probeLabel} ${observed}${credit}: flagged as ${sb.id}, not fixed`;
}

function brokenLine(d: DemoInput): string {
  const failures = d.verifyBroken.files.flatMap((f) => f.failures);
  const names: string[] = [];
  for (const f of failures) {
    const name = f.caseId === null ? f.name : functionNameOf(f.caseId);
    if (!names.includes(name)) names.push(name);
  }
  const broken = verifyCounts(d.verifyBroken);
  const modern = verifyCounts(d.verifyModern);
  return `  ✔ the broken refactor fails ${count(broken.failed)} recorded cases (${names.join(", ")}); the modern one passes all ${count(modern.passed)}`;
}

function thirdPartyLine(d: DemoInput): string {
  const p = d.thirdParty;
  const stable = p.records.cases.filter((c) => isCharacterized(c)).length;
  return `${d.thirdPartyName}, code we did not write, no LLM: ${count(exportedFunctions(p.map))} functions · ${count(stable)} stable cases · mutation score ${pct(p.mutation.score.mutationScore)} · ${count(p.mutation.score.survived)} surviving mutants`;
}

export function buildHero(d: DemoInput): string {
  const lines = [
    `legacy-archaeologist ${d.version} · demo · no network · no key`,
    `${d.baseline.map.targetDir} is a fixture we wrote with known quirks; the tool flags them without being told where they are:`,
    featuredLine(d),
    brokenLine(d),
    thirdPartyLine(d),
    `mutation score on the fixture · none ${pct(d.baseline.mutation.score.mutationScore)} · fake ${pct(d.fake.mutation.score.mutationScore)} (${SCRIPTED_CAVEAT})`,
    `artifacts: ${d.fake.outDir}/SPEC.md · ${d.fake.outDir}/tests/ · ${d.fake.outDir}/llm-trace.jsonl · ${d.thirdParty.outDir}/SPEC.md`,
  ].filter((l): l is string => l !== null);
  return lines.join("\n") + "\n";
}
