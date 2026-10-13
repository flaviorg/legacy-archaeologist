// Returns the process id, which differs between the two recording runs (REC-06).
function pid() {
  return process.pid;
}

function one() {
  return 1;
}

module.exports = { pid: pid, one: one };
