// Callback-style functions (REC-04).
function syncCb(x, cb) {
  cb(null, x * 2);
}

function asyncCb(x, cb) {
  setTimeout(function () {
    cb(null, x + 1);
  }, 10);
}

function errCb(cb) {
  cb(new Error("bad"));
}

function twice(cb) {
  cb(1);
  cb(2);
}

function throwsFirst(x, cb) {
  throw new Error("before " + x);
}

module.exports = { syncCb: syncCb, asyncCb: asyncCb, errCb: errCb, twice: twice, throwsFirst: throwsFirst };
