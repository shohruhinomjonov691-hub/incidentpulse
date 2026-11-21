import { createJournal } from "@incidentpulse/orchestrator/journal";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { PASSWORD, SCHEMA } from "../playwright.config.ts";
import { INCIDENT } from "./global-setup.ts";

test.skip(!process.env.IT_DATABASE_URL, "IT_DATABASE_URL and IT_REDIS_URL are required");

test("pages are protected until the admin signs in", async ({ page }) => {
  for (const path of ["/incidents", `/incidents/${INCIDENT}`, "/evals", "/"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
  expect((await page.request.get(`/api/incidents/${INCIDENT}/events`)).status()).toBe(401);
});

test("login, incident list and live timeline", async ({ page }, testInfo) => {
  const live = `synthesize_${testInfo.project.name}`;
  await page.goto("/login");
  await page.getByLabel("Admin password").fill("wrong-password-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form [role=alert]")).toHaveText("Incorrect password.");

  await page.getByLabel("Admin password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/incidents$/);
  const cookie = (await page.context().cookies()).find((c) => c.name === "incidentpulse_session");
  expect(cookie?.httpOnly).toBe(true);

  const row = page.getByRole("row", { name: new RegExp(INCIDENT) });
  await expect(row).toContainText("kervan");
  await expect(row).toContainText("tls");
  await expect(row).toContainText("$0.012300");
  await row.getByRole("link", { name: INCIDENT }).click();

  await expect(page.getByRole("heading", { name: INCIDENT })).toBeVisible();
  await expect(page.getByText("● Live")).toBeVisible();
  await expect(page.getByText("intake · started")).toBeVisible();
  await expect(page.getByText("Tool call · tls_inspect")).toBeVisible();

  // An event written after the page loaded must arrive over SSE without a reload.
  const url = new URL(process.env.IT_DATABASE_URL ?? "");
  url.searchParams.set("options", `-csearch_path=${SCHEMA}`);
  const pool = new Pool({ connectionString: url.href });
  try {
    await createJournal(pool).append({
      id: INCIDENT,
      project: "kervan",
      events: [{ type: "node_start", at: new Date().toISOString(), data: { node: live } }],
    });
  } finally {
    await pool.end();
  }
  await expect(page.getByText(`${live.replace("_", " ")} · started`)).toBeVisible({
    timeout: 10_000,
  });

  // Layout: no horizontal scrolling at any width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("evaluations page renders for the signed-in admin", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Admin password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/incidents$/);
  await page.goto("/evals");
  await expect(page.getByRole("heading", { name: "Evaluations" })).toBeVisible();
});
