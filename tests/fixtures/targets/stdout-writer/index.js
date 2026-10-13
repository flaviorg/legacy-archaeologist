// Writes straight to stdout and stderr; the parent counts the bytes and never parses them (SAFE-08).
function noisy() {
  process.stdout.write("o".repeat(1000));
  process.stderr.write("e".repeat(1000));
  return "quiet";
}

module.exports = { noisy: noisy };
