// Functions that return thenables (REC-04).
function resolves(x) {
  return Promise.resolve(x * 2);
}

function rejects() {
  return Promise.reject(new RangeError("no"));
}

function never() {
  return new Promise(function () {});
}

function thenable() {
  return { then: function (resolve) { resolve(5); } };
}

function later(x) {
  return new Promise(function (resolve) {
    setTimeout(function () { resolve(x); }, 20);
  });
}

module.exports = { resolves: resolves, rejects: rejects, never: never, thenable: thenable, later: later };
