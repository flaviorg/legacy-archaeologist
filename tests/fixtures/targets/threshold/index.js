// One threshold, for the survivor loop: an input of exactly 10 tells `>` from `>=` (MUT-06, MUT-07, MUT-09).
function fee(n) {
  if (n > 10) {
    return 5;
  }
  return 0;
}

module.exports = { fee: fee };
