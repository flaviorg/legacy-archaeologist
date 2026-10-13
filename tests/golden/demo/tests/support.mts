// support.mts: the recorder's world for the generated characterization tests (legacy-archaeologist).
// It imports only node:* so the tests run in a repository that does not contain the tool. Do not edit: regenerate.
import { mock } from "node:test";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";

const require = createRequire(import.meta.url);
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const NS_PER_MS = 1000000n;
const NS_PER_S = 1000000000n;
const EXTENSIONS = [".js", ".cjs", ".mjs", ".ts", ".mts"];
const LIMITS = { maxDepth: 8, maxNodes: 10000, maxString: 10240 };
const ERROR_CONSTRUCTORS = { Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };

const world = {
  configured: false, clockNow: 0, seed: 0, streamA: null, streamB: null, perf: 0, hr: 0n,
  loads: 0, kind: "commonjs", root: "", rootUrl: "", query: "",
};

// mulberry32, the recorder's seeded generator.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// Stream B gives one byte per draw (crypto stubs); stream A is Math.random.
function fill(view) {
  for (let i = 0; i < view.length; i++) view[i] = Math.floor(world.streamB() * 256);
  return view;
}

function randomUUID() {
  const b = fill(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}

function getRandomValues(array) {
  if (array !== null && ArrayBuffer.isView(array)) fill(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  return array;
}

function randomBytes(size, cb) {
  const buf = Buffer.alloc(size);
  fill(buf);
  if (typeof cb === "function") {
    process.nextTick(() => cb(null, buf));
    return undefined;
  }
  return buf;
}

function nextHrNs() {
  world.hr += 1n;
  return world.hr * NS_PER_MS;
}

// One resolve hook per process: while a query such as ?la=3 is current, a file URL under the module's directory
// resolved from a parent carrying that query gets the same query, so static imports are fresh per test too.
function registerQueryHook() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (world.query === "" || world.rootUrl === "") return resolved;
      const parent = context.parentURL || "";
      if (!parent.endsWith(world.query)) return resolved;
      if (!resolved.url.startsWith(world.rootUrl) || resolved.url.includes("?")) return resolved;
      return { ...resolved, url: resolved.url + world.query };
    },
  });
}

function installWorld() {
  mock.timers.enable({ apis: ["Date"], now: world.clockNow });
  Math.random = function random() {
    return world.streamA();
  };
  Object.defineProperty(performance, "now", {
    value: function now() {
      world.perf += 1;
      return world.perf;
    },
    configurable: true,
    writable: true,
  });
  const hrtime = function hrtime(prev) {
    let ns = nextHrNs();
    if (Array.isArray(prev)) ns -= BigInt(prev[0]) * NS_PER_S + BigInt(prev[1]);
    return [Number(ns / NS_PER_S), Number(ns % NS_PER_S)];
  };
  hrtime.bigint = function bigint() {
    return nextHrNs();
  };
  process.hrtime = hrtime;
  const nodeCrypto = require("node:crypto");
  nodeCrypto.randomUUID = randomUUID;
  nodeCrypto.randomBytes = randomBytes;
  try {
    Object.defineProperty(nodeCrypto, "getRandomValues", { value: getRandomValues, configurable: true, writable: true, enumerable: true });
  } catch {
    // Left as is: it delegates to globalThis.crypto, patched below.
  }
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: randomUUID, configurable: true, writable: true });
  Object.defineProperty(globalThis.crypto, "getRandomValues", { value: getRandomValues, configurable: true, writable: true });
  syncBuiltinESMExports();
  registerQueryHook();
}

/** Sets TZ=UTC first, then installs the frozen clock, the seeded streams, the counters and the crypto stubs once. */
export function configureWorld(options) {
  process.env.TZ = "UTC";
  world.clockNow = options.clockNow;
  world.seed = options.seed;
  if (!world.configured) {
    world.streamA = mulberry32(world.seed);
    world.streamB = mulberry32(world.seed + 1);
    installWorld();
    world.configured = true;
  }
  reseedWorld();
}

/** Seeds, counters and the clock back to their start, exactly as the recorder does before every case. */
export function reseedWorld() {
  world.streamA = mulberry32(world.seed);
  world.streamB = mulberry32(world.seed + 1);
  world.perf = 0;
  world.hr = 0n;
  mock.timers.setTime(world.clockNow);
}

function resolveModulePath(moduleRel, moduleName, fromUrl) {
  const targetDir = process.env.LA_TARGET_DIR;
  const base = targetDir ? join(targetDir, moduleName) : resolve(dirname(fileURLToPath(fromUrl)), moduleRel);
  for (const ext of EXTENSIONS) if (existsSync(base + ext)) return realpathSync(base + ext);
  throw new Error("MODULE_NOT_FOUND_IN_AGAINST: " + base + " (tried .js, .cjs, .mjs, .ts, .mts)");
}

