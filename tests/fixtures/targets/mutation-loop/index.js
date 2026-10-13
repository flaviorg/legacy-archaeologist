// A bounded loop; replacing `+` by `-` makes it run forever, so only the replay watchdog stops the mutant (MUT-04).
function spin(n) {
  var i = 0;
  while (i < n && i < 1000) {
    i = i + 1;
  }
  return i;
}

module.exports = { spin: spin };
