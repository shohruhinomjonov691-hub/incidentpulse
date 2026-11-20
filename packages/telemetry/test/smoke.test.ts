import { expect, test } from "vitest";
import { PACKAGE_NAME } from "../src/index.ts";

test("package is wired into the workspace", () => {
  expect(PACKAGE_NAME).toBe("@incidentpulse/telemetry");
});