// By extension, else by the nearest package.json "type" walking up from the file.
function moduleKindOf(file) {
  if (/\.m[jt]s$/.test(file)) return "module";
  if (/\.c[jt]s$/.test(file)) return "commonjs";
  let dir = dirname(file);
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        return JSON.parse(readFileSync(pkg, "utf8")).type === "module" ? "module" : "commonjs";
      } catch {
        return "commonjs";
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return "commonjs";
    dir = parent;
  }
}

/**
 * Re-seeds the world, then loads a fresh instance of the module under test. Without LA_TARGET_DIR, moduleRel is
 * resolved against the test file's directory; with it, <LA_TARGET_DIR>/<moduleName>. Extensions are tried in the order
 * .js, .cjs, .mjs, .ts, .mts. CommonJS: require.cache is purged under the module's directory and the module is
 * required again (a live view whose default is module.exports); ESM: import() with a fresh ?la=<n> query.
 */
export async function loadFresh(moduleRel, moduleName, fromUrl) {
  if (!world.configured) throw new Error("configureWorld must run before loadFresh");
  reseedWorld();
  const file = resolveModulePath(moduleRel, moduleName, fromUrl);
  const root = dirname(file);
  world.kind = moduleKindOf(file);
  world.root = root;
  world.loads += 1;
  if (world.kind === "commonjs") {
    world.query = "";
    world.rootUrl = "";
    const prefix = root.endsWith(sep) ? root : root + sep;
    for (const key of Object.keys(require.cache)) if (key.startsWith(prefix)) delete require.cache[key];
    const exported = createRequire(file)(file);
    if ((typeof exported === "object" && exported !== null) || typeof exported === "function") {
      return new Proxy(exported, {
        get(target, key, receiver) {
          if (key === "default" && !Object.hasOwn(target, "default")) return target;
          return Reflect.get(target, key, receiver);
        },
      });
    }
    return { default: exported };
  }
  const href = pathToFileURL(root).href;
  world.rootUrl = href.endsWith("/") ? href : href + "/";
  world.query = "?la=" + world.loads;
  return await import(pathToFileURL(file).href + world.query);
}

// ---- tagged serializer (the recorder's rules) ----

