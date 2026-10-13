// The living SPEC.md (spec 5.11, GEN-03). Pure: text from the map, the hypotheses, the records and the report.
// Every string that came from the LLM (statements, notes, labels, proposed inputs, predictions) goes through escapeMd
// or into a code span; LLM fields are labeled as such.
import type { HypothesesFile } from "../contracts/hypotheses.ts";
import type { FunctionInfo, ModuleInfo, SideEffectKind, StaticMap } from "../contracts/map.ts";
import type { MutationReport } from "../contracts/mutation.ts";
import { isCharacterized } from "../contracts/outcomes.ts";
import type { Outcome } from "../contracts/outcomes.ts";
import type { CaseId, RecordedCase, RecordsFile } from "../contracts/records.ts";
import type { EvaluatedProbe, EvaluatedRule, NotCharacterized, ReportFile } from "../contracts/report.ts";
import type { Tagged } from "../contracts/tagged.ts";
import { escapeMd, formatArgs, formatOutcome, formatPrediction, formatTagged } from "./format-value.ts";

export type SpecInput = {
  map: StaticMap;
  hypotheses: HypothesesFile;
  records: RecordsFile;
  report: ReportFile;
  mutation: MutationReport | null;
  testLinks: Record<CaseId, { file: string; line: number }>;  // file relative to the directory of SPEC.md
  world: { clockNow: number; seed: number };
};

const SANDBOX_CODES = ["NO_NETWORK", "ERR_ACCESS_DENIED"];
const CONSISTENT_CAVEAT = "A rule is *consistent* when every probe the model chose for it matched the recorded outcome; it covers those probes and nothing more.";
const SAME_FORMULA = "Same formula as Stryker so the definitions match; the scores are not comparable because the operator sets differ.";

const count = (n: number): string => n.toLocaleString("en-US");
const percent = (score: number): string => `${score.toFixed(1)}%`;

export function providerLabel(h: Pick<HypothesesFile, "provider" | "model" | "scenario">): string {
  if (h.provider === "fake") return h.scenario ? `provider: fake (scripted) · scenario ${h.scenario}` : "provider: fake (scripted)";
  if (h.provider === "none") return "provider: none (no LLM)";
  return `provider: openai-compatible (${h.model})`;
}

function sandboxCode(value: Tagged): string | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const code = sandboxCode(v);
      if (code) return code;
    }
    return null;
  }
  const rec = value as Record<string, Tagged>;
  const tag = typeof rec.$t === "string" ? rec.$t : undefined;
  if (tag === "Error") {
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && SANDBOX_CODES.includes(code) ? code : null;
  }
  if (tag === "object") return sandboxCode(Object.values(rec.v as Record<string, Tagged>));
  if (tag !== undefined) return null;
  return sandboxCode(Object.values(rec));
}

function outcomeSandboxCode(o: Outcome): string | null {
  switch (o.kind) {
    case "returned":
    case "threw":
    case "promise": return sandboxCode(o.value);
    case "callback": return sandboxCode(o.args);
    default: return null;
  }
}

/** Every recorded case the emitter leaves out, with the reason (GEN-04), in records order. */
export function listNotCharacterized(cases: readonly RecordedCase[]): NotCharacterized[] {
  const out: NotCharacterized[] = [];
  for (const c of cases) {
    if (isCharacterized(c)) continue;
    if (c.determinism === "unstable") {
      const step = c.instability?.step ?? 1;
      out.push({ caseId: c.id, reason: "unstable", detail: step === 0 ? "stateAfter differed between two runs" : `step ${step} differed between two runs` });
      continue;
    }
    for (const s of c.steps) {
      const o = s.outcome;
      if (o.kind === "timeout") {
        if (o.reason === "leaked-error") out.push({ caseId: c.id, reason: "leaked-error", detail: "an uncaught error or unhandled rejection surfaced while the case ran" });
        else out.push({ caseId: c.id, reason: "timeout", detail: o.reason ?? "" });
        break;
      }
      if (o.kind === "no-callback") {
        out.push({ caseId: c.id, reason: "no-callback", detail: "" });
        break;
      }
      const code = outcomeSandboxCode(o);
      if (code) {
        out.push({ caseId: c.id, reason: "sandbox-only outcome", detail: code });
        break;
      }
    }
  }
  return out;
}

