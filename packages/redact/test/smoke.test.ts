import { expect, test } from "vitest";
import { createRedactor } from "../src/index.ts";

test("package is wired into the workspace", () => {
  expect(createRedactor()("plain")).toBe("plain");
});
