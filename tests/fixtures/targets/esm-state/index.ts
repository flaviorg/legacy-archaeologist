// The ESM TypeScript copy of cjs-state (GEN-08, GEN-09): same behavior, same exported values.
let count = 0;

export let total = 0;
export const label = "state";

export function bump(step: unknown): number {
  count += typeof step === "number" ? step : 1;
  total = count;
  return count;
}
