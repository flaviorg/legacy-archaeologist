// node scripts/eval-llm.ts --baseline <dir> --candidate <dir>: prints the DEMO-05 table that compares a provider's run
// with the `none` baseline on the same target, from hypotheses.json, records.json and mutation.json of each run.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LaError, formatErrorLine } from "../src/infra/errors.ts";
import { evalLlm, renderEvalTable } from "../src/pipeline/eval-llm.ts";
import type { RunArtifacts } from "../src/pipeline/eval-llm.ts";

const USAGE = "usage: node scripts/eval-llm.ts --baseline <run dir> --candidate <run dir>";

function readRun(dir: string, flag: string): RunArtifacts {
  const read = (name: string): unknown => {
    const path = join(dir, name);
    if (!existsSync(path)) throw new LaError("USAGE", `--${flag}: ${name} not found in ${dir}`);
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new LaError("USAGE", `--${flag}: ${name} in ${dir} is not valid JSON`);
    }
  };
  return { hypotheses: read("hypotheses.json"), records: read("records.json"), mutation: read("mutation.json") } as RunArtifacts;
}

export function main(argv: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    let values: { baseline?: string; candidate?: string };
    try {
      values = parseArgs({ args: argv, options: { baseline: { type: "string" }, candidate: { type: "string" } }, strict: true, allowPositionals: false }).values;
    } catch (err) {
      throw new LaError("USAGE", `${err instanceof Error ? err.message.split("\n")[0] : String(err)}; ${USAGE}`);
    }
    if (!values.baseline || !values.candidate) throw new LaError("USAGE", USAGE);
    const table = evalLlm(readRun(resolve(cwd, values.baseline), "baseline"), readRun(resolve(cwd, values.candidate), "candidate"));
    return { code: 0, stdout: renderEvalTable(table), stderr: "" };
  } catch (err) {
    const { line } = formatErrorLine(err instanceof LaError ? err : new LaError("USAGE", `the runs could not be compared: ${err instanceof Error ? err.message : String(err)}`), []);
    return { code: 1, stdout: "", stderr: line + "\n" };
  }
}

if (import.meta.main) {
  const r = main(process.argv.slice(2), process.cwd());
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
