// Reads a file that does not exist inside the target (REC-07: the message names <target>).
var fs = require("fs");

function readMissing() {
  return fs.readFileSync(__dirname + "/nope.txt", "utf8");
}

module.exports = { readMissing: readMissing };
