// Timers left running by a case, and errors thrown by them later (REC-04, delta 11).
function startInterval() {
  setInterval(function () {
    global.__laTicks = (global.__laTicks || 0) + 1;
  }, 1);
  return "started";
}

// Callback-style: how many interval ticks happen during the next 50 ms.
function ticksDuring(cb) {
  var before = global.__laTicks || 0;
  setTimeout(function () {
    cb(null, (global.__laTicks || 0) - before);
  }, 50);
}

function throwLater() {
  setTimeout(function () {
    throw new Error("late");
  }, 0);
  return "scheduled";
}

function rejectLater() {
  Promise.reject(new Error("unhandled"));
  return "rejected";
}

function ok() {
  return "ok";
}

module.exports = { startInterval: startInterval, ticksDuring: ticksDuring, throwLater: throwLater, rejectLater: rejectLater, ok: ok };
