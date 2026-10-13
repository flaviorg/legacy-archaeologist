// Exported state that differs between runs while every step's outcome is the same (REC-06, instability step 0).
exports.loadedBy = process.pid;

exports.one = function () {
  return 1;
};