function notCharacterizedText(n: NotCharacterized): string {
  switch (n.reason) {
    case "unstable": return `unstable: ${n.detail}`;
    case "timeout": return n.detail ? `timeout (${n.detail})` : "timeout";
    case "leaked-error": return `leaked error: ${n.detail}`;
    case "no-callback": return "no callback within the case timeout";
    case "sandbox-only outcome": return `sandbox-only outcome (${n.detail})`;
    default: return n.reason;
  }
}

// A code span whose fence is longer than any backtick run inside it.
function code(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

function linkTarget(file: string): string {
  return file.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function moduleKindLabel(kind: ModuleInfo["kind"]): string {
  return kind === "cjs" ? "CommonJS" : kind === "esm" ? "ESM" : "unknown module kind";
}

function sourceText(file: string, fn: FunctionInfo, relatedConstants: readonly number[]): string {
  const parts = [`${file}:${fn.loc.startLine}-${fn.loc.endLine}`];
  for (const value of relatedConstants) {
    const hit = fn.magicNumbers.find((m) => Object.is(m.value, value));
    if (hit) parts.push(`constant ${String(value)} at line ${hit.line}`);
  }
  return parts.join("; ");
}

function inputsText(args: readonly Tagged[][]): string {
  return args.length === 1 ? formatArgs(args[0] as Tagged[]) : args.map((a) => formatArgs(a)).join(" then ");
}

function observedText(o: Outcome): string {
  return o.kind === "returned" ? formatTagged(o.value) : formatOutcome(o);
}

function probeText(p: EvaluatedProbe): string {
  let text = `${inputsText(p.args)} → ${p.observed === null ? "not recorded" : observedText(p.observed)}`;
  if (p.observed !== null && p.matched === null && p.prediction.kind !== "unknown") text += " (not characterized)";
  if (p.prediction.kind === "unknown") text += " (prediction unknown)";
  else if (p.matched === false) text += ` (predicted ${p.prediction.kind === "returns" ? formatTagged(p.prediction.value) : formatPrediction(p.prediction)})`;
  return text;
}

function caseLabel(caseId: string): string {
  return caseId.split("#").at(-1) ?? caseId;
}

function ruleRow(rule: EvaluatedRule, sbIds: string[], file: string, fn: FunctionInfo, testLinks: SpecInput["testLinks"]): string {
  const status = rule.status === "consistent"
    ? `consistent (${count(rule.probesChecked)} probe${rule.probesChecked === 1 ? "" : "s"})`
    : rule.status === "contradicted" ? `**contradicted** → ${sbIds.join(", ")}` : "unverified";
  const probes = rule.probes.length === 0 ? "none" : escapeMd(rule.probes.map((p) => probeText(p)).join(" · "));
  const caseIds = [...new Set(rule.probes.flatMap((p) => (p.caseId !== null && testLinks[p.caseId] ? [p.caseId] : [])))];
  const evidence = caseIds.length === 0 ? "none" : caseIds.map((id) => {
    const link = testLinks[id] as { file: string; line: number };
    return `[${escapeMd(caseLabel(id))}](${linkTarget(link.file)}#L${link.line})`;
  }).join(", ");
  return `| ${rule.ruleId} | ${escapeMd(rule.statement)} | ${status} | ${probes} | ${evidence} | ${escapeMd(sourceText(file, fn, rule.relatedConstants))} |`;
}

function listOrNone(items: string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
}

function moduleLine(mod: ModuleInfo): string {
  const state = mod.moduleState.map((s) => {
    const writers = mod.functions.filter((f) => f.writesModuleState.includes(s.name)).map((f) => escapeMd(f.name));
    return `${code(s.name)} (line ${s.line}${writers.length > 0 ? `, written by ${writers.join(", ")}` : ""})`;
  });
  const globals = mod.functions.flatMap((f) => f.writesGlobals.map((g) => {
    const effect = f.sideEffects.find((e) => e.kind === "global-write" && e.detail === g);
    return `${code(g)} (${escapeMd(f.name)}${effect ? `, line ${effect.line}` : ""})`;
  }));
  const unresolved = mod.functions.reduce((n, f) => n + f.calls.filter((c) => c.dynamic).length, 0);
  return `Module state: ${listOrNone(state)}. Globals written: ${listOrNone(globals)}. Unresolved calls: ${count(unresolved)}.`;
}

function functionHeading(mod: ModuleInfo, fn: FunctionInfo, hotspots: StaticMap["hotspots"]): string {
  const rank = hotspots.findIndex((h) => h.functionId === fn.id);
  const hot = rank >= 0 ? ` · hotspot #${rank + 1}` : "";
  return `### ${escapeMd(fn.name)}(${fn.params.map((p) => escapeMd(p)).join(", ")}) — ${escapeMd(mod.file)}:${fn.loc.startLine}-${fn.loc.endLine} · complexity ${fn.complexity}${hot}`;
}

function functionFacts(fn: FunctionInfo): string {
  const effects = fn.sideEffects.map((e) => `${escapeMd(e.kind)} (line ${e.line})`);
  const magic = fn.magicNumbers.map((m) => `${String(m.value)} (line ${m.line})`);
  const reads = fn.readsModuleState.map((r) => code(r));
  return `Side effects: ${listOrNone(effects)}. Magic numbers: ${listOrNone(magic)}. Module state read: ${listOrNone(reads)}.`;
}

function mutantsLine(fn: FunctionInfo, mutation: MutationReport): string {
  const ms = mutation.mutants.filter((m) => m.functionId === fn.id);
  const by = (s: string): number => ms.filter((m) => m.status === s).length;
  return `Mutants in this function: ${count(ms.length)} (killed ${count(by("killed"))}, timeout ${count(by("timeout"))}, survived ${count(by("survived"))}, no coverage ${count(by("no-coverage"))}).`;
}

function functionSection(mod: ModuleInfo, fn: FunctionInfo, input: SpecInput): string[] {
  const out = [functionHeading(mod, fn, input.map.hotspots), "", functionFacts(fn)];
  const notes = input.hypotheses.functions.find((h) => h.functionId === fn.id)?.output.notes;
  if (notes !== undefined && notes.trim() !== "") out.push("", `Archaeologist notes (LLM, unverified prose): "${escapeMd(notes)}"`);
  const rules = input.report.rules.filter((r) => r.functionId === fn.id);
  out.push("");
  if (rules.length === 0) {
    out.push(input.hypotheses.provider === "none" ? "No rules: provider none derives inputs from the static map only." : "No rules were proposed for this function.");
  } else {
    out.push("| Rule | Statement (LLM hypothesis) | Status | Probes (inputs → observed) | Evidence (tests) | Source |", "|---|---|---|---|---|---|");
    for (const rule of rules) {
      const sbIds = input.report.suspicious.filter((s) => s.functionId === fn.id && s.ruleId === rule.ruleId).map((s) => s.id);
      out.push(ruleRow(rule, sbIds, mod.file, fn, input.testLinks));
    }
  }
  if (input.mutation) out.push("", mutantsLine(fn, input.mutation));
  return out;
}

function summary(input: SpecInput): string[] {
  const fns = input.map.modules.flatMap((m) => m.functions).filter((f) => f.exported);
  const rules = input.report.rules;
  const by = (s: string): number => rules.filter((r) => r.status === s).length;
  const tests = input.report.tests.reduce((n, t) => n + t.count, 0);
  const score = input.report.mutation ? `${percent(input.report.mutation.mutationScore)} (${count(input.report.mutation.detected)}/${count(input.report.mutation.valid)})` : "not measured";
  return [
    "## Summary",
    "",
    "| Modules | Exported functions | Cases recorded | Tests emitted | Rules | Consistent | Contradicted | Unverified | Mutation score | Suspicious behaviors |",
    "|---|---|---|---|---|---|---|---|---|---|",
    `| ${count(input.map.modules.length)} | ${count(fns.length)} | ${count(input.records.cases.length)} | ${count(tests)} | ${count(rules.length)} | ${count(by("consistent"))} | ${count(by("contradicted"))} | ${count(by("unverified"))} | ${score} | ${count(input.report.suspicious.length)} |`,
    "",
    CONSISTENT_CAVEAT,
  ];
}

function mutationSection(mutation: MutationReport): string[] {
  const s = mutation.score;
  const out = [
    "## Mutation score",
    "",
    `Mutation score: ${percent(s.mutationScore)} (${count(s.detected)}/${count(s.valid)} detected): killed ${count(s.killed)}, timeout ${count(s.timeout)}, survived ${count(s.survived)}, no coverage ${count(s.noCoverage)}, error ${count(s.error)}; ${count(mutation.invalid)} invalid mutants dropped, ${count(mutation.truncated)} truncated. ${SAME_FORMULA}`,
    "",
    "| Operator | Killed | Timeout | Survived | No coverage | Score |",
    "|---|---|---|---|---|---|",
  ];
  for (const op of mutation.operators) {
    const o = s.byOperator[op];
    if (o) out.push(`| ${op} | ${count(o.killed)} | ${count(o.timeout)} | ${count(o.survived)} | ${count(o.noCoverage)} | ${percent(o.mutationScore)} |`);
  }
  const survivors = mutation.mutants.filter((m) => m.status === "survived" || m.status === "no-coverage");
  out.push("");
  if (survivors.length === 0) {
    out.push("No mutant survived.");
  } else {
    out.push("Survivors:", "", "| Mutant | Function | Operator | Line | Change | Note |", "|---|---|---|---|---|---|");
    for (const m of survivors) {
      const notes = [m.status === "no-coverage" ? "no characterized case covers this function" : "", m.llmSuggestedEquivalent ? `LLM suggests equivalent (advisory): ${m.llmSuggestedEquivalent.reason}` : ""].filter((x) => x !== "");
      out.push(`| ${m.id} | ${escapeMd(m.functionId.split("#").at(-1) ?? m.functionId)} | ${m.operator} | ${m.line} | ${escapeMd(`${m.original} → ${m.replacement}`)} | ${escapeMd(notes.join("; "))} |`);
    }
  }
  return out;
}

function suspiciousSection(input: SpecInput, fnById: Map<string, { mod: ModuleInfo; fn: FunctionInfo }>): string[] {
  const out = ["## Suspicious behaviors (human review required; nothing was changed)"];
  if (input.report.suspicious.length === 0) return [...out, "", "None: no probe contradicted the recorded behavior."];
  for (const sb of input.report.suspicious) {
    const found = fnById.get(sb.functionId);
    const name = found?.fn.name ?? sb.functionId.split("#").at(-1) ?? sb.functionId;
    const last = sb.args.at(-1) ?? [];
    const step = sb.args.length > 1 ? ` (step ${sb.args.length} of ${sb.args.length})` : "";
    const rule = input.report.rules.find((r) => r.functionId === sb.functionId && r.ruleId === sb.ruleId);
    const source = found ? sourceText(found.mod.file, found.fn, rule?.relatedConstants ?? []) : sb.functionId;
    const link = input.testLinks[sb.caseId];
    const pin = link ? `[${escapeMd(sb.caseId)}](${linkTarget(link.file)}#L${link.line})` : `${escapeMd(sb.caseId)} (not emitted)`;
    out.push(
      "",
      `### ${sb.id} · ${escapeMd(sb.functionId)} · ${sb.ruleId}`,
      "",
      `- Hypothesis (LLM): ${escapeMd(sb.statement)}`,
      `- Predicted for ${code(`${name}${formatArgs(last)}`)}${step}: ${escapeMd(formatPrediction(sb.predicted))}.`,
      `- Observed (recorded, run twice, stable): ${escapeMd(formatOutcome(sb.observed))}.`,
      `- Source: ${escapeMd(source)}.`,
      `- Test that pins the observed behavior: ${pin}.`,
      "- Note: the tool records what the code does. Decide with the business whether this behavior is intended; if you change it, this test is the one that must change.",
    );
  }
  return out;
}

function handling(kind: SideEffectKind, world: SpecInput["world"]): string {
  switch (kind) {
    case "Date": return `frozen at ${new Date(world.clockNow).toISOString()}`;
    case "Math.random": return `seeded (seed ${world.seed}) in recording and in the tests; in production it varies`;
    case "performance.now":
    case "process.hrtime": return "counters advancing 1 ms per call";
    case "crypto": return "seeded fills (randomUUID, randomBytes, getRandomValues); createHash untouched";
    case "process.env": return "scrubbed to TZ, LANG, LC_ALL, NODE_OPTIONS and PATH";
    case "console": return "captured and counted, not asserted";
    case "timers": return "real timers, bounded by the case timeout";
    case "Intl": return "not stubbed (TZ=UTC, LANG=C)";
    case "fs": return "writes blocked (records threw); reads inside the target work";
    case "child_process":
    case "net":
    case "http":
    case "dns": return "blocked (records threw)";
    case "global-write": return "detected; not asserted";
    case "module-state-write": return "seen through later calls and exported values (stateAfter)";
    default: return "not stubbed";
  }
}

function sideEffectsSection(input: SpecInput): string[] {
  const rows = input.map.modules.flatMap((m) => m.functions.flatMap((f) => f.sideEffects.map((e) => `| ${escapeMd(f.name)} | ${escapeMd(`${e.kind}: ${e.detail} (line ${e.line})`)} | ${handling(e.kind, input.world)} |`)));
  const out = ["## Side effects by function", ""];
  if (rows.length === 0) return [...out, "No side effects were detected."];
  return [...out, "| Function | Source | Handling |", "|---|---|---|", ...rows];
}

export function writeSpec(input: SpecInput): string {
  const { map, hypotheses } = input;
  const fnById = new Map(map.modules.flatMap((mod) => mod.functions.map((fn) => [fn.id, { mod, fn }] as const)));
  const shaHex = map.targetSha.replace(/^sha256:/, "").slice(0, 12);
  const blocks: string[][] = [
    [`# Living spec: ${escapeMd(map.targetDir)}`, "", `Generated by legacy-archaeologist ${input.report.tool.version} · target sha256 ${shaHex} · ${escapeMd(providerLabel(hypotheses))} · clock ${new Date(input.world.clockNow).toISOString()} · seed ${input.world.seed}`],
    summary(input),
  ];
  for (const mod of map.modules) {
    blocks.push([`## Module ${escapeMd(mod.file)} (${moduleKindLabel(mod.kind)})`, "", moduleLine(mod)]);
    for (const fn of mod.functions) blocks.push(functionSection(mod, fn, input));
  }
  if (input.mutation) blocks.push(mutationSection(input.mutation));
  blocks.push(suspiciousSection(input, fnById));
  const nc = input.report.notCharacterized;
  blocks.push(nc.length === 0
    ? ["## Not characterized", "", "Every recorded case is characterized."]
    : ["## Not characterized", "", "| Case | Reason |", "|---|---|", ...nc.map((n) => `| ${escapeMd(n.caseId)} | ${notCharacterizedText(n)} |`)]);
  if (input.report.loadErrors.length > 0) {
    blocks.push(["## Modules not recorded", "", "| Module | Code | Error |", "|---|---|---|", ...input.report.loadErrors.map((e) => `| ${escapeMd(e.module)} | ${e.code} | ${escapeMd(e.error)} |`)]);
  }
  blocks.push(sideEffectsSection(input));
  return blocks.map((b) => b.join("\n")).join("\n\n") + "\n";
}
