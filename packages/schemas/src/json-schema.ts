import { z } from "zod";
import { IncidentStateSchema } from "./incident-state.ts";

/** File name (inside json/) -> zod schema. Add new shared contracts here. */
export const CONTRACTS = {
  "incident-state.schema.json": IncidentStateSchema,
} as const;

/** Serialised exactly as it is written to disk, so the drift test can compare strings. */
export function renderJsonSchema(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" });
  return `${JSON.stringify(json, null, 2)}\n`;
}
