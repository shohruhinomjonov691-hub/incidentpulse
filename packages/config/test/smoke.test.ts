import { expect, test } from "vitest";
import { DEFAULT_PROJECT_DOMAINS } from "../src/index.ts";

test("package is wired into the workspace", () => {
  expect(DEFAULT_PROJECT_DOMAINS.kervan).toEqual(["kervan.uz"]);
});
