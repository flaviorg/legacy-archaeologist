// An anonymous function in the default slot plus a declared helper.
module.exports = function (x) {
  return helper(x);
};

function helper(y) {
  return y + 1;
}

module.exports.helper = helper;
