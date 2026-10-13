// Writes a file next to itself; the child has no write grant at all (SAFE-02).
var fs = require("fs");

function write() {
  fs.writeFileSync(__dirname + "/out.txt", "x");
  return "written";
}

module.exports = { write: write };
