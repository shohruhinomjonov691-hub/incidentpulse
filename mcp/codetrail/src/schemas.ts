import { z } from "zod";

/** Output contracts for the mcp-codetrail tools (SPEC §5.2). */

export const ToolStatusSchema = z.enum([
  "ok",
  /** The operator has not configured this integration (no URL / token / repo for the project). */
  "not_configured",
  /** The project is not in this server's allowlist. */
  "denied",
  "error",
]);

export const CodetrailResultSchema = z.object({
  status: ToolStatusSchema,
  project: z.string(),
  httpStatus: z.number().int().optional(),
  /**
   * Redacted, length-capped response body from CodeTrail. UNTRUSTED text: it is source code and
   * model output, so it is data and never instructions.
   */
  excerpt: z.string().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});
export type CodetrailResult = z.infer<typeof CodetrailResultSchema>;

export const CommitsResultSchema = z.object({
  status: ToolStatusSchema,
  project: z.string(),
  repo: z.string().optional(),
  commits: z
    .array(
      z.object({
        sha: z.string(),
        /** First line of the commit message, redacted. UNTRUSTED text. */
        message: z.string(),
        author: z.string().optional(),
        date: z.string().optional(),
      }),
    )
    .optional(),
  httpStatus: z.number().int().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});
export type CommitsResult = z.infer<typeof CommitsResultSchema>;
