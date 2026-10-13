// A synchronous loop the child cannot interrupt; only the parent's watchdog can (REC-03).
function spin() {
  while (true) {}
}

function ok() {
  return "ok";
}

module.exports = { spin: spin, ok: ok };
