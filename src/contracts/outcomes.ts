// The one outcome comparator (spec 4.4). Imports only ./tagged.ts: the recorder child loads it directly.
// Comparison domain: tagged against tagged, never revived. Every helper is a top-level function declaration.
import { DEFAULT_TAGGED_LIMITS, toTaggedState } from "./tagged.ts";
import type { Tagged, TaggedLimits } from "./tagged.ts";

export type Outcome =
  | { kind: "returned"; value: Tagged }
  | { kind: "threw"; value: Tagged }
  | { kind: "callback"; args: Tagged[] }
  | { kind: "promise"; status: "fulfilled" | "rejected"; value: Tagged }
  | { kind: "timeout"; reason?: "case-timeout" | "watchdog" | "output-cap" | "child-exit" | "leaked-error" }
  | { kind: "no-callback" };

const SANDBOX_ONLY_CODES = ["NO_NETWORK", "ERR_ACCESS_DENIED"];

function tagOf(value: object): string | undefined {
  if (!Object.hasOwn(value, "$t")) return undefined;
  const tag = (value as { $t: unknown }).$t;
  return typeof tag === "string" ? tag : undefined;
}

function plainEqual(a: { [k: string]: Tagged }, b: { [k: string]: Tagged }): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const key = ka[i] as string;
    if (key !== kb[i]) return false;
    if (!taggedEqual(a[key] as Tagged, b[key] as Tagged)) return false;
  }
  return true;
}

function specialEqual(tag: string, a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  switch (tag) {
    case "Error": return a.name === b.name && a.message === b.message && Object.is(a.code, b.code);
    case "Date":
    case "bigint": return a.v === b.v;
    case "function": return a.name === b.name;
    case "truncated": return a.reason === b.reason;
    case "unserializable": return a.type === b.type;
    case "object": return plainEqual(a.v as { [k: string]: Tagged }, b.v as { [k: string]: Tagged });
    default: return true;
  }
}

// Object.is on numbers (NaN equals NaN, -0 differs from 0); plain objects key by key in insertion order (D-09).
export function taggedEqual(a: Tagged, b: Tagged): boolean {
  if (typeof a === "number" || typeof b === "number") return typeof a === "number" && typeof b === "number" && Object.is(a, b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!taggedEqual(a[i] as Tagged, b[i] as Tagged)) return false;
    return true;
  }
  const ta = tagOf(a), tb = tagOf(b);
  if (ta !== tb) return false;
  if (ta !== undefined) return specialEqual(ta, a as Record<string, unknown>, b as Record<string, unknown>);
  return plainEqual(a as { [k: string]: Tagged }, b as { [k: string]: Tagged });
}

function argsEqual(a: Tagged[], b: Tagged[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!taggedEqual(a[i] as Tagged, b[i] as Tagged)) return false;
  return true;
}

export function outcomesEqual(a: Outcome, b: Outcome): boolean {
  switch (a.kind) {
    case "returned":
    case "threw": return b.kind === a.kind && taggedEqual(a.value, b.value);
    case "callback": return b.kind === "callback" && argsEqual(a.args, b.args);
    case "promise": return b.kind === "promise" && a.status === b.status && taggedEqual(a.value, b.value);
    case "timeout": return b.kind === "timeout";
    case "no-callback": return b.kind === "no-callback";
    default: return false;
  }
}

function readExport(moduleExports: object, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: (moduleExports as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

// Spec 5.4: own enumerable string-keyed exports, never "default" (the synthetic CJS key or the ESM default),
// function values dropped at any depth, functions inside arrays tagged with an empty name; null when nothing remains.
// The rule is the same for both module kinds; `kind` documents the caller's loader.
export function stateAfterOf(moduleExports: object, kind: "commonjs" | "module", limits: TaggedLimits = DEFAULT_TAGGED_LIMITS): Tagged | null {
  void kind;
  const kept: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(moduleExports)) {
    if (key === "default") continue;
    const read = readExport(moduleExports, key);
    if (read.ok && typeof read.value === "function") continue;
    Object.defineProperty(kept, key, { value: read.ok ? read.value : undefined, enumerable: true, writable: true, configurable: true });
    count += 1;
  }
  if (count === 0) return null;
  return toTaggedState(kept, limits);
}

function hasSandboxError(value: Tagged): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasSandboxError(v));
  const tag = tagOf(value);
  if (tag === "Error") {
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && SANDBOX_ONLY_CODES.includes(code);
  }
  // Inside the escape, the "$t" key of v is data, so v is searched as a plain object.
  if (tag === "object") return Object.values((value as { v: { [k: string]: Tagged } }).v).some((v) => hasSandboxError(v));
  if (tag !== undefined) return false;
  return Object.values(value as { [k: string]: Tagged }).some((v) => hasSandboxError(v));
}

function outcomeHasSandboxError(outcome: Outcome): boolean {
  switch (outcome.kind) {
    case "returned":
    case "threw":
    case "promise": return hasSandboxError(outcome.value);
    case "callback": return outcome.args.some((v) => hasSandboxError(v));
    default: return false;
  }
}

// Stable, no timeout or no-callback step, and no sandbox-only Error tag anywhere in any step's outcome.
export function isCharacterized(c: { determinism: "stable" | "unstable"; steps: { outcome: Outcome }[] }): boolean {
  if (c.determinism !== "stable") return false;
  for (const step of c.steps) {
    if (step.outcome.kind === "timeout" || step.outcome.kind === "no-callback") return false;
    if (outcomeHasSandboxError(step.outcome)) return false;
  }
  return true;
}
