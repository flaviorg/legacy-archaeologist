// The demo's full log (spec 10.2), printed after the hero and shown in the README's <details> block. Pure: every
// number comes from the artifacts of the three passes and the two verify reports; no wall time (the demo prints it
// on stderr, outside the golden-compared blocks).
import type { HypothesesFile } from "../contracts/hypotheses.ts";
import { SIDE_EFFECT_KINDS } from "../contracts/map.ts";
import type { StaticMap } from "../contracts/map.ts";
import type { MutationReport } from "../contracts/mutation.ts";
import { isCharacterized } from "../contracts/outcomes.ts";
import type { Outcome } from "../contracts/outcomes.ts";
import type { Prediction } from "../contracts/hypotheses.ts";
import type { SuspiciousBehavior } from "../contracts/report.ts";
import { formatArgs, formatOutcome, formatPrediction, formatTagged } from "../generate/format-value.ts";
import { SCRIPTED_CAVEAT, count, functionNameOf, pct, verifyCounts } from "./demo-hero.ts";
import type { DemoInput, PassArtifacts } from "./demo-hero.ts";
import type { VerifyReport } from "./verify.ts";

const LABEL_WIDTH = 24;
const INDENT = " ".repeat(LABEL_WIDTH);
const MAX_FAILURE_LINES = 5;
const MAX_LISTED_IDS = 3;

const label = (text: string): string => text.padEnd(LABEL_WIDTH);
const shortSha = (sha: string): string => sha.replace(/^sha256:/, "").slice(0, 12);

function byReason(reasons: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sorted.map(([r, n]) => `${r} ×${count(n)}`).join(", ");
}

/** `4 rejected (DUPLICATE ×3, ARITY ×1)`, or `0 rejected`. */
function withBreakdown(reasons: readonly string[], noun: string): string {
  return reasons.length === 0 ? `0 ${noun}` : `${count(reasons.length)} ${noun} (${byReason(reasons)})`;
}

function staticMapLines(map: StaticMap): string[] {
  const fns = map.modules.flatMap((m) => m.functions.filter((f) => f.exported));
  const callbacks = fns.filter((f) => f.style === "callback").length;
  const hotspots = map.hotspots.slice(0, 2).map((h) => `${functionNameOf(h.functionId)} (${count(h.complexity)})`);
  const effects = SIDE_EFFECT_KINDS.filter((k) => map.stats.sideEffects[k] > 0).map((k) => `${k} ×${count(map.stats.sideEffects[k])}`);
  return [
    `${label("[1/6] static map")}${count(fns.length)} exported functions · ${count(callbacks)} callback-style · hotspots: ${hotspots.length > 0 ? hotspots.join(", ") : "none"}`,
    `${INDENT}side effects: ${effects.length > 0 ? effects.join(", ") : "none"} · unresolved calls: ${count(map.stats.unresolvedCalls)}`,
  ];
}

function proposedInputs(h: HypothesesFile): number {
  return h.functions.reduce((n, f) => n + f.output.partitions.length + f.output.rules.reduce((p, r) => p + r.probes.length, 0), 0);
}

function round0Rejected(h: HypothesesFile): string[] {
  return h.rejected.filter((r) => r.origin !== "survivor-round").map((r) => r.reason);
}

function inputsLine(p: PassArtifacts): string {
  const h = p.hypotheses;
  const rejected = round0Rejected(h);
  if (h.provider === "none") {
    return `${label("[2/6] inputs")}baseline value table · 0 rules · ${count(proposedInputs(h))} derived inputs · ${withBreakdown(rejected, "rejected")}`;
  }
  const rules = h.functions.reduce((n, f) => n + f.output.rules.length, 0);
  return `${label("[2/6] hypotheses (LLM)")}${count(h.functions.length)} calls · ${count(rules)} rules · ${count(proposedInputs(h))} proposed inputs · ${withBreakdown(rejected, "rejected")}`;
}

function recordingLines(p: PassArtifacts, d: DemoInput, withChild: boolean): string[] {
  const cases = p.records.cases;
  const stable = cases.filter((c) => c.determinism === "stable").length;
  const unstable = cases.filter((c) => c.determinism === "unstable");
  const listed = unstable.slice(0, MAX_LISTED_IDS).map((c) => `${c.id}: ${c.instability && c.instability.step > 0 ? `step ${c.instability.step}` : "stateAfter"}`);
  const more = unstable.length > MAX_LISTED_IDS ? `, ${count(unstable.length - MAX_LISTED_IDS)} more` : "";
  const unstableText = unstable.length === 0 ? "0 unstable" : `${count(unstable.length)} unstable (${listed.join(", ")}${more})`;
  const other = p.report.notCharacterized.filter((n) => n.reason !== "unstable").map((n) => n.reason);
  const lines = [`${label("[3/6] recording")}${count(cases.length)} cases · run twice · ${count(stable)} stable · ${unstableText} · ${withBreakdown(other, "not characterized")}`];
  if (withChild) {
    const timeouts = cases.filter((c) => c.steps.some((s) => s.outcome.kind === "timeout")).length;
    const watchdog = ((d.caseTimeoutMs + d.watchdogMarginMs) / 1000).toFixed(1);
    lines.push(`${INDENT}child: --permission, net guard, fd 3 + nonce, watchdog ${watchdog} s per case · ${count(timeouts)} timeouts`);
  }
  return lines;
}

