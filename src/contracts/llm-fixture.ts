// Fake provider fixture format (spec 7.2, plus targetDir from plan delta 12). Scripted outputs are checked against
// their prompt's schema by the fake when it loads the fixture, not here.
import * as z from "zod";

const whenValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const usageSchema = z.object({ promptTokens: z.number().int().min(0), completionTokens: z.number().int().min(0) }).strict();

const errorSchema = z.union([
  z.object({ kind: z.enum(["timeout", "rate_limit", "server_error"]) }).strict(),
  z.object({ kind: z.literal("invalid_output"), raw: z.string() }).strict(),
]);

const turnSchema = z
  .object({
    id: z.string().min(1).max(120),
    prompt: z.string().min(1),
    when: z.record(z.string(), whenValueSchema),
    output: z.unknown().optional(),
    error: errorSchema.optional(),
    usage: usageSchema.optional(),
  })
  .strict()
  .refine((t) => (t.output !== undefined) !== (t.error !== undefined), { message: "a turn needs exactly one of output and error" });

export const llmFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenario: z.string().min(1),
    targetDir: z.string().min(1), // project-relative, POSIX; used by fixtures:rehash
    targetSha: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    promptHashes: z.record(z.string(), z.string()),
    turns: z.array(turnSchema),
  })
  .strict()
  .refine((f) => new Set(f.turns.map((t) => t.id)).size === f.turns.length, { message: "turn ids must be unique" });

export type LlmFixture = z.infer<typeof llmFixtureSchema>;
export type LlmFixtureTurn = LlmFixture["turns"][number];
