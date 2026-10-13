// llm-trace.jsonl (spec 5.8, plan delta 14): one line per callLlm, no timestamp and no duration, every string redacted.
import type { RejectReason, Usage } from "../contracts/hypotheses.ts";
import { stableStringify } from "../contracts/stable-json.ts";
import { redactSecrets } from "../infra/redact.ts";

export type TraceEntry = {
  seq: number;
  prompt: string;
  provider: string;
  model: string;
  matchKeys: Record<string, string | number | boolean>;
  systemSha256: string;
  user: string;
  raw: string;
  repairRaw: string | null;
  parsed: unknown;
  validation: "ok" | "repaired" | "invalid";
  issues: string[];
  usage: Usage;
  rejected: { label: string; reason: RejectReason }[];
};

function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    Object.defineProperty(out, redactSecrets(k, secrets), { value: redactDeep(v, secrets), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

export function createTraceWriter(secrets: readonly string[]) {
  const entries: TraceEntry[] = [];
  return {
    /** Adds an entry and returns its sequence number (1-based). */
    append(e: Omit<TraceEntry, "seq" | "rejected">): number {
      const seq = entries.length + 1;
      entries.push({ ...e, seq, rejected: [] });
      return seq;
    },
    /** The planner's rejections for the inputs of one call. */
    setRejected(seq: number, list: TraceEntry["rejected"]): void {
      const entry = entries[seq - 1];
      if (entry) entry.rejected = list.map((r) => ({ label: r.label, reason: r.reason }));
    },
    lastSeq(): number {
      return entries.length;
    },
    entries(): readonly TraceEntry[] {
      return entries;
    },
    /** One stable JSON line per entry, with a trailing newline; "" when there is no entry. */
    text(): string {
      if (entries.length === 0) return "";
      return entries.map((e) => stableStringify(redactDeep(e, secrets))).join("\n") + "\n";
    },
  };
}

export type TraceWriter = ReturnType<typeof createTraceWriter>;
