// Timers created while a case runs are tracked and cleared when it ends (spec 5.4, Task 14). Imports only node:*.
// The harness keeps the real functions for its own waits, so clearing the target's timers never touches them.
import { createRequire, syncBuiltinESMExports } from "node:module";

type AnyFn = (...args: any[]) => any;
type Patchable = Record<string, unknown>;

const require = createRequire(import.meta.url);

export type RealTimers = {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setImmediate: typeof globalThis.setImmediate;
};

export type TimerTracker = { real: RealTimers; startCase(): void; endCase(): void };

export function installTimerTracking(): TimerTracker {
  const real: RealTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setImmediate: globalThis.setImmediate };
  const clearers: Record<string, AnyFn> = { setTimeout: globalThis.clearTimeout, setInterval: globalThis.clearInterval, setImmediate: globalThis.clearImmediate };
  let tracking = false;
  let live: { clear: AnyFn; handle: unknown }[] = [];

  const wrap = (name: "setTimeout" | "setInterval" | "setImmediate", original: AnyFn): AnyFn => {
    const clear = clearers[name] as AnyFn;
    return function trackedTimer(this: unknown, ...args: unknown[]): unknown {
      const handle: unknown = original.apply(this, args);
      if (tracking) live.push({ clear, handle });
      return handle;
    };
  };

  const timersModule = require("node:timers") as Patchable;
  for (const name of ["setTimeout", "setInterval", "setImmediate"] as const) {
    const wrapped = wrap(name, (globalThis as unknown as Record<string, AnyFn>)[name] as AnyFn);
    (globalThis as unknown as Patchable)[name] = wrapped;
    timersModule[name] = wrapped;
  }
  syncBuiltinESMExports();

  return {
    real,
    startCase(): void {
      live = [];
      tracking = true;
    },
    endCase(): void {
      tracking = false;
      for (const t of live) t.clear(t.handle);
      live = [];
    },
  };
}