function defineKey(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isErrorValue(value) {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

function isDateValue(value) {
  return value instanceof Date || Object.prototype.toString.call(value) === "[object Date]";
}

function constructorName(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    const name = proto && proto.constructor ? proto.constructor.name : undefined;
    return typeof name === "string" && name !== "" ? name : "Object";
  } catch {
    return "Object";
  }
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function tagNumber(value) {
  if (Number.isNaN(value)) return { $t: "NaN" };
  if (value === Infinity) return { $t: "Infinity" };
  if (value === -Infinity) return { $t: "-Infinity" };
  if (Object.is(value, -0)) return { $t: "-0" };
  return value;
}

function tagError(err) {
  let name = "Error", message = "", code;
  try { name = String(err.name); } catch { /* keep the default */ }
  try { message = String(err.message); } catch { /* keep the default */ }
  try { code = err.code; } catch { code = undefined; }
  const out = { $t: "Error", name, message };
  if (typeof code === "string" || typeof code === "number") out.code = code;
  return out;
}

function readKey(obj, key) {
  try {
    return { ok: true, value: obj[key] };
  } catch {
    return { ok: false };
  }
}

function stopWalk(state) {
  state.stopped = true;
  return { $t: "truncated", reason: "nodes" };
}

function walkArray(arr, depth, state) {
  const out = [];
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

function walkObject(obj, depth, state) {
  const out = {};
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

function walk(value, depth, state) {
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
  if (isDateValue(value)) {
    const time = Date.prototype.getTime.call(value);
    return { $t: "Date", v: Number.isNaN(time) ? "Invalid Date" : Date.prototype.toISOString.call(value) };
  }
  if (isErrorValue(value)) return tagError(value);
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return { $t: "unserializable", type: constructorName(value) };
  if (state.ancestors.has(value)) return { $t: "circular" };
  if (depth >= state.limits.maxDepth) return { $t: "truncated", reason: "depth" };
  state.ancestors.add(value);
  try {
    return isArray ? walkArray(value, depth, state) : walkObject(value, depth, state);
  } finally {
    state.ancestors.delete(value);
  }
}

export function toTagged(value) {
  return walk(value, 0, { limits: LIMITS, nodes: 0, stopped: false, ancestors: new Set(), dropFunctions: false });
}

function reviveError(tag) {
  const Ctor = Object.hasOwn(ERROR_CONSTRUCTORS, tag.name) ? ERROR_CONSTRUCTORS[tag.name] : undefined;
  const err = Ctor ? new Ctor(tag.message) : new Error(tag.message);
  if (!Ctor) err.name = tag.name;
  if (tag.code !== undefined) err.code = tag.code;
  return err;
}

function revivePlain(obj) {
  const out = {};
  for (const key of Object.keys(obj)) defineKey(out, key, revive(obj[key]));
  return out;
}

/** Builds an argument from its tagged form (arguments only; comparisons never revive). */
export function revive(tagged) {
  if (tagged === null || typeof tagged !== "object") return tagged;
  if (Array.isArray(tagged)) return tagged.map((v) => revive(v));
  if (!Object.hasOwn(tagged, "$t") || typeof tagged.$t !== "string") return revivePlain(tagged);
  switch (tagged.$t) {
    case "NaN": return NaN;
    case "Infinity": return Infinity;
    case "-Infinity": return -Infinity;
    case "-0": return -0;
    case "undefined": return undefined;
    case "bigint": return BigInt(tagged.v);
    case "Date": return new Date(tagged.v === "Invalid Date" ? NaN : tagged.v);
    case "Error": return reviveError(tagged);
    case "object": return revivePlain(tagged.v);
    case "function":
    case "circular":
    case "truncated":
    case "unserializable":
      return Object.freeze({ [Symbol.for("la.tag")]: tagged.$t });
    default:
      return revivePlain(tagged);
  }
}

// Error messages are normalized as the recorder does: the module's directory and its file:// URL become <target>,
// and the ?la=<n> query is removed.
function escapeRegExp(text) {
  return text.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

function normalizeMessage(message) {
  if (world.root === "") return message;
  let out = message;
  for (const form of [pathToFileURL(world.root).href, world.root]) out = out.replace(new RegExp(escapeRegExp(form), "g"), "<target>");
  return out.replace(/\?la=\d+/g, "");
}

function normalizeTagged(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => normalizeTagged(v));
  if (value.$t === "Error") {
    const out = { $t: "Error", name: value.name, message: normalizeMessage(value.message) };
    if (value.code !== undefined) out.code = value.code;
    return out;
  }
  if (typeof value.$t === "string" && value.$t !== "object") return value;
  const out = {};
  for (const key of Object.keys(value)) defineKey(out, key, normalizeTagged(value[key]));
  return out;
}

function tag(value) {
  return normalizeTagged(toTagged(value));
}

// ---- comparator (tagged against tagged; key order is behavior) ----

function tagOf(value) {
  if (!Object.hasOwn(value, "$t")) return undefined;
  return typeof value.$t === "string" ? value.$t : undefined;
}

function plainEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!taggedEqual(a[ka[i]], b[ka[i]])) return false;
  }
  return true;
}

function specialEqual(t, a, b) {
  switch (t) {
    case "Error": return a.name === b.name && a.message === b.message && Object.is(a.code, b.code);
    case "Date":
    case "bigint": return a.v === b.v;
    case "function": return a.name === b.name;
    case "truncated": return a.reason === b.reason;
    case "unserializable": return a.type === b.type;
    case "object": return plainEqual(a.v, b.v);
    default: return true;
  }
}

export function taggedEqual(a, b) {
  if (typeof a === "number" || typeof b === "number") return typeof a === "number" && typeof b === "number" && Object.is(a, b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!taggedEqual(a[i], b[i])) return false;
    return true;
  }
  const ta = tagOf(a), tb = tagOf(b);
  if (ta !== tb) return false;
  if (ta !== undefined) return specialEqual(ta, a, b);
  return plainEqual(a, b);
}

function argsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!taggedEqual(a[i], b[i])) return false;
  return true;
}

export function outcomesEqual(a, b) {
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

/** Exported non-function values after the last step (never "default"); null when nothing remains. */
export function stateAfterOf(m) {
  const kept = {};
  let count = 0;
  for (const key of Object.keys(m)) {
    if (key === "default") continue;
    const read = readKey(m, key);
    if (read.ok && typeof read.value === "function") continue;
    defineKey(kept, key, read.ok ? read.value : undefined);
    count += 1;
  }
  if (count === 0) return null;
  return normalizeTagged(walk(kept, 0, { limits: LIMITS, nodes: 0, stopped: false, ancestors: new Set(), dropFunctions: true }));
}

// ---- capture: every call returns a tagged Outcome ----

function isThenable(value) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof value.then === "function";
  } catch {
    return false;
  }
}

