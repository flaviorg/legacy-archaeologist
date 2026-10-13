// A callback-style function that never calls back (REC-04).
function never(x, cb) {
  if (x === -1) cb(null, x);
  return x;
}

module.exports = { never: never };
