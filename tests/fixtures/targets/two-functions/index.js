// Two small functions for the fake provider's unit fixture (tests/fixtures/llm/unit-mini.json).
function a(x) {
  return x * 2;
}

function b(x, y) {
  return x > y ? x : y;
}

module.exports = { a: a, b: b };
