import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

export type ChildResult = { code: number | null; signal: string | null; stdout: string; stderr: string };

export const GUARD_URL = pathToFileURL(join(PROJECT_ROOT, "tests/setup/no-network.ts")).href;

// Runs `node --import <guard> ...args` with an explicit minimal environment (never the parent's).
export function runNode(args: string[], opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {}): Promise<ChildResult> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...opts.env };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", GUARD_URL, ...args], { cwd: opts.cwd ?? PROJECT_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

export function runCli(args: string[], opts?: { env?: Record<string, string>; cwd?: string; timeoutMs?: number }): Promise<ChildResult> {
  return runNode(["src/cli.ts", ...args], opts);
}
