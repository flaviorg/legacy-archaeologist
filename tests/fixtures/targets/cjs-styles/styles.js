// CommonJS export shapes: member assignments on module.exports and exports.
module.exports.a = function () {
  return 1;
};

exports.b = function b2(x) {
  return x * 2;
};

var c = function (p, q) {
  return p + q;
};

module.exports.c = c;

exports.limit = 3;
