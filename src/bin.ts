// The `npm run la` entry: loads ./.env when it exists, then runs the CLI. Node 24.21's --env-file-if-exists prints
// ".env not found. Continuing without it." on every run without one; process.loadEnvFile is silent and, like the flag,
// never overrides a variable already set in the environment. Tests run src/cli.ts directly and never read a .env.
import { existsSync } from "node:fs";
import { runFromProcess } from "./cli.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
await runFromProcess();
