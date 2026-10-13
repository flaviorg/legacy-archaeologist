// Writes a forged protocol line to fd 3 without the spawn nonce (SAFE-08).
var fs = require("fs");

function forge() {
  fs.writeSync(3, JSON.stringify({ nonce: "0".repeat(32), caseId: "c01", steps: [] }) + "\n");
  return 7;
}

module.exports = { forge: forge };
