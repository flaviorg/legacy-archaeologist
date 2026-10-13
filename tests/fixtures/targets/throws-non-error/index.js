// Thrown values that are not errors (REC-05).
function str() { throw "boom"; }
function num() { throw 42; }
function nul() { throw null; }
function obj() { throw { code: "E1" }; }

module.exports = { str: str, num: num, nul: nul, obj: obj };
