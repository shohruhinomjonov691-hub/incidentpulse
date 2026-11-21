import { defineConfig } from "@playwright/test";

// The smoke test needs real Postgres and Redis. Without IT_DATABASE_URL/IT_REDIS_URL it skips.
export const PORT = 3100;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const SCHEMA = "ipweb_smoke";
export const PASSWORD = "smoke-password-0123456789";
export const PREFIX = "ipweb-smoke";

const database = process.env.IT_DATABASE_URL ? new URL(process.env.IT_DATABASE_URL) : undefined;
database?.searchParams.set("options", `-csearch_path=${SCHEMA}`);

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: ORIGIN, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 375, height: 800 } } },
  ],
  webServer: database
    ? {
        command: "pnpm exec next start --hostname 127.0.0.1 --port 3100",
        url: `${ORIGIN}/login`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          DATABASE_URL: database.href,
          REDIS_URL: process.env.IT_REDIS_URL ?? "",
          WEB_ADMIN_PASSWORD: PASSWORD,
          WEB_ORIGIN: ORIGIN,
          WEB_RUNTIME_PREFIX: PREFIX,
        },
      }
    : undefined,
});
