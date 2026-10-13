// map.json (spec 5.1). Types only; no logic, no imports.

export type ToolInfo = { name: "legacy-archaeologist"; version: string };

export type SideEffectKind =
  | "Date"
  | "Math.random"
  | "performance.now"
  | "process.hrtime"
  | "crypto"
  | "fs"
  | "child_process"
  | "net"
  | "http"
  | "dns"
  | "console"
  | "process.env"
  | "timers"
  | "Intl"
  | "global-write"
  | "module-state-write";

// Every kind in declaration order (stats keys, CLI output order).
export const SIDE_EFFECT_KINDS: readonly SideEffectKind[] = [
  "Date",
  "Math.random",
  "performance.now",
  "process.hrtime",
  "crypto",
  "fs",
  "child_process",
  "net",
  "http",
  "dns",
  "console",
  "process.env",
  "timers",
  "Intl",
  "global-write",
  "module-state-write",
];

export type SideEffect = { kind: SideEffectKind; line: number; detail: string };
export type CallInfo = { callee: string; resolved: string | null; line: number; dynamic: boolean };
export type MagicNumber = { value: number; line: number; column: number };

export type FunctionInfo = {
  id: string;
  name: string;
  exported: boolean;
  exportName?: string;
  params: string[];
  callbackParam: string | null; // last param invoked as a function inside the body
  style: "sync" | "callback";
  loc: { startLine: number; endLine: number };
  range: [number, number];
  complexity: number;
  sideEffects: SideEffect[];
  calls: CallInfo[];
  magicNumbers: MagicNumber[]; // numeric literals other than 0 and 1 outside declarations of module-level constants
  readsModuleState: string[];
  writesModuleState: string[];
  writesGlobals: string[];
  sourceBytes: number;
  tooLargeForLlm: boolean; // > 8,192 bytes
};

export type ExportInfo = { name: string; kind: "function" | "value"; functionId?: string };

export type ModuleInfo = {
  file: string;
  kind: "cjs" | "esm" | "unknown";
  exports: ExportInfo[];
  externalSpecifiers: string[]; // literal require()/import specifiers that are bare non-builtin names or relative paths leaving the target folder
  moduleState: { name: string; line: number; declaration: "var" | "let" | "const" }[]; // module-level bindings written by some function
  functions: FunctionInfo[];
};

export type FileInfo = { path: string; bytes: number; sha256: string; parse: "ok" | "error"; error?: string; sourceType?: "module" | "script" };

export type StaticMap = {
  schemaVersion: 1;
  tool: ToolInfo;
  targetDir: string; // relative to the project root, POSIX
  targetSha: string;
  files: FileInfo[];
  modules: ModuleInfo[];
  hotspots: { functionId: string; complexity: number }[]; // top 5 by complexity, ties by functionId
  // unresolvedIdentifiers is spec 4.2's count of identifiers inside a `with` body or a file with direct eval.
  stats: { files: number; parsedFiles: number; functions: number; exportedFunctions: number; unresolvedCalls: number; unresolvedIdentifiers: number; sideEffects: Record<SideEffectKind, number> };
};

export const LLM_SOURCE_LIMIT_BYTES = 8192;
export const MAX_EXPORTED_FUNCTIONS = 50;
export const HOTSPOT_COUNT = 5;
