// Requires an npm package and a file above the target folder (EXTERNAL_DEPENDENCY in v1).
var leftpad = require("leftpad");
var shared = require("../shared.js");
var fs = require("fs");
var path = require("node:path");
var local = require("./ok.js");

function pad(s) {
  return leftpad(shared.prefix + s, 8) + local.ok() + path.sep + typeof fs;
}

module.exports = { pad: pad };
