// The return value never changes; only the exported count shows what inc did (MUT-04 kill through stateAfter).
var count = 0;

function inc(step) {
  count = count + step;
  module.exports.count = count;
  return true;
}

module.exports = { count: 0, inc: inc };
