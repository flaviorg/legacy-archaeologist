// Errors with name, message and code (REC-04).
function typeErr(x) {
  return x.y;
}

function custom() {
  var err = new Error("custom failure");
  err.code = "E_CUSTOM";
  throw err;
}

module.exports = { typeErr: typeErr, custom: custom };
