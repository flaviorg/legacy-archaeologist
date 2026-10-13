// The child's frozen world (spec 5.4, REC-01). Imports only node:*.
// installWorld() runs once per child, before any target code; reseed() runs before every case.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";

type Patchable = Record<string, unknown>;

const require = createRequire(import.meta.url);

// mulberry32: constants 0x6D2B79F5, Math.imul, shifts 15/7/14, >>> 0 / 4294967296 (plan "Confirmed signatures").
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type World = {
  reseed(): void;
  realExit: (code?: number) => never;
  // The real monotonic clock, captured before performance.now is replaced (durations go to timings.json).
  realNow: () => number;
};

const NS_PER_MS = 1_000_000n;
const NS_PER_S = 1_000_000_000n;

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function installWorld(world: { clockNow: number; seed: number }): World {
  const realExit = process.exit.bind(process) as (code?: number) => never;
  const realPerformanceNow = performance.now.bind(performance);

  let streamA = mulberry32(world.seed);
  let streamB = mulberry32(world.seed + 1);
  let perfCounter = 0;
  let hrCounter = 0n;

  mock.timers.enable({ apis: ["Date"], now: world.clockNow });

  Math.random = function random(): number {
    return streamA();
  };

  Object.defineProperty(performance, "now", {
    value: function now(): number {
      perfCounter += 1;
      return perfCounter;
    },
    configurable: true,
    writable: true,
  });

  const nextHrNs = (): bigint => {
    hrCounter += 1n;
    return hrCounter * NS_PER_MS;
  };
  const hrtime = function hrtime(prev?: [number, number]): [number, number] {
    let ns = nextHrNs();
    if (Array.isArray(prev)) ns -= BigInt(prev[0]) * NS_PER_S + BigInt(prev[1]);
    return [Number(ns / NS_PER_S), Number(ns % NS_PER_S)];
  };
  hrtime.bigint = function bigint(): bigint {
    return nextHrNs();
  };
  process.hrtime = hrtime as typeof process.hrtime;

  // One byte per draw from stream B.
  const fill = (view: Uint8Array): Uint8Array => {
    for (let i = 0; i < view.length; i++) view[i] = Math.floor(streamB() * 256);
    return view;
  };
  const randomUUID = function randomUUID(): string {
    const b = fill(new Uint8Array(16));
    b[6] = ((b[6] as number) & 0x0f) | 0x40;
    b[8] = ((b[8] as number) & 0x3f) | 0x80;
    const h = hex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const getRandomValues = function getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    if (array !== null && ArrayBuffer.isView(array)) fill(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return array;
  };
  const randomBytes = function randomBytes(size: number, cb?: (err: Error | null, buf: Buffer) => void): Buffer | undefined {
    const buf = Buffer.alloc(size);
    fill(buf);
    if (typeof cb === "function") {
      process.nextTick(() => cb(null, buf));
      return undefined;
    }
    return buf;
  };

  const nodeCrypto = require("node:crypto") as Patchable;
  nodeCrypto.randomUUID = randomUUID;
  nodeCrypto.randomBytes = randomBytes;
  // node:crypto's getRandomValues is an accessor; replace it when it can be redefined.
  try {
    Object.defineProperty(nodeCrypto, "getRandomValues", { value: getRandomValues, configurable: true, writable: true, enumerable: true });
  } catch {
    // Left as is: it delegates to globalThis.crypto, patched below.
  }
  const web = globalThis.crypto as unknown as Patchable;
  Object.defineProperty(web, "randomUUID", { value: randomUUID, configurable: true, writable: true });
  Object.defineProperty(web, "getRandomValues", { value: getRandomValues, configurable: true, writable: true });

  process.exit = function exit(code?: number | string | null): never {
    throw Object.assign(new Error(`process.exit(${code === undefined ? "" : String(code)}) called`), { name: "ProcessExitCalled" });
  } as typeof process.exit;

  syncBuiltinESMExports();

  return {
    reseed(): void {
      streamA = mulberry32(world.seed);
      streamB = mulberry32(world.seed + 1);
      perfCounter = 0;
      hrCounter = 0n;
      mock.timers.setTime(world.clockNow);
    },
    realExit,
    realNow: realPerformanceNow,
  };
}
