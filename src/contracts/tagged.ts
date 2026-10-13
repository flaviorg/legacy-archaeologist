// Tagged serializer (spec 4.4 and 5.3). Imports nothing: the recorder child loads this file directly
// (its read grant has no node_modules), and support.mts reproduces the same rules.
// Every helper is a top-level function declaration.

export type Tagged = null | boolean | number | string | Tagged[] | { [k: string]: Tagged } | TaggedSpecial;
export type TaggedSpecial =
  | { $t: "NaN" } | { $t: "Infinity" } | { $t: "-Infinity" } | { $t: "-0" } | { $t: "undefined" }
  | { $t: "bigint"; v: string } | { $t: "Date"; v: string /* ISO or "Invalid Date" */ }
  | { $t: "Error"; name: string; message: string; code?: string | number } | { $t: "function"; name: string }
  | { $t: "object"; v: { [k: string]: Tagged } }
  | { $t: "circular" } | { $t: "truncated"; reason: "depth" | "nodes" | "string" }
  | { $t: "unserializable"; type: string };

export const OUTPUT_ONLY_TAGS = ["function", "circular", "truncated", "unserializable"] as const;
export type TaggedLimits = { maxDepth: number; maxNodes: number; maxString: number };
export const DEFAULT_TAGGED_LIMITS: TaggedLimits = { maxDepth: 8, maxNodes: 10_000, maxString: 10_240 };
export const LA_TAG: unique symbol = Symbol.for("la.tag") as typeof LA_TAG;

// dropFunctions: the stateAfter rule (spec 5.4): object keys whose value is a function are omitted and a function
// inside an array is tagged { $t: "function", name: "" } so lengths are kept.
type WalkState = { limits: TaggedLimits; nodes: number; stopped: boolean; ancestors: Set<object>; dropFunctions: boolean };

const ERROR_CONSTRUCTORS: Record<string, ErrorConstructor> = {
  Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
};

