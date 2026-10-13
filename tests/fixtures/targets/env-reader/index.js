// Reports the environment keys the child can see (SAFE-05).
exports.keys = function () {
  return Object.keys(process.env);
};
