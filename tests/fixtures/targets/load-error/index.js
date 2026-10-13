// Calls its own export while loading: a mutant that makes boot(1) throw cannot even be loaded (MUT-04 error status).
function boot(n) {
  if (n) {
    return "ready";
  }
  throw new Error("boot failed");
}

boot(1);

module.exports = { boot: boot };
