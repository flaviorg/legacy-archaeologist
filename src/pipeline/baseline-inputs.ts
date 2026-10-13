// The `none` provider's proposals (spec 5.2 baseline value table, HYP-06): a pure function of the static map.
// The baseline is a floor built from the map alone; the LLM's advantage is measured against it.
import type { HypothesisOutput } from "../contracts/hypotheses.ts";
import type { FunctionInfo } from "../contracts/map.ts";
import type { Tagged } from "../contracts/tagged.ts";

const CLOCK_NOW = 1_700_000_000_000; // the frozen clock, 2023-11-14T22:13:20.000Z
const DAY_MS = 86_400_000;
const clockDate = (offsetMs: number): Tagged => ({ $t: "Date", v: new Date(CLOCK_NOW + offsetMs).toISOString() });

export const BASELINE_SEEDS: readonly { value: Tagged; text: string }[] = [
  { value: 0, text: "0" },
  { value: 1, text: "1" },
  { value: -1, text: "-1" },
  { value: 2, text: "2" },
  { value: 100, text: "100" },
  { value: -0.5, text: "-0.5" },
  { value: "", text: "empty string" },
  { value: "x", text: '"x"' },
  { value: true, text: "true" },
  { value: false, text: "false" },
  { value: null, text: "null" },
  { value: { $t: "undefined" }, text: "undefined" },
  { value: [], text: "empty array" },
  { value: [{}], text: "array of one empty object" },
  { value: {}, text: "empty object" },
  { value: clockDate(0), text: "the frozen clock date" },
  { value: { $t: "NaN" }, text: "NaN" },
];

const BASE_BY_POSITION: readonly Tagged[] = [0, 1, "x"];
const DATE_TOKENS = new Set(["date", "day", "at", "on"]);
const DATE_OFFSETS: readonly { days: number; text: string }[] = [
  { days: -31, text: "frozen clock - 31 days" },
  { days: -1, text: "frozen clock - 1 day" },
  { days: 1, text: "frozen clock + 1 day" },
  { days: 31, text: "frozen clock + 31 days" },
];

/** True when a name token (split on camelCase boundaries, `_` and digits, lowercased) is date, day, at or on. */
export function isDateNamed(param: string): boolean {
  const tokens = param
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\d$]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t !== "");
  return tokens.some((t) => DATE_TOKENS.has(t));
}

const roundBoundary = (v: number): number => {
  const r = Math.round(v * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
};

function magicBoundaries(m: number): { value: number; text: string }[] {
  if (Number.isInteger(m)) {
    return [
      { value: m, text: `${m} (magic number)` },
      { value: m - 1, text: `${m - 1} (magic number ${m} - 1)` },
      { value: m + 1, text: `${m + 1} (magic number ${m} + 1)` },
    ];
  }
  const below = roundBoundary(m - 0.01);
  const above = roundBoundary(m + 0.01);
  return [
    { value: m, text: `${m} (magic number)` },
    { value: below, text: `${below} (magic number ${m} - 0.01)` },
    { value: above, text: `${above} (magic number ${m} + 0.01)` },
  ];
}

export function baselineProposals(fn: FunctionInfo): HypothesisOutput {
  const params = fn.params.filter((p) => p !== fn.callbackParam); // the recorder supplies the callback
  const base = (): Tagged[] => params.map((_, i) => structuredClone(BASE_BY_POSITION[i] ?? null));
  const varied = (position: number, value: Tagged): Tagged[] => {
    const args = base();
    args[position] = structuredClone(value);
    return args;
  };
  const partitions: HypothesisOutput["partitions"] = [{ label: "base vector", steps: [{ args: base() }] }];

  params.forEach((_, i) => {
    for (const seed of BASELINE_SEEDS) partitions.push({ label: `arg ${i + 1} = ${seed.text}`, steps: [{ args: varied(i, seed.value) }] });
  });

  const magic: number[] = [];
  for (const m of fn.magicNumbers) if (!magic.includes(m.value)) magic.push(m.value);
  params.forEach((_, i) => {
    for (const m of magic) {
      for (const b of magicBoundaries(m)) partitions.push({ label: `arg ${i + 1} = ${b.text}`, steps: [{ args: varied(i, b.value) }] });
    }
  });

  params.forEach((p, i) => {
    if (!isDateNamed(p)) return;
    for (const d of DATE_OFFSETS) partitions.push({ label: `arg ${i + 1} = ${d.text}`, steps: [{ args: varied(i, clockDate(d.days * DAY_MS)) }] });
  });

  if (fn.writesModuleState.length > 0) partitions.push({ label: "sequence of 3 calls", steps: [{ args: base() }, { args: base() }, { args: base() }] });
  return { rules: [], partitions };
}
