// Floods stdout, stderr and fd 3 past the parent's caps (SAFE-04).
var fs = require("fs");

function bigStdout() {
  process.stdout.write("x".repeat(8 * 1024 * 1024));
  return "wrote";
}

function bigStderr() {
  process.stderr.write("y".repeat(2 * 1024 * 1024));
  return "wrote";
}

function bigFd3() {
  fs.writeSync(3, "z".repeat(2 * 1024 * 1024));
  return "wrote";
}

function ok() {
  return "ok";
}

module.exports = { bigStdout: bigStdout, bigStderr: bigStderr, bigFd3: bigFd3, ok: ok };