function defineKey(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty, not assignment, so a "__proto__" key stays an own data property.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isErrorValue(value: object): value is Error {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

function isDateValue(value: object): value is Date {
  return value instanceof Date || Object.prototype.toString.call(value) === "[object Date]";
}

function constructorName(value: object): string {
  try {
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null;
    const name = proto?.constructor?.name;
    return typeof name === "string" && name !== "" ? name : "Object";
  } catch {
    return "Object";
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function tagNumber(value: number): Tagged {
  if (Number.isNaN(value)) return { $t: "NaN" };
  if (value === Infinity) return { $t: "Infinity" };
  if (value === -Infinity) return { $t: "-Infinity" };
  if (Object.is(value, -0)) return { $t: "-0" };
  return value;
}

function tagError(err: Error): Tagged {
  let name = "Error", message = "", code: unknown;
  try { name = String(err.name); } catch { /* keep the default */ }
  try { message = String(err.message); } catch { /* keep the default */ }
  try { code = (err as { code?: unknown }).code; } catch { code = undefined; }
  const out: { $t: "Error"; name: string; message: string; code?: string | number } = { $t: "Error", name, message };
  if (typeof code === "string" || typeof code === "number") out.code = code;
  return out;
}

function readKey(obj: object, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: (obj as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

function walkArray(arr: unknown[], depth: number, state: WalkState): Tagged[] {
  const out: Tagged[] = [];
  for (let i = 0; i < arr.length; i++) {
    const read = readKey(arr, String(i));
    if (read.ok && state.dropFunctions && typeof read.value === "function") {
      state.nodes += 1;
      out.push(state.nodes > state.limits.maxNodes ? stopWalk(state) : { $t: "function", name: "" });
    } else {
      out.push(read.ok ? walk(read.value, depth + 1, state) : { $t: "unserializable", type: "getter" });
    }
    if (state.stopped) break;
  }
  return out;
}

function walkObject(obj: object, depth: number, state: WalkState): Tagged {
  const out: Record<string, Tagged> = {};
  let hasTagKey = false;
  for (const key of Object.keys(obj)) {
    const read = readKey(obj, key);
    if (read.ok && state.dropFunctions && typeof read.value === "function") continue;
    if (key === "$t") hasTagKey = true;
    defineKey(out, key, read.ok ? walk(read.value, depth + 1, state) : { $t: "unserializable", type: "getter" });
    if (state.stopped) break;
  }
  return hasTagKey ? { $t: "object", v: out } : out;
}

function stopWalk(state: WalkState): Tagged {
  state.stopped = true;
  return { $t: "truncated", reason: "nodes" };
}

function walk(value: unknown, depth: number, state: WalkState): Tagged {
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) return stopWalk(state);
  switch (typeof value) {
    case "number": return tagNumber(value);
    case "string": return value.length > state.limits.maxString ? { $t: "truncated", reason: "string" } : value;
    case "boolean": return value;
    case "undefined": return { $t: "undefined" };
    case "bigint": return { $t: "bigint", v: value.toString() };
    case "symbol": return { $t: "unserializable", type: "Symbol" };
    case "function": return { $t: "function", name: typeof value.name === "string" ? value.name : "" };
    default: break;
  }
  if (value === null) return null;
  const obj = value as object;
  if (isDateValue(obj)) {
    const time = Date.prototype.getTime.call(obj);
    return { $t: "Date", v: Number.isNaN(time) ? "Invalid Date" : Date.prototype.toISOString.call(obj) };
  }
  if (isErrorValue(obj)) return tagError(obj);
  const isArray = Array.isArray(obj);
  if (!isArray && !isPlainObject(obj)) return { $t: "unserializable", type: constructorName(obj) };
  if (state.ancestors.has(obj)) return { $t: "circular" };
  if (depth >= state.limits.maxDepth) return { $t: "truncated", reason: "depth" };
  state.ancestors.add(obj);
  try {
    return isArray ? walkArray(obj as unknown[], depth, state) : walkObject(obj, depth, state);
  } finally {
    state.ancestors.delete(obj);
  }
}

export function toTagged(value: unknown, limits: TaggedLimits = DEFAULT_TAGGED_LIMITS): Tagged {
  return walk(value, 0, { limits, nodes: 0, stopped: false, ancestors: new Set(), dropFunctions: false });
}

// toTagged with the stateAfter rule for functions (used by stateAfterOf in outcomes.ts).
export function toTaggedState(value: unknown, limits: TaggedLimits = DEFAULT_TAGGED_LIMITS): Tagged {
  return walk(value, 0, { limits, nodes: 0, stopped: false, ancestors: new Set(), dropFunctions: true });
}

function reviveError(tag: { name: string; message: string; code?: string | number }): Error {
  const Ctor = Object.hasOwn(ERROR_CONSTRUCTORS, tag.name) ? ERROR_CONSTRUCTORS[tag.name] : undefined;
  const err = Ctor ? new Ctor(tag.message) : new Error(tag.message);
  if (!Ctor) err.name = tag.name;
  if (tag.code !== undefined) (err as { code?: string | number }).code = tag.code;
  return err;
}

function revivePlain(obj: { [k: string]: Tagged }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) defineKey(out, key, revive(obj[key] as Tagged));
  return out;
}

function sentinel(tag: string): object {
  return Object.freeze({ [LA_TAG]: tag });
}

// Inverse of toTagged for the representable subset (used for inputs only; comparisons never revive).
export function revive(tagged: Tagged): unknown {
  if (tagged === null || typeof tagged !== "object") return tagged;
  if (Array.isArray(tagged)) return tagged.map((v) => revive(v));
  if (!Object.hasOwn(tagged, "$t") || typeof (tagged as { $t: unknown }).$t !== "string") return revivePlain(tagged as { [k: string]: Tagged });
  const special = tagged as TaggedSpecial;
  switch (special.$t) {
    case "NaN": return NaN;
    case "Infinity": return Infinity;
    case "-Infinity": return -Infinity;
    case "-0": return -0;
    case "undefined": return undefined;
    case "bigint": return BigInt(special.v);
    case "Date": return new Date(special.v === "Invalid Date" ? NaN : special.v);
    case "Error": return reviveError(special);
    case "object": return revivePlain(special.v);
    case "function":
    case "circular":
    case "truncated":
    case "unserializable":
      return sentinel(special.$t);
    default:
      return revivePlain(tagged as { [k: string]: Tagged });
  }
}
