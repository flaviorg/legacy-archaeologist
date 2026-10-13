// The ESM twin of nondeterministic/index.js, with named node:crypto imports (REC-01).
import { randomBytes, randomUUID } from "node:crypto";

export function snapshot() {
  return {
    now: Date.now(),
    iso: new Date().toISOString(),
    random: Math.random(),
    perf1: performance.now(),
    perf2: performance.now(),
    hrBig: process.hrtime.bigint().toString(),
    hr: process.hrtime(),
    uuid: randomUUID(),
    bytes: randomBytes(4).toString("hex"),
    webUuid: globalThis.crypto.randomUUID(),
    web: Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)))
  };
}