/** Valid mutants (status other than `error`) as comparable text; equal lists mean the same mutants. */
function validMutantKeys(m: MutationReport): string[] {
  return m.mutants.filter((x) => x.status !== "error").map((x) => `${x.id}|${x.file}|${x.line}|${x.column}|${x.operator}|${x.original}|${x.replacement}`);
}

function sameMutants(a: MutationReport, b: MutationReport): boolean {
  const ka = validMutantKeys(a);
  const kb = validMutantKeys(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

function round0Counts(m: MutationReport): { killed: number; timeout: number; survived: number; noCoverage: number; error: number } {
  const c = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, error: 0 };
  for (const x of m.mutants) {
    const status = x.roundKilled !== null && x.roundKilled > 0 ? "survived" : x.status;
    if (status === "killed") c.killed += 1;
    else if (status === "timeout") c.timeout += 1;
    else if (status === "survived") c.survived += 1;
    else if (status === "no-coverage") c.noCoverage += 1;
    else c.error += 1;
  }
  return c;
}

function mutationLines(p: PassArtifacts, compareWith: PassArtifacts | null): string[] {
  const m = p.mutation;
  const truncated = m.truncated > 0 ? ` · ${count(m.truncated)} truncated` : "";
  const valid = validMutantKeys(m).length;
  let first: string;
  if (compareWith !== null && sameMutants(m, compareWith.mutation)) {
    first = `${count(m.mutants.length)} mutants · ${count(m.invalid)} invalid${truncated} · same ${count(valid)} valid mutants as pass A`;
  } else {
    const ops = m.operators.map((op) => `${op} ${count(m.mutants.filter((x) => x.operator === op).length)}`);
    first = `${count(m.mutants.length)} mutants (${ops.join(", ")}) · ${count(m.invalid)} invalid${truncated}`;
  }
  const r0 = round0Counts(m);
  const score0 = m.rounds[0]?.scoreBefore ?? m.score.mutationScore;
  const error = r0.error > 0 ? ` · error ${count(r0.error)}` : "";
  const lines = [
    `${label("[4/6] mutation")}${first}`,
    `${INDENT}round 0: killed ${count(r0.killed)} · timeout ${count(r0.timeout)} · survived ${count(r0.survived)} · no-coverage ${count(r0.noCoverage)}${error} → mutation score ${pct(score0)}`,
  ];
  const who = p.hypotheses.provider === "fake" ? "LLM, scripted" : `LLM, ${p.hypotheses.model}`;
  m.rounds.forEach((r, i) => {
    const head = `round ${r.round} (${who}): `;
    lines.push(`${INDENT}${head}${count(r.survivorsConsidered.length)} survivors asked · ${count(r.inputsProposed)} inputs proposed · ${count(r.inputsAccepted)} accepted · recorded on the original code`);
    let tail = `${count(r.killed.length)} more killed → ${pct(r.scoreAfter)}`;
    if (i === m.rounds.length - 1) {
      const left = m.mutants.filter((x) => x.status === "survived").length;
      const flagged = m.mutants.filter((x) => x.llmSuggestedEquivalent !== null).length;
      tail += ` (${count(left)} survivors left, ${count(flagged)} flagged "likely equivalent" by the LLM, advisory)`;
    }
    lines.push(`${INDENT}${" ".repeat(head.length)}${tail}`);
  });
  return lines;
}

function testsLine(p: PassArtifacts): string {
  const tests = p.report.tests.reduce((n, t) => n + t.count, 0);
  const files = p.testFiles.length > 0 ? p.testFiles.join(" · ") : "no test file";
  return `${label("[5/6] tests + SPEC.md")}${count(tests)} tests → ${files} · SPEC.md ${count(p.specLines)} lines`;
}

function predictedText(p: Prediction): string {
  return p.kind === "returns" ? formatTagged(p.value) : formatPrediction(p);
}

function observedText(o: Outcome): string {
  return o.kind === "returned" ? formatTagged(o.value) : formatOutcome(o);
}

function sbLine(sb: SuspiciousBehavior, map: StaticMap): string {
  const module = map.modules.find((m) => m.functions.some((f) => f.id === sb.functionId));
  const fn = module?.functions.find((f) => f.id === sb.functionId);
  const where = module && fn ? ` (${module.file}:${fn.loc.startLine}-${fn.loc.endLine})` : "";
  const call = sb.args.map((args) => `${functionNameOf(sb.functionId)}${formatArgs(args)}`).join(" then ");
  return `${INDENT}${sb.id} ${call}: predicted ${predictedText(sb.predicted)}, observed ${observedText(sb.observed)}${where}`;
}

function rulesLines(p: PassArtifacts): string[] {
  if (p.hypotheses.provider === "none") return [`${label("[6/6] rules")}none (no LLM)`];
  const n = (s: string): number => p.report.rules.filter((r) => r.status === s).length;
  return [
    `${label("[6/6] rules")}${count(n("consistent"))} consistent · ${count(n("contradicted"))} contradicted · ${count(n("unverified"))} unverified`,
    ...p.report.suspicious.map((sb) => sbLine(sb, p.map)),
  ];
}

function passLines(p: PassArtifacts, d: DemoInput, opts: { sameMapAs: PassArtifacts | null; child: boolean }): string[] {
  const map =
    opts.sameMapAs !== null && opts.sameMapAs.map.targetSha === p.map.targetSha
      ? [`${label("[1/6] static map")}same map (sha256 ${shortSha(p.map.targetSha)})`]
      : staticMapLines(p.map);
  return [...map, inputsLine(p), ...recordingLines(p, d, opts.child), ...mutationLines(p, opts.sameMapAs), testsLine(p), ...rulesLines(p)];
}

function failureLine(f: { name: string; caseId: string | null; message: string }, width: number): string {
  const id = f.caseId === null ? f.name : `[${f.caseId}]`;
  const rest = f.caseId === null ? "" : f.name.slice(f.name.indexOf("]") + 1).trim();
  const origin = rest.includes(":") ? rest.slice(0, rest.indexOf(":")) : rest;
  const message = f.message.replace(/ {3}actual /, ", actual ");
  return `  ${id.padEnd(width)} ${origin} … ${message}`;
}

function verifyLines(d: DemoInput): string[] {
  const head = (r: VerifyReport): string => `verify --against ${r.target}`;
  const width = Math.max(head(d.verifyModern).length, head(d.verifyBroken).length) + 3;
  const line = (r: VerifyReport, expectFailures: boolean): string => {
    const c = verifyCounts(r);
    const mark = expectFailures ? (c.failed > 0 ? "✔ caught (expected)" : "✘ not caught") : c.failed === 0 ? "✔ behavior preserved on recorded cases" : "✘ behavior changed";
    return `${head(r).padEnd(width)}${count(c.tests)} tests · ${count(c.passed)} passed · ${count(c.failed)} failed   ${mark}`;
  };
  const failures = d.verifyBroken.files.flatMap((f) => f.failures);
  const shown = failures.slice(0, MAX_FAILURE_LINES);
  const idWidth = Math.max(0, ...shown.map((f) => (f.caseId === null ? f.name.length : f.caseId.length + 2)));
  const lines = [line(d.verifyModern, false), line(d.verifyBroken, true), ...shown.map((f) => failureLine(f, idWidth))];
  if (failures.length > shown.length) lines.push(`  … and ${count(failures.length - shown.length)} more in ${d.fake.outDir}/verify-broken.json`);
  return lines;
}

export function buildDemoSummary(d: DemoInput): string {
  const characterized = (p: PassArtifacts): number => p.records.cases.filter((c) => isCharacterized(c)).length;
  const sameAB = sameMutants(d.baseline.mutation, d.fake.mutation);
  const mutantsText = sameAB
    ? `same ${count(validMutantKeys(d.fake.mutation).length)} mutants`
    : `${count(validMutantKeys(d.baseline.mutation).length)} vs ${count(validMutantKeys(d.fake.mutation).length)} valid mutants`;
  const lines = [
    "",
    `legacy-archaeologist ${d.version} · demo · no network · clock ${new Date(d.world.clockNow).toISOString()} · seed ${d.world.seed}`,
    `target: ${d.baseline.map.targetDir} (${count(d.baseline.map.files.length)} file${d.baseline.map.files.length === 1 ? "" : "s"}, ${count(d.targetLines)} lines, sha256 ${shortSha(d.baseline.map.targetSha)})`,
    "",
    "── pass A · provider: none (no LLM; inputs derived from the static map) ──",
    ...passLines(d.baseline, d, { sameMapAs: null, child: false }),
    "",
    "── pass B · provider: fake (scripted) ──",
    ...passLines(d.fake, d, { sameMapAs: d.baseline, child: true }),
    "",
    ...verifyLines(d),
    "",
    `── pass C · ${d.thirdParty.map.targetDir} (${d.thirdPartyName}, ${d.thirdPartyLicense}, not written by the author) · provider: none (no LLM) ──`,
    ...passLines(d.thirdParty, d, { sameMapAs: null, child: false }),
    "",
    `mutation score · none ${pct(d.baseline.mutation.score.mutationScore)} · fake (${SCRIPTED_CAVEAT.split(";")[0]}) ${pct(d.fake.mutation.score.mutationScore)} · same formula, ${mutantsText}, ${count(characterized(d.baseline))} vs ${count(characterized(d.fake))} recorded cases`,
    `artifacts: ${d.baseline.outDir}/ · ${d.fake.outDir}/{map,hypotheses,records,mutation,report}.json · SPEC.md · tests/ · llm-trace.jsonl · ${d.thirdParty.outDir}/`,
  ];
  return lines.join("\n") + "\n";
}
