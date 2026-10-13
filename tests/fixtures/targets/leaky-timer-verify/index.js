// Leaves an interval running after it returns (GEN-08): verify must still exit 0 thanks to --test-force-exit.
function start() {
  setInterval(function () {}, 1000);
  return "started";
}

module.exports = { start: start };
