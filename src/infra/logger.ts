import { redactSecrets } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type Logger = {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Redacts every string inside the fields before serializing, so a secret with JSON-escaped characters
// cannot survive as its escaped form; the whole line is redacted again afterwards.
function redactDeep(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets, seen));
  if (value instanceof Error) return { name: value.name, message: redactSecrets(value.message, secrets) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[redactSecrets(k, secrets)] = redactDeep(v, secrets, seen);
  return out;
}

// One JSON line per event on stderr (spec 5.8); stdout stays reserved for the human summary.
export function createLogger(opts: { level: LogLevel; secrets?: readonly string[]; write?: (line: string) => void }): Logger {
  const secrets = opts.secrets ?? [];
  const write = opts.write ?? ((line: string) => { process.stderr.write(line + "\n"); });
  const min = RANK[opts.level];
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (RANK[level] < min) return;
    const safe = redactDeep(fields ?? {}, secrets, new WeakSet()) as LogFields;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event: redactSecrets(event, secrets), ...safe });
    write(redactSecrets(line, secrets));
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
