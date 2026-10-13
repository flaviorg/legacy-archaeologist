// A reader for the TAP stream of node's test runner (`--test-reporter=tap`), as `verify` needs it (spec 5.5).
// Facts measured on node 24.21 (docs/api-notes.md): a top-level result is `ok N - <name>` or `not ok N - <name>` with
// `\` written as `\\` and `#` as `\#`; the failure message is the `error:` key of the YAML block that follows, either a
// block (`error: |-`, then indented lines) or one line quoted the way util.inspect quotes strings: '...' by default,
// "..." when the text has a single quote, `...` when it has both, '...' with \' when it has all three.

export type TapTest = { ok: boolean; name: string; message: string | null };
export type TapResult = { tests: TapTest[]; summary: { tests: number; pass: number; fail: number } | null };

const RESULT_LINE = /^(not ok|ok) \d+(?: - (.*))?$/;
const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

// The name part of a result line: \\ and \# unescaped; an unescaped " # " starts a TAP directive (such as SKIP).
function readName(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch === "\\" && i + 1 < raw.length) {
      out += raw[i + 1];
      i += 1;
      continue;
    }
    if (ch === "#" && out.endsWith(" ")) return out.trimEnd();
    out += ch;
  }
  return out;
}

function readEscape(text: string, i: number): { value: string; next: number } {
  const ch = text[i] ?? "";
  if (Object.hasOwn(SIMPLE_ESCAPES, ch)) return { value: SIMPLE_ESCAPES[ch] as string, next: i + 1 };
  if (ch === "x" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) return { value: String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16)), next: i + 3 };
  if (ch === "u" && text[i + 1] === "{") {
    const end = text.indexOf("}", i + 2);
    const hex = end > 0 ? text.slice(i + 2, end) : "";
    if (/^[0-9a-fA-F]{1,6}$/.test(hex)) return { value: String.fromCodePoint(parseInt(hex, 16)), next: end + 1 };
  }
  if (ch === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) return { value: String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)), next: i + 5 };
  return { value: ch, next: i + 1 };
}

// A quoted scalar: util.inspect escapes, plus YAML's '' for ' inside single quotes.
function readQuoted(value: string): string {
  const quote = value[0] as string;
  let out = "";
  for (let i = 1; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === "\\") {
      const esc = readEscape(value, i + 1);
      out += esc.value;
      i = esc.next - 1;
      continue;
    }
    if (ch === quote) {
      if (quote === "'" && value[i + 1] === "'") {
        out += "'";
        i += 1;
        continue;
      }
      return out;
    }
    out += ch;
  }
  return out;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

// The `error:` value of the YAML block starting at lines[start] ("  ---"); null when there is none.
function readError(lines: readonly string[], start: number): string | null {
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "...") return null;
    const m = /^(\s*)error: ?(.*)$/.exec(line);
    if (!m || (m[1] as string).length !== indentOf(lines[start] as string)) continue;
    const value = m[2] as string;
    if (/^[|>][-+]?$/.test(value)) {
      const first = lines[i + 1];
      return first !== undefined && indentOf(first) > (m[1] as string).length ? first.trim() : "";
    }
    if (value.startsWith("'") || value.startsWith('"') || value.startsWith("`")) return readQuoted(value);
    return value;
  }
  return null;
}

export function parseTap(text: string): TapResult {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const tests: TapTest[] = [];
  const totals: Record<string, number> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const result = RESULT_LINE.exec(line);
    if (result) {
      const ok = result[1] === "ok";
      const blockStart = lines[i + 1] !== undefined && /^\s+---$/.test(lines[i + 1] as string) ? i + 1 : -1;
      const message = !ok && blockStart >= 0 ? readError(lines, blockStart) : null;
      tests.push({ ok, name: readName(result[2] ?? ""), message });
      continue;
    }
    const total = /^# (tests|pass|fail) (\d+)$/.exec(line);
    if (total) totals[total[1] as string] = Number(total[2]);
  }
  const summary = totals.tests === undefined ? null : { tests: totals.tests, pass: totals.pass ?? 0, fail: totals.fail ?? 0 };
  return { tests, summary };
}
