import test from "node:test";
import assert from "node:assert/strict";
import { parseTap } from "../../src/pipeline/tap.ts";

test("[GEN-08] parseTap reads ok and not ok lines, unescapes \\# and extracts single-line and block messages", () => {
  const tap = "TAP version 13\n# Subtest: [a\\#c01] p\nok 1 - [a\\#c01] p\n  ---\n  duration_ms: 1\n  ...\nnot ok 2 - [a\\#c02] q\n  ---\n  error: 'expected returned 100   actual returned 90 isn''t'\n  ...\nnot ok 3 - [a\\#c03] r\n  ---\n  error: |-\n    first line\n    second\n  ...\n1..3\n# tests 3\n# pass 1\n# fail 2\n";
  const r = parseTap(tap);
  assert.deepEqual(r.tests.map((x) => [x.ok, x.name, x.message]), [[true, "[a#c01] p", null], [false, "[a#c02] q", "expected returned 100   actual returned 90 isn't"], [false, "[a#c03] r", "first line"]]);
  assert.deepEqual(r.summary, { tests: 3, pass: 1, fail: 2 });
});

test("[GEN-08] parseTap reads the quoting node's TAP reporter really uses (util.inspect style)", () => {
  // Captured from node 24.21 --test-reporter=tap (see docs/api-notes.md).
  const tap = [
    "TAP version 13",
    "not ok 1 - [a\\#c01] dq",
    "  ---",
    "  duration_ms: 0.2",
    "  error: 'expected returned \"INV\"   actual returned \"X\"'",
    "  code: 'ERR_ASSERTION'",
    "  ...",
    "not ok 2 - [a\\#c02] sq",
    "  ---",
    "  error: \"it isn't\"",
    "  ...",
    "not ok 3 - [a\\#c03] both",
    "  ---",
    "  error: `it isn't \"x\"`",
    "  ...",
    "not ok 4 - [a\\#c04] backslash and unicode",
    "  ---",
    "  error: 'path \\\\ é → ok\\ttab'",
    "  ...",
    "ok 5 - [a\\\\\\#c05] hash \\# name \\\\ back",
    "  ---",
    "  duration_ms: 0.1",
    "  ...",
    "not ok 6 - [a\\#c06] all three",
    "  ---",
    "  error: 'a \\' b \" c ` d'",
    "  ...",
    "  # Subtest: nested",
    "    not ok 1 - nested child",
    "1..6",
    "# tests 6",
    "# suites 0",
    "# pass 1",
    "# fail 5",
    "",
  ].join("\n");
  const r = parseTap(tap);
  assert.deepEqual(r.tests.map((x) => [x.ok, x.name, x.message]), [
    [false, "[a#c01] dq", 'expected returned "INV"   actual returned "X"'],
    [false, "[a#c02] sq", "it isn't"],
    [false, "[a#c03] both", 'it isn\'t "x"'],
    [false, "[a#c04] backslash and unicode", "path \\ é → ok\ttab"],
    [true, "[a\\#c05] hash # name \\ back", null],
    [false, "[a#c06] all three", "a ' b \" c ` d"],
  ]);
  assert.deepEqual(r.summary, { tests: 6, pass: 1, fail: 5 });
});

test("parseTap on a truncated stream keeps the lines it saw and has no summary", () => {
  const r = parseTap("TAP version 13\nok 1 - [x#c01] a\n  ---\n  duration_ms: 1\n  ...\nnot ok 2 - [x#c02] b\n  ---\n");
  assert.deepEqual(r.tests.map((x) => [x.ok, x.name, x.message]), [[true, "[x#c01] a", null], [false, "[x#c02] b", null]]);
  assert.equal(r.summary, null);
});
