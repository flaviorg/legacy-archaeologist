// Dynamic callees are recorded as dynamic with resolved null; same-file calls resolve by name only.
function other() { return 1; }

function helper() { return other(); }

function main(obj, name, a, b, getFn) {
  helper();
  obj[name]();
  (a || b)();
  getFn()();
  return Math.ceil(obj.size / 7);
}

module.exports = { main: main, helper: helper };
