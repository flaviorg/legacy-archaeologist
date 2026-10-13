// Kills its own process (SAFE-08).
function killSelf() {
  process.kill(process.pid, "SIGKILL");
  return "unreachable";
}

function ok() {
  return "ok";
}

module.exports = { killSelf: killSelf, ok: ok };
