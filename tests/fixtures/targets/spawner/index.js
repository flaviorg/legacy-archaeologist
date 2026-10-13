// Starts a process and a worker (SAFE-02).
function exec() {
  return String(require("child_process").execSync("echo hi"));
}

function worker() {
  var Worker = require("worker_threads").Worker;
  new Worker("1 + 1", { eval: true });
  return "started";
}

module.exports = { exec: exec, worker: worker };
