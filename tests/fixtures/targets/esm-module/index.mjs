// ESM export shapes.
export function f(a, b) {
  return a + b;
}

export const g = (x) => x;

export default function () {
  return "default";
}

function h() {
  return "h";
}

export { h as hh };
