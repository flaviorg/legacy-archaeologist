// The test emitter (spec 4.4, 5.11). Pure. It sees the static map's module and the recorded cases, nothing else
// (dependency rule 8): every expected value it writes is the literal recorded Outcome, never a prediction (HYP-05).
import type { FunctionInfo, ModuleInfo } from "../contracts/map.ts";
import { isCharacterized } from "../contracts/outcomes.ts";
import type { Outcome } from "../contracts/outcomes.ts";
import type { CaseId, RecordedCase, RecordedStep } from "../contracts/records.ts";
import type { Tagged } from "../contracts/tagged.ts";

export type EmitInput = {
  module: ModuleInfo;
  cases: RecordedCase[];
  moduleRelNoExt: string;   // POSIX path from the tests directory to the module, without extension
  targetDir: string;        // project-relative, for the header
  clockNow: number;
  seed: number;
  caseTimeoutMs: number;
  version: string;
  targetSha: string;
};

const MAX_LABEL = 120;
const INDENT = "  ";
// The support names in the order the import line lists them; only the names a file uses are imported.
const SUPPORT_NAMES = ["configureWorld", "loadFresh", "capture", "captureAsync", "captureCallback", "revive", "outcomesEqual", "taggedEqual", "stateAfterOf", "describeOutcome"] as const;
type SupportName = (typeof SUPPORT_NAMES)[number];
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Printable ASCII, trimmed, at most 120 characters (GEN-02). */
function sanitizeTestLabel(label: string): string {
  return label.replace(/[^\x20-\x7E]/g, "").trim().slice(0, MAX_LABEL);
}

function originText(c: RecordedCase): string {
  switch (c.origin) {
    case "rule-probe": return c.ruleRefs.length > 0 ? `probe ${c.ruleRefs.join(", ")}` : "probe";
    case "partition": return "partition";
    case "baseline": return "baseline";
    case "boundary-expansion": return c.expandsCase ? `boundary of ${c.expandsCase}` : "boundary";
    case "survivor-round": return c.mutantRef ? `survivor ${c.mutantRef}` : "survivor";
    default: return "case";
  }
}

/** `[<caseId>] <origin>: <label>`; the rule statement never appears here (LLM-03). */
function testName(c: RecordedCase): string {
  return `[${c.id}] ${originText(c)}: ${sanitizeTestLabel(c.label)}`;
}

function caseNumber(id: CaseId): number {
  const m = /#c(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function someNode(value: unknown, test: (obj: object) => boolean): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some((v) => someNode(v, test));
  if (test(value)) return true;
  return Object.keys(value).some((k) => someNode((value as Record<string, unknown>)[k], test));
}

const hasProtoKey = (value: unknown): boolean => someNode(value, (o) => Object.hasOwn(o, "__proto__"));
const hasTagKey = (value: unknown): boolean => someNode(value, (o) => Object.hasOwn(o, "$t"));

// A JSON literal, or JSON.parse of its text when a "__proto__" key would turn into a prototype in an object literal.
function literal(value: unknown): string {
  const json = JSON.stringify(value);
  return hasProtoKey(value) ? `JSON.parse(${JSON.stringify(json)})` : json;
}

function argText(arg: Tagged, uses: Set<SupportName>): string {
  if (!hasTagKey(arg) && !hasProtoKey(arg)) return JSON.stringify(arg);
  uses.add("revive");
  return `revive(${literal(arg)})`;
}

function calleeText(exportName: string): string {
  if (exportName === "default") return "m.default";
  return IDENTIFIER.test(exportName) ? `m.${exportName}` : `m[${JSON.stringify(exportName)}]`;
}

function callbackIndexOf(fn: FunctionInfo | undefined, c: RecordedCase): number | null {
  if (!fn || c.style !== "callback" || fn.callbackParam === null) return null;
  const index = fn.params.indexOf(fn.callbackParam);
  return index >= 0 ? index : null;
}

function callText(c: RecordedCase, step: RecordedStep, cbIndex: number | null, timeoutMs: number, uses: Set<SupportName>): string {
  const args = step.args.map((a) => argText(a, uses));
  const callee = calleeText(c.exportName);
  if (cbIndex !== null) {
    uses.add("captureCallback");
    while (args.length < cbIndex) args.push("undefined");
    args.splice(cbIndex, 0, "cb");
    return `await captureCallback((cb) => ${callee}(${args.join(", ")}), ${timeoutMs})`;
  }
  if (step.outcome.kind === "promise") {
    uses.add("captureAsync");
    return `await captureAsync(() => ${callee}(${args.join(", ")}), ${timeoutMs})`;
  }
  uses.add("capture");
  return `capture(() => ${callee}(${args.join(", ")}))`;
}

