// The two README regions that `npm run regen` fills from the demo's goldens (DEMO-03): the hero between
// <!-- demo-hero:start --> and <!-- demo-hero:end -->, and the full log between <!-- demo-log:start --> and
// <!-- demo-log:end --> inside a <details> block. Each region holds exactly one fenced `text` block.
export type RegionName = "demo-hero" | "demo-log";

const FENCE_OPEN = "```text\n";
const FENCE_CLOSE = "```\n";

function bounds(readme: string, name: RegionName): { start: number; end: number } {
  const startMarker = `<!-- ${name}:start -->\n`;
  const endMarker = `<!-- ${name}:end -->`;
  const markerAt = readme.indexOf(startMarker);
  if (markerAt === -1 || readme.indexOf(startMarker, markerAt + 1) !== -1) throw new Error(`README: expected exactly one ${startMarker.trim()} line`);
  const endAt = readme.indexOf(endMarker, markerAt);
  if (endAt === -1) throw new Error(`README: ${endMarker} missing after ${startMarker.trim()}`);
  const inner = readme.slice(markerAt + startMarker.length, endAt);
  if (!inner.startsWith(FENCE_OPEN) || !inner.endsWith(FENCE_CLOSE)) throw new Error(`README: the ${name} region must hold one fenced text block`);
  return { start: markerAt + startMarker.length + FENCE_OPEN.length, end: endAt - FENCE_CLOSE.length };
}

/** The body of the fenced block between the markers, with its trailing newline. */
export function readRegion(readme: string, name: RegionName): string {
  const { start, end } = bounds(readme, name);
  return readme.slice(start, end);
}

/** The README with the body of that region replaced; `body` must end with a newline. */
export function replaceRegion(readme: string, name: RegionName, body: string): string {
  if (body !== "" && !body.endsWith("\n")) throw new Error("a region body must end with a newline");
  if (body.includes("```")) throw new Error("a region body cannot contain a code fence");
  const { start, end } = bounds(readme, name);
  return readme.slice(0, start) + body + readme.slice(end);
}
