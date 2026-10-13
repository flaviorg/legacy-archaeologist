// The only value importer of acorn (dependency rule 2). Offsets are UTF-16 string offsets into `text`.
import { getLineInfo, parse, tokenizer } from "acorn";
import type { Comment, Options, Program } from "acorn";

export type SourceType = "module" | "script";

export type ParsedFile = {
  path: string;
  text: string;
  program: Program | null;
  sourceType: SourceType | null;
  comments: Comment[];
  error: string | null;
};

export type SourceToken = { start: number; end: number; text: string };

function options(sourceType: SourceType, comments?: Comment[]): Options {
  return { ecmaVersion: "latest", sourceType, locations: true, ranges: true, allowHashBang: true, ...(comments ? { onComment: comments } : {}) };
}

type Attempt = { ok: true; program: Program; comments: Comment[] } | { ok: false; error: string };

function attempt(text: string, sourceType: SourceType): Attempt {
  const comments: Comment[] = [];
  try {
    return { ok: true, program: parse(text, options(sourceType, comments)), comments };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function hasModuleSyntax(program: Program): boolean {
  return program.body.some((s) => s.type === "ImportDeclaration" || s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration" || s.type === "ExportAllDeclaration");
}

/**
 * Parses with `sourceType: "module"` first, then `"script"`. A module parse with no import or export declaration
 * is a CommonJS or plain script file, so it is re-parsed as a script and reported as one when that succeeds
 * (sloppy-mode semantics are the right reading for it); it stays `module` only when the script parse fails.
 * When both modes fail, `error` is the script attempt's message.
 */
export function parseSource(path: string, text: string): ParsedFile {
  const asModule = attempt(text, "module");
  if (asModule.ok && hasModuleSyntax(asModule.program)) {
    return { path, text, program: asModule.program, sourceType: "module", comments: asModule.comments, error: null };
  }
  const asScript = attempt(text, "script");
  if (asScript.ok) return { path, text, program: asScript.program, sourceType: "script", comments: asScript.comments, error: null };
  if (asModule.ok) return { path, text, program: asModule.program, sourceType: "module", comments: asModule.comments, error: null };
  return { path, text, program: null, sourceType: null, comments: [], error: asScript.error };
}

export function reparseOk(text: string, sourceType: SourceType): boolean {
  return attempt(text, sourceType).ok;
}

// One tokenizer pass over the whole source (tokenizing a gap alone throws on `/`; plan delta 5).
export function tokenize(text: string, sourceType: SourceType): SourceToken[] {
  const out: SourceToken[] = [];
  for (const t of tokenizer(text, options(sourceType))) out.push({ start: t.start, end: t.end, text: text.slice(t.start, t.end) });
  return out;
}

// Line (1-based) and column (0-based, UTF-16 units) of an offset, with acorn's own line-break rules.
export function positionOf(text: string, offset: number): { line: number; column: number } {
  const info = getLineInfo(text, offset);
  return { line: info.line, column: info.column };
}
