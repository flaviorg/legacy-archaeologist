// Module-level state (REC-02): a fresh instance per case, shared by the steps of one case.
var n = 1000;

exports.next = function () {
  return ++n;
};
