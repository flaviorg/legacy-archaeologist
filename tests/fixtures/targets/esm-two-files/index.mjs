// Re-exports the counter, so stateAfter shows it.
import { bump } from "./state.mjs";

export { count } from "./state.mjs";

export function next() {
  return bump();
}
