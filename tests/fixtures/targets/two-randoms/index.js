// Several cases of one file depend on Math.random, the counters and the clock (GEN-01): each emitted test must
// re-seed the world through loadFresh, whatever the test order.
function roll(sides) {
  return Math.floor(Math.random() * sides);
}

function pair() {
  return [Math.random(), Math.random()];
}

function stamp(tag) {
  return tag + ":" + performance.now() + ":" + Date.now() + ":" + Math.random();
}

module.exports = { roll: roll, pair: pair, stamp: stamp };
