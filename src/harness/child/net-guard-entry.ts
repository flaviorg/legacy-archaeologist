// The --import entry for the recorder child and for `verify`: network blocked, loopback included.
import { installNetGuard } from "./net-guard.ts";

installNetGuard({ allowLoopback: false });
