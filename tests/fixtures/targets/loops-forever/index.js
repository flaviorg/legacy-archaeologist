// The same export as tests/fixtures/targets/sequence, but it never returns (GEN-08: the file watchdog kills it).
exports.next = function () {
  while (true) {
    // spin
  }
};
