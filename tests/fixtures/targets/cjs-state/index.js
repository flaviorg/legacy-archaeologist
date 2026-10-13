// Exported values change as a function runs (GEN-09). The keys are in alphabetical order, which is the order an ESM
// namespace has, so the recorded stateAfter is the same for this file and for its ESM copy (esm-state).
var state = { total: 0 };

function bump(step) {
  state.total += typeof step === "number" ? step : 1;
  module.exports.total = state.total;
  return state.total;
}

module.exports = { bump: bump, label: "state", total: 0 };
