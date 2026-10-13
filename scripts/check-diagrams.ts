// node scripts/check-diagrams.ts (npm run diagrams:check): renders every docs/diagrams/*.mmd and every fenced
// `mermaid` block of README.md with mermaid-cli 12.0.0 and fails on a non-zero exit. A local authoring step only:
// it needs `npx` (the package and a headless Chrome from the local cache, or the network), so CI and `npm test`
// never run it; CI checks offline that the README block equals docs/diagrams/pipeline.mmd (conventions.unit).
// Output: LA_DIAGRAMS_OUT, default /private/tmp/la-diagrams (nothing is committed).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/infra/paths.ts";

const MERMAID_CLI = "@mermaid-js/mermaid-cli@12.0.0";

function readmeBlocks(readme: string): string[] {
  return [...readme.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1] as string);
}

function main(): number {
  const outDir = process.env.LA_DIAGRAMS_OUT ?? "/private/tmp/la-diagrams";
  mkdirSync(outDir, { recursive: true });
  const inputs: { name: string; text: string }[] = [];
  const dir = join(PROJECT_ROOT, "docs", "diagrams");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".mmd")).sort()) inputs.push({ name: f.replace(/\.mmd$/, ""), text: readFileSync(join(dir, f), "utf8") });
  readmeBlocks(readFileSync(join(PROJECT_ROOT, "README.md"), "utf8")).forEach((text, i) => inputs.push({ name: `readme-${i + 1}`, text }));
  let failed = 0;
  for (const { name, text } of inputs) {
    const input = join(outDir, `${name}.mmd`);
    const output = join(outDir, `${name}.svg`);
    writeFileSync(input, text);
    const r = spawnSync("npx", ["-y", MERMAID_CLI, "-i", input, "-o", output], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status === 0) {
      process.stdout.write(`diagrams:check: ${name} rendered to ${output}\n`);
    } else {
      failed += 1;
      process.stderr.write(`diagrams:check: ${name} failed (exit ${String(r.status)})\n${(r.stderr ?? "").split("\n").slice(0, 20).join("\n")}\n`);
    }
  }
  process.stdout.write(`diagrams:check: ${inputs.length} diagrams, ${failed} failed\n`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
