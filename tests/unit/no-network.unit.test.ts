// The guard is already installed by --import ./tests/setup/no-network.ts (loopback allowed in the test process).
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import http2 from "node:http2";

const isNoNetwork = { code: "NO_NETWORK" };

test("[REP-03] fetch to a public host throws NO_NETWORK synchronously", () => {
  assert.throws(() => fetch("https://example.com"), isNoNetwork);
});

for (const [name, call] of [
  ["http.get", () => http.get("http://example.org/")],
  ["https.request", () => https.request("https://example.org/")],
  ["net.connect", () => net.connect(80, "93.184.215.14")],
  ["tls.connect", () => tls.connect(443, "example.org")],
  ["dns.lookup", () => dns.lookup("example.org", () => {})],
  ["dns.promises.lookup", () => dns.promises.lookup("example.org")],
  ["dgram.createSocket", () => dgram.createSocket("udp4")],
  ["http2.connect", () => http2.connect("https://example.org")],
] as const) test(`[REP-03] ${name} to a public host throws NO_NETWORK`, () => assert.throws(call, isNoNetwork));

test("[REP-03] net.Socket.prototype.connect to a public host throws NO_NETWORK", () => {
  const socket = new net.Socket();
  assert.throws(() => socket.connect({ port: 80, host: "example.org" }), isNoNetwork);
  socket.destroy();
});

test("[REP-03] dns.resolve4 and a Resolver instance throw NO_NETWORK", () => {
  assert.throws(() => dns.resolve4("example.org", () => {}), isNoNetwork);
  assert.throws(() => new dns.Resolver().resolve4("example.org", () => {}), isNoNetwork);
  assert.throws(() => dns.promises.resolve4("example.org"), isNoNetwork);
});

test("[SAFE-03] an ESM named import of dns.lookup sees the stub", async () => {
  const { lookup } = await import("node:dns");
  assert.throws(() => lookup("example.org", () => {}), isNoNetwork);
});

test("[REP-03] the error message names the destination", () => {
  assert.throws(() => fetch("https://example.com/path"), /^Error: NO_NETWORK: network access is disabled \(https:\/\/example\.com\/path\)$/);
});

for (const host of ["127.0.0.1", "::1"]) test(`[REP-03] loopback ${host} is allowed in the test process`, async (t) => {
  const srv = http.createServer((_q, r) => r.end("ok")).listen(0, host);
  await once(srv, "listening");
  t.after(() => srv.close());
  const res = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${(srv.address() as AddressInfo).port}/`);
  assert.equal(await res.text(), "ok");
});

test("[REP-03] http.get to localhost is allowed in the test process", async (t) => {
  const srv = http.createServer((_q, r) => r.end("hi")).listen(0, "127.0.0.1");
  await once(srv, "listening");
  t.after(() => srv.close());
  const body = await new Promise<string>((resolve, reject) => {
    http.get({ host: "localhost", family: 4, port: (srv.address() as AddressInfo).port, path: "/" }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve(text));
    }).on("error", reject);
  });
  assert.equal(body, "hi");
});
