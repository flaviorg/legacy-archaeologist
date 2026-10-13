// An ESM named import of dns.lookup (SAFE-03).
import { lookup } from "node:dns";

export function look() {
  lookup("example.com", () => {});
  return "looked up";
}
