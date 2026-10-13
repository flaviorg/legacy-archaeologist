// One display format for tagged values and outcomes (SPEC.md, the CLI, the verify output and the demo summary).
// Pure. The emitted support.mts carries the same grammar as text (src/generate/support-template.ts); a unit test
// keeps the two in agreement.
import type { Prediction } from "../contracts/hypotheses.ts";
import type { Outcome } from "../contracts/outcomes.ts";
import type { Tagged } from "../contracts/tagged.ts";

function tagOf(value: object): string | undefined {
  if (!Object.hasOwn(value, "$t")) return undefined;
  const t = (value as { $t: unknown }).$t;
  return typeof t === "string" ? t : undefined;
}

function formatPlain(obj: { [k: string]: Tagged }): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  return "{" + keys.map((k) => JSON.stringify(k) + ": " + formatTagged(obj[k] as Tagged)).join(", ") + "}";
}

/** `NaN`, `-0`, `12n`, `Date(<ISO>)`, `TypeError("msg")`, `Error("msg", code X)`, `[function f]`, `[Map]`, JSON-like rest. */
export function formatTagged(t: Tagged): string {
  if (t === null) return "null";
  if (typeof t === "number" || typeof t === "boolean") return String(t);
  if (typeof t === "string") return JSON.stringify(t);
  if (Array.isArray(t)) return "[" + t.map((v) => formatTagged(v)).join(", ") + "]";
  const s = t as Record<string, any>;
  switch (tagOf(t)) {
    case undefined: return formatPlain(t as { [k: string]: Tagged });
    case "NaN":
    case "Infinity":
    case "-Infinity":
    case "-0":
    case "undefined": return String(s.$t);
    case "bigint": return `${String(s.v)}n`;
    case "Date": return `Date(${String(s.v)})`;
    case "Error": return `${String(s.name)}(${JSON.stringify(s.message)}${s.code === undefined ? "" : `, code ${String(s.code)}`})`;
    case "function": return s.name ? `[function ${String(s.name)}]` : "[function]";
    case "circular": return "[circular]";
    case "truncated": return `[truncated: ${String(s.reason)}]`;
    case "unserializable": return `[${String(s.type)}]`;
    case "object": return formatPlain(s.v as { [k: string]: Tagged });
    default: return formatPlain(t as { [k: string]: Tagged });
  }
}

/** `(100, "VIP")` */
export function formatArgs(args: readonly Tagged[]): string {
  return "(" + args.map((a) => formatTagged(a)).join(", ") + ")";
}

/** `returned 100`, `threw TypeError("x")`, `callback [null, {...}]`, `promise fulfilled 1`, `timeout (watchdog)`, `no callback`. */
export function formatOutcome(o: Outcome): string {
  switch (o.kind) {
    case "returned": return `returned ${formatTagged(o.value)}`;
    case "threw": return `threw ${formatTagged(o.value)}`;
    case "callback": return `callback [${o.args.map((a) => formatTagged(a)).join(", ")}]`;
    case "promise": return `promise ${o.status} ${formatTagged(o.value)}`;
    case "timeout": return o.reason ? `timeout (${o.reason})` : "timeout";
    case "no-callback": return "no callback";
    default: return "unknown outcome";
  }
}

/** `returns 90`, `throws TypeError`, `throws`, `callback 3`, `unknown`. */
export function formatPrediction(p: Prediction): string {
  switch (p.kind) {
    case "returns": return `returns ${formatTagged(p.value)}`;
    case "throws": return p.name === undefined ? "throws" : `throws ${p.name}`;
    case "callback": return `callback ${formatTagged(p.value)}`;
    default: return "unknown";
  }
}

/** Backslash-escapes Markdown punctuation that could break a table or a link; newlines become spaces. */
export function escapeMd(text: string): string {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, " ").replace(/[\\|`*_[\]<>]/g, (ch) => `\\${ch}`);
}
