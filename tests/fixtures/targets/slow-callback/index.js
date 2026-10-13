// Calls back after 200 ms: each step is within a 300 ms caseTimeoutMs (REC-03).
function slow(cb) {
  setTimeout(function () {
    cb(null, "done");
  }, 200);
}

module.exports = { slow: slow };