// The recorded Outcome with its fields in a fixed order (kind first); the tagged values inside keep their order.
function outcomeValue(o: Outcome): unknown {
  switch (o.kind) {
    case "returned":
    case "threw": return { kind: o.kind, value: o.value };
    case "callback": return { kind: o.kind, args: o.args };
    case "promise": return { kind: o.kind, status: o.status, value: o.value };
    case "timeout": return o.reason ? { kind: o.kind, reason: o.reason } : { kind: o.kind };
    default: return { kind: o.kind };
  }
}

function testBody(c: RecordedCase, fn: FunctionInfo | undefined, timeoutMs: number, uses: Set<SupportName>): string[] {
  const cbIndex = callbackIndexOf(fn, c);
  const lines = [`${INDENT}const m = await loadFresh(MODULE_REL, MODULE_NAME, import.meta.url);`];
  uses.add("outcomesEqual");
  uses.add("describeOutcome");
  if (c.steps.length === 1) {
    const step = c.steps[0] as RecordedStep;
    lines.push(`${INDENT}const actual = ${callText(c, step, cbIndex, timeoutMs, uses)};`);
    lines.push(`${INDENT}const expected = ${literal(outcomeValue(step.outcome))};`);
    lines.push(`${INDENT}assert.ok(outcomesEqual(actual, expected), describeOutcome(expected, actual));`);
  } else {
    lines.push(`${INDENT}const actual = [`);
    for (const step of c.steps) lines.push(`${INDENT}${INDENT}${callText(c, step, cbIndex, timeoutMs, uses)},`);
    lines.push(`${INDENT}];`);
    lines.push(`${INDENT}const expected = ${literal(c.steps.map((s) => outcomeValue(s.outcome)))};`);
    lines.push(`${INDENT}actual.forEach((a, i) => assert.ok(outcomesEqual(a, expected[i]), describeOutcome(expected[i], a, i)));`);
  }
  if (c.stateAfter !== null) {
    uses.add("taggedEqual");
    uses.add("stateAfterOf");
    lines.push(`${INDENT}assert.ok(taggedEqual(stateAfterOf(m), ${literal(c.stateAfter)}), "stateAfter differs");`);
  }
  return lines;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ");
}

/**
 * One node:test file for one module: only characterized cases (GEN-04), ordered by the module's function order and
 * then case number; `testLines` maps each emitted case to the 1-based line of its `test(` call.
 */
export function emitTests(input: EmitInput): { testFile: string; testLines: Record<CaseId, number> } {
  const functions = new Map(input.module.functions.map((f, i) => [f.id, { fn: f, rank: i }] as const));
  const rankOf = (c: RecordedCase): number => functions.get(c.functionId)?.rank ?? Number.MAX_SAFE_INTEGER;
  const cases = input.cases
    .filter((c) => c.moduleFile === input.module.file && isCharacterized(c))
    .sort((a, b) => rankOf(a) - rankOf(b) || (a.functionId < b.functionId ? -1 : a.functionId > b.functionId ? 1 : 0) || caseNumber(a.id) - caseNumber(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const uses = new Set<SupportName>(["configureWorld", "loadFresh"]);
  const blocks = cases.map((c) => ({ c, lines: [`test(${JSON.stringify(testName(c))}, async () => {`, ...testBody(c, functions.get(c.functionId)?.fn, input.caseTimeoutMs, uses), "});"] }));

  const shaHex = input.targetSha.replace(/^sha256:/, "").slice(0, 12);
  const base = input.module.file.split("/").at(-1) ?? input.module.file;
  const moduleName = base.replace(/\.[^.]*$/, "");
  const header = [
    `// Generated by legacy-archaeologist ${input.version} for ${oneLine(input.targetDir)} (sha256 ${shaHex}). Do not edit: regenerate.`,
    `// Expected values were RECORDED from the real code with a frozen clock (${new Date(input.clockNow).toISOString()}) and seed ${input.seed}.`,
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    `import { ${SUPPORT_NAMES.filter((n) => uses.has(n)).join(", ")} } from "./support.mts";`,
    "",
    `const MODULE_REL = ${JSON.stringify(input.moduleRelNoExt)};`,
    `const MODULE_NAME = ${JSON.stringify(moduleName)};`,
    `configureWorld({ clockNow: ${input.clockNow}, seed: ${input.seed} });`,
  ];

  const out = [...header];
  const testLines: Record<CaseId, number> = {};
  for (const block of blocks) {
    out.push("");
    testLines[block.c.id] = out.length + 1;
    out.push(...block.lines);
  }
  return { testFile: out.join("\n") + "\n", testLines };
}
