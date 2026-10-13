// Every source of nondeterminism the child freezes (REC-01).
var crypto = require("crypto");

function snapshot() {
  return {
    now: Date.now(),
    iso: new Date().toISOString(),
    random: Math.random(),
    perf1: performance.now(),
    perf2: performance.now(),
    hrBig: process.hrtime.bigint().toString(),
    hr: process.hrtime(),
    uuid: crypto.randomUUID(),
    bytes: crypto.randomBytes(4).toString("hex"),
    webUuid: globalThis.crypto.randomUUID(),
    web: Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)))
  };
}

function rand() {
  return Math.random();
}

module.exports = { snapshot: snapshot, rand: rand };
