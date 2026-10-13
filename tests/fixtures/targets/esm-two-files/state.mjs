// State held by a statically imported file: fresh per case only with the resolve hook.
export let count = 0;

export function bump() {
  count += 1;
  return count;
}