// process.exit throws while a captured call runs, as in the recorder; the test runner's own exit is left alone.
function guardExit() {
  const saved = process.exit;
  process.exit = function exit(code) {
    throw Object.assign(new Error("process.exit(" + (code === undefined ? "" : String(code)) + ") called"), { name: "ProcessExitCalled" });
  };
  return () => {
    process.exit = saved;
  };
}

function race(settled, waitMs, onTimeout) {
  return new Promise((done) => {
    const timer = realSetTimeout(() => done(onTimeout), Math.max(0, waitMs));
    settled.then((o) => {
      realClearTimeout(timer);
      done(o);
    });
  });
}

/** A synchronous call: returned or threw. */
export function capture(fn) {
  const restore = guardExit();
  try {
    return { kind: "returned", value: tag(fn()) };
  } catch (err) {
    return { kind: "threw", value: tag(err) };
  } finally {
    restore();
  }
}

/** A call whose recorded outcome was a promise: fulfilled or rejected within timeoutMs, else a timeout. */
export async function captureAsync(fn, timeoutMs) {
  const restore = guardExit();
  try {
    let value;
    try {
      value = fn();
    } catch (err) {
      return { kind: "threw", value: tag(err) };
    }
    if (!isThenable(value)) return { kind: "returned", value: tag(value) };
    const settled = Promise.resolve(value).then(
      (v) => ({ kind: "promise", status: "fulfilled", value: tag(v) }),
      (e) => ({ kind: "promise", status: "rejected", value: tag(e) }),
    );
    return await race(settled, timeoutMs, { kind: "timeout", reason: "case-timeout" });
  } finally {
    restore();
  }
}

/** A callback-style call: the first callback call wins; a throw before it is threw; none within timeoutMs is no-callback. */
export async function captureCallback(fn, timeoutMs) {
  const restore = guardExit();
  let called = null;
  let done = false;
  let deliver = () => {};
  const settled = new Promise((resolveSettled) => {
    deliver = resolveSettled;
  });
  const cb = function recordCallback(...args) {
    if (done || called) return;
    called = { kind: "callback", args: args.map((a) => tag(a)) };
    deliver(called);
  };
  try {
    try {
      fn(cb);
    } catch (err) {
      if (!called) {
        done = true;
        return { kind: "threw", value: tag(err) };
      }
    }
    if (called) return called;
    const outcome = await race(settled, timeoutMs, { kind: "no-callback" });
    done = true;
    return outcome;
  } finally {
    restore();
  }
}

// ---- display (the grammar of SPEC.md and the verify output) ----

function formatPlain(obj) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  return "{" + keys.map((k) => JSON.stringify(k) + ": " + formatTagged(obj[k])).join(", ") + "}";
}

function formatTagged(t) {
  if (t === null) return "null";
  if (typeof t === "number" || typeof t === "boolean") return String(t);
  if (typeof t === "string") return JSON.stringify(t);
  if (Array.isArray(t)) return "[" + t.map((v) => formatTagged(v)).join(", ") + "]";
  switch (tagOf(t)) {
    case undefined: return formatPlain(t);
    case "NaN":
    case "Infinity":
    case "-Infinity":
    case "-0":
    case "undefined": return t.$t;
    case "bigint": return t.v + "n";
    case "Date": return "Date(" + t.v + ")";
    case "Error": return t.name + "(" + JSON.stringify(t.message) + (t.code === undefined ? "" : ", code " + String(t.code)) + ")";
    case "function": return t.name ? "[function " + t.name + "]" : "[function]";
    case "circular": return "[circular]";
    case "truncated": return "[truncated: " + t.reason + "]";
    case "unserializable": return "[" + t.type + "]";
    case "object": return formatPlain(t.v);
    default: return formatPlain(t);
  }
}

function formatOutcome(o) {
  switch (o.kind) {
    case "returned": return "returned " + formatTagged(o.value);
    case "threw": return "threw " + formatTagged(o.value);
    case "callback": return "callback [" + o.args.map((a) => formatTagged(a)).join(", ") + "]";
    case "promise": return "promise " + o.status + " " + formatTagged(o.value);
    case "timeout": return o.reason ? "timeout (" + o.reason + ")" : "timeout";
    case "no-callback": return "no callback";
    default: return "unknown outcome";
  }
}

/** One line: [step <n>: ]expected <outcome>   actual <outcome> (step is the 0-based index, printed 1-based). */
export function describeOutcome(expected, actual, step) {
  const prefix = step === undefined ? "" : "step " + (step + 1) + ": ";
  return prefix + "expected " + formatOutcome(expected) + "   actual " + formatOutcome(actual);
}
