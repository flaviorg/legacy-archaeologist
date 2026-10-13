// Six snippets with known cyclomatic complexity (complexity.unit).
function straight(a) {
  return a + 1;
}

function ifElse(a) {
  if (a) {
    return 1;
  } else {
    return 2;
  }
}

function loopIf(xs) {
  var n = 0;
  for (var i = 0; i < xs.length; i++) {
    if (xs[i]) n++;
  }
  return n;
}

function logical(a, b, c, d) {
  return (a && b || c) ?? d;
}

function switcher(k) {
  switch (k) {
    case 1:
      return "one";
    case 2:
      return "two";
    default:
      return "many";
  }
}

function tryTernary(f) {
  try {
    return f() ? 1 : 2;
  } catch (e) {
    return 0;
  }
}

function withNested(a) {
  var inner = function (b) {
    if (b) return 1;
    return b ? 2 : 3;
  };
  return a ? inner(a) : 0;
}

module.exports = {
  straight: straight, ifElse: ifElse, loopIf: loopIf, logical: logical,
  switcher: switcher, tryTernary: tryTernary, withNested: withNested
};
