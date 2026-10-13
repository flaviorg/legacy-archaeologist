// Calls process.exit (SAFE-08).
function exit3() {
  process.exit(3);
  return "unreachable";
}

function ok() {
  return "ok";
}

module.exports = { exit3: exit3, ok: ok };
