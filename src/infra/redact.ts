// One redaction function for every string that leaves the process (logs, trace, error lines, CLI output, artifacts).
export const KEY_PATTERNS: readonly RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
];

const REDACTED = "[REDACTED]";
const MIN_EXTRA_LENGTH = 8;

export function redactSecrets(text: string, extraValues: readonly string[] = []): string {
  let out = text;
  const extras = extraValues.filter((v) => v.length >= MIN_EXTRA_LENGTH).sort((a, b) => b.length - a.length);
  for (const value of extras) out = out.split(value).join(REDACTED);
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
