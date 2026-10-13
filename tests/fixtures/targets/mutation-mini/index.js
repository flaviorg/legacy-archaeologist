// A fee with one threshold: the mutation tests read its statuses (MUT-04, MUT-05, DEMO-06).
function fee(n) {
  if (n > 10) {
    return 5;
  }
  return 0;
}

module.exports = { fee: fee };
