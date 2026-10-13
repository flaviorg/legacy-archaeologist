// The shape every versioned prompt has (spec 4.4). The system text and the version feed the fixture's prompt hash.
import type * as z from "zod";

export type PromptSpec<I, O> = {
  version: string;
  system: string;
  buildUser(input: I): string;
  outputSchema: z.ZodType<O>;
  matchKeys(input: I): Record<string, string | number | boolean>;
};
