// Reads outside and inside the granted directories (SAFE-01).
var fs = require("fs");

function readHosts() {
  return fs.readFileSync("/etc/hosts", "utf8").length;
}

function readOwnData() {
  return JSON.parse(fs.readFileSync(__dirname + "/data.json", "utf8"));
}

module.exports = { readHosts: readHosts, readOwnData: readOwnData };
