import { expect, test } from "vitest";
import { CONTRACTS, IncidentStateSchema } from "../src/index.ts";

test("package exports the IncidentState schema and the contract registry", () => {
  expect(IncidentStateSchema).toBeDefined();
  expect(Object.keys(CONTRACTS)).toEqual([
    "incident-state.schema.json",
    "debate-request.schema.json",
    "debate-verdict.schema.json",
  ]);
});
