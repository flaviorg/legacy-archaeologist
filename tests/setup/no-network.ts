// Loaded with --import by every npm test script, so no test can reach the network (REP-03).
// Same pattern as projetos/incident-copilot/tests/setup/no-network.ts, extended to every network entry point.
// Loopback stays allowed in the test process so tests can run local servers.
import { installNetGuard } from "../../src/harness/child/net-guard.ts";

installNetGuard({ allowLoopback: true });
