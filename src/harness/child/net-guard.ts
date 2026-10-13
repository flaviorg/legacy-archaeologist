// Network guard. Imports only node:* (it runs inside the recorder child, whose read grant has no node_modules).
// Importing this module has no side effect; installNetGuard() patches the network entry points.
// Every replacement throws synchronously (plan delta 15), so a target that calls one records `threw` with code NO_NETWORK.
import { createRequire, syncBuiltinESMExports } from "node:module";

type AnyFn = (...args: any[]) => any;
type Patchable = Record<string, unknown>;

const require = createRequire(import.meta.url);
const GUARD_KEY = Symbol.for("la.netGuard");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function noNetwork(target: string): Error {
  return Object.assign(new Error(`NO_NETWORK: network access is disabled (${target})`), { code: "NO_NETWORK" });
}

function normalizeHost(host: unknown): string {
  const text = typeof host === "string" ? host : "";
  return text.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function isLoopback(host: unknown): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A destination: either a host (with an optional label for the error message) or a Unix socket path.
type Destination = { host: string; label: string } | { path: string; label: string };

function destinationAllowed(dest: Destination, allowLoopback: boolean): boolean {
  if (!allowLoopback) return false;
  if ("path" in dest) return true;
  return isLoopback(dest.host);
}

function fromUrl(input: unknown): Destination {
  let href = "";
  if (typeof input === "string") href = input;
  else if (input instanceof URL) href = input.href;
  else if (isObject(input) && typeof input.url === "string") href = input.url;
  else if (isObject(input) && typeof input.href === "string") href = input.href;
  try {
    const url = new URL(href);
    return { host: url.hostname, label: url.href };
  } catch {
    return { host: "", label: href || "unknown destination" };
  }
}

// net.Socket.prototype.connect / net.connect / net.createConnection argument forms:
// (options[, cb]), (path[, cb]), (port[, host][, cb]) and the internal normalized array form [options, cb].
function fromNetArgs(args: unknown[]): Destination {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (isObject(first)) {
    if (typeof first.path === "string") return { path: first.path, label: first.path };
    const host = typeof first.host === "string" ? first.host : "localhost";
    return { host, label: `${host}:${String(first.port ?? "")}` };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first, label: first };
  const host = typeof args[1] === "string" ? args[1] : "localhost";
  return { host, label: `${host}:${String(first ?? "")}` };
}

// tls.connect: (options[, cb]), (port[, host][, options][, cb]), (path[, options][, cb]).
function fromTlsArgs(args: unknown[]): Destination {
  const first = args[0];
  if (isObject(first)) {
    if (typeof first.path === "string") return { path: first.path, label: first.path };
    const host = typeof first.host === "string" ? first.host : "localhost";
    return { host, label: `${host}:${String(first.port ?? "")}` };
  }
  return fromNetArgs(args);
}

// http.request / http.get: (url[, options][, cb]) or (options[, cb]).
function fromHttpArgs(args: unknown[], defaultProtocol: string): Destination {
  const first = args[0];
  const options = isObject(args[1]) ? args[1] : undefined;
  if (typeof first === "string" || first instanceof URL) {
    const dest = fromUrl(first);
    if (options && typeof options.socketPath === "string") return { path: options.socketPath, label: options.socketPath };
    return dest;
  }
  if (isObject(first)) {
    if (typeof first.socketPath === "string") return { path: first.socketPath, label: first.socketPath };
    const host = typeof first.hostname === "string" ? first.hostname : typeof first.host === "string" ? first.host : "localhost";
    return { host, label: `${defaultProtocol}//${host}${first.port === undefined ? "" : `:${String(first.port)}`}${typeof first.path === "string" ? first.path : "/"}` };
  }
  return { host: "localhost", label: `${defaultProtocol}//localhost/` };
}

// The policy is read at call time, so a later install can tighten it (see installNetGuard).
type GuardPolicy = { allowLoopback: boolean };

function guarded(original: AnyFn, describe: (args: unknown[]) => Destination, policy: GuardPolicy): AnyFn {
  return function guardedCall(this: unknown, ...args: unknown[]): unknown {
    const dest = describe(args);
    if (!destinationAllowed(dest, policy.allowLoopback)) throw noNetwork(dest.label);
    return original.apply(this, args);
  };
}

function blocked(label: (args: unknown[]) => string): AnyFn {
  return function blockedCall(...args: unknown[]): never {
    throw noNetwork(label(args));
  };
}

function patch(target: Patchable, key: string, make: (original: AnyFn) => AnyFn): void {
  const original = target[key];
  if (typeof original !== "function") return;
  target[key] = make(original as AnyFn);
}

function patchResolvers(target: Patchable): void {
  for (const key of Object.keys(target)) {
    if (/^resolve/.test(key) || key === "reverse") {
      patch(target, key, () => blocked((args) => `dns ${key} ${String(args[0])}`));
    }
  }
}

function patchResolverPrototype(ctor: unknown): void {
  if (typeof ctor !== "function") return;
  let proto: object | null = (ctor as { prototype: object }).prototype;
  while (proto && proto !== Object.prototype) {
    const target = proto as Patchable;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (!(/^resolve/.test(key) || key === "reverse")) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      target[key] = blocked((args) => `dns ${key} ${String(args[0])}`);
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
}

// Idempotent: the entry points are patched once per process. A second call can only tighten the policy
// (allowLoopback: false wins over true, never the reverse), so a child started with the test guard and then
// the child entry blocks loopback.
export function installNetGuard(opts: { allowLoopback: boolean }): void {
  const registry = globalThis as unknown as Record<symbol, GuardPolicy | undefined>;
  const existing = registry[GUARD_KEY];
  if (existing) {
    if (!opts.allowLoopback) existing.allowLoopback = false;
    return;
  }
  const allow: GuardPolicy = { allowLoopback: opts.allowLoopback };
  registry[GUARD_KEY] = allow;

  const net = require("node:net") as Patchable & { Socket: { prototype: Patchable } };
  const tls = require("node:tls") as Patchable;
  const http = require("node:http") as Patchable;
  const https = require("node:https") as Patchable;
  const http2 = require("node:http2") as Patchable;
  const dns = require("node:dns") as Patchable & { promises: Patchable; Resolver: unknown };
  const dnsPromises = require("node:dns/promises") as Patchable & { Resolver: unknown };
  const dgram = require("node:dgram") as Patchable;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = guarded(originalFetch, (args) => fromUrl(args[0]), allow) as typeof fetch;
  }

  patch(net.Socket.prototype, "connect", (o) => guarded(o, fromNetArgs, allow));
  patch(net, "connect", (o) => guarded(o, fromNetArgs, allow));
  patch(net, "createConnection", (o) => guarded(o, fromNetArgs, allow));
  patch(tls, "connect", (o) => guarded(o, fromTlsArgs, allow));
  for (const name of ["request", "get"]) {
    patch(http, name, (o) => guarded(o, (args) => fromHttpArgs(args, "http:"), allow));
    patch(https, name, (o) => guarded(o, (args) => fromHttpArgs(args, "https:"), allow));
  }
  patch(http2, "connect", (o) => guarded(o, (args) => fromUrl(args[0]), allow));

  const lookupDest = (args: unknown[]): Destination => {
    const host = typeof args[0] === "string" ? args[0] : "";
    return { host, label: `dns lookup ${host}` };
  };
  patch(dns, "lookup", (o) => guarded(o, lookupDest, allow));
  patch(dns, "lookupService", () => blocked((args) => `dns lookupService ${String(args[0])}`));
  patchResolvers(dns);
  for (const promises of new Set([dns.promises, dnsPromises])) {
    patch(promises, "lookup", (o) => guarded(o, lookupDest, allow));
    patch(promises, "lookupService", () => blocked((args) => `dns lookupService ${String(args[0])}`));
    patchResolvers(promises);
  }
  patchResolverPrototype(dns.Resolver);
  patchResolverPrototype(dnsPromises.Resolver);

  patch(dgram, "createSocket", () => blocked((args) => `dgram ${isObject(args[0]) ? String(args[0].type) : String(args[0])}`));

  syncBuiltinESMExports();
}
