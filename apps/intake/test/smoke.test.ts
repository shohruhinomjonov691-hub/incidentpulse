import { expect, test } from "vitest";
import { buildServer, TOLERANCE_SECONDS } from "../src/index.ts";

test("intake serves /health and uses a 5-minute replay window", async () => {
  const app = buildServer({
    secret: "s".repeat(32),
    queue: { enqueue: async () => ({ incidentId: "x", deduplicated: false }) },
  });
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.json()).toEqual({ status: "ok", service: "intake" });
  expect(TOLERANCE_SECONDS).toBe(300);
  await app.close();
});
