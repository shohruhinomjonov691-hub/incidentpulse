import { describe, expect, test } from "vitest";
import {
  ConfigError,
  loadIntakeConfig,
  loadOrchestratorConfig,
  resolvePricing,
  resolveProjectDomains,
} from "../src/index.ts";

const base = {
  OPENAI_API_KEY: "sk-test-not-a-real-key-000000",
  TELEGRAM_BOT_TOKEN: "123456:not-a-real-token-not-a-real-token",
  TELEGRAM_CHAT_ID: "42",
  WEBHOOK_HMAC_SECRET: "a".repeat(64),
};

describe("loadOrchestratorConfig", () => {
  test("applies defaults: cheap model, $0.50 budget, kervan domain", () => {
    const c = loadOrchestratorConfig(base);
    expect(c.model).toBe("gpt-5.4-mini");
    expect(c.budgetUsd).toBe(0.5);
    expect(c.weeklyBudgetUsd).toBe(0.5);
    expect(c.investigateMode).toBe("on_change");
    expect(c.telegramAllowedUserIds.size).toBe(0);
    expect(c.pricing).toEqual({ inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 });
    expect(c.projectDomains.kervan).toEqual(["kervan.uz"]);
  });

  test("weekly budget is configurable and must be positive", () => {
    expect(loadOrchestratorConfig({ ...base, WEEKLY_BUDGET_USD: "1.5" }).weeklyBudgetUsd).toBe(1.5);
    expect(() => loadOrchestratorConfig({ ...base, WEEKLY_BUDGET_USD: "0" })).toThrow(
      /WEEKLY_BUDGET_USD/,
    );
  });

  test("weekly mode and explicit Telegram user allowlist are configurable", () => {
    const c = loadOrchestratorConfig({
      ...base,
      INVESTIGATE_MODE: "weekly",
      TELEGRAM_ALLOWED_USER_IDS: "42, 100,42",
    });
    expect(c.investigateMode).toBe("weekly");
    expect([...c.telegramAllowedUserIds]).toEqual([42, 100]);
    expect(() => loadOrchestratorConfig({ ...base, INVESTIGATE_MODE: "daily" })).toThrow(
      /INVESTIGATE_MODE/,
    );
    expect(() => loadOrchestratorConfig({ ...base, TELEGRAM_ALLOWED_USER_IDS: "alice" })).toThrow(
      /TELEGRAM_ALLOWED_USER_IDS/,
    );
  });

  test("model comes from env", () => {
    expect(
      loadOrchestratorConfig({ ...base, OPENAI_MODEL: "gpt-5.4-nano" }).pricing.inputPerM,
    ).toBe(0.2);
  });

  test("unknown model without prices fails closed", () => {
    expect(() => loadOrchestratorConfig({ ...base, OPENAI_MODEL: "mystery-1" })).toThrow(
      ConfigError,
    );
  });

  test("unknown model with explicit prices is accepted", () => {
    const c = loadOrchestratorConfig({
      ...base,
      OPENAI_MODEL: "mystery-1",
      MODEL_PRICE_INPUT_PER_M: "1",
      MODEL_PRICE_OUTPUT_PER_M: "2",
    });
    expect(c.pricing).toEqual({ inputPerM: 1, cachedInputPerM: 1, outputPerM: 2 });
  });

  test("error names the missing variable but never echoes a value", () => {
    const secret = "tiny-but-secret";
    try {
      loadOrchestratorConfig({ ...base, WEBHOOK_HMAC_SECRET: secret, TELEGRAM_CHAT_ID: secret });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain("TELEGRAM_CHAT_ID");
      expect((e as Error).message).not.toContain(secret);
    }
  });

  test("missing key is reported by name", () => {
    const { OPENAI_API_KEY: _omit, ...rest } = base;
    expect(() => loadOrchestratorConfig(rest)).toThrow(/OPENAI_API_KEY/);
  });
});

describe("loadIntakeConfig", () => {
  test("requires a 32+ char HMAC secret", () => {
    expect(() => loadIntakeConfig({ WEBHOOK_HMAC_SECRET: "short" })).toThrow(/WEBHOOK_HMAC_SECRET/);
    const c = loadIntakeConfig({ WEBHOOK_HMAC_SECRET: "b".repeat(32) });
    expect(c.port).toBe(8787);
    expect(c.host).toBe("127.0.0.1");
  });
});

describe("resolveProjectDomains / resolvePricing", () => {
  test("override merges over defaults", () => {
    const d = resolveProjectDomains('{"gotrip":["gotrip.uz"]}');
    expect(d.gotrip).toEqual(["gotrip.uz"]);
    expect(d.kervan).toEqual(["kervan.uz"]);
  });
  test("bad override JSON is rejected", () => {
    expect(() => resolveProjectDomains("{nope")).toThrow(ConfigError);
    expect(() => resolveProjectDomains('{"unknown-project":["x"]}')).toThrow(ConfigError);
  });
  test("resolvePricing uses explicit overrides over known prices", () => {
    expect(resolvePricing("gpt-5.4-mini", { input: 9 }).inputPerM).toBe(9);
  });
});

describe("production settings", () => {
  const domains = {
    PROJECT_DOMAINS_JSON: JSON.stringify({ kervan: ["kervan.uz"], gotrip: ["gotrips.example"] }),
  };

  test("the health poller is off by default and polls https://<domain>/ when on", () => {
    const off = loadOrchestratorConfig({ ...base, ...domains });
    expect(off.healthPoll).toEqual({ enabled: false, targets: {} });
    const on = loadOrchestratorConfig({ ...base, ...domains, HEALTH_POLL_ENABLED: "true" });
    expect(on.healthPoll.targets).toEqual({
      kervan: ["https://kervan.uz/"],
      gotrip: ["https://gotrips.example/"],
    });
  });

  test("explicit poll URLs must stay inside the project's domains", () => {
    const urls = (value: unknown) =>
      loadOrchestratorConfig({
        ...base,
        ...domains,
        HEALTH_POLL_ENABLED: "true",
        HEALTH_POLL_URLS_JSON: JSON.stringify(value),
      });
    expect(
      urls({ kervan: ["https://kervan.uz/health", "https://www.kervan.uz/"] }).healthPoll.targets
        .kervan,
    ).toHaveLength(2);
    for (const bad of [
      { kervan: ["https://evil.example/"] },
      { kervan: ["https://kervan.uz.evil.example/"] },
      { kervan: ["http://169.254.169.254/"] },
      { kervan: ["https://user:pw@kervan.uz/"] },
      { kervan: ["ftp://kervan.uz/"] },
      { kervan: ["not a url"] },
      { codetrail: ["https://kervan.uz/"] },
    ]) {
      expect(() => urls(bad)).toThrow(ConfigError);
    }
  });

  test("host runner socket, docker host and pm2 apps are validated", () => {
    const c = loadOrchestratorConfig({
      ...base,
      HOST_RUNNER_SOCKET: "/run/incidentpulse/actions.sock",
      DOCKER_HOST: "tcp://docker-proxy:2375",
      PROJECT_PM2_JSON: JSON.stringify({ kervan: ["KERVAN", "KERVAN-REACT"] }),
    });
    expect(c.hostRunnerSocket).toBe("/run/incidentpulse/actions.sock");
    expect(c.dockerHost).toBe("tcp://docker-proxy:2375");
    expect(c.projectPm2.kervan).toEqual(["KERVAN", "KERVAN-REACT"]);
    expect(() => loadOrchestratorConfig({ ...base, HOST_RUNNER_SOCKET: "relative.sock" })).toThrow(
      /HOST_RUNNER_SOCKET/,
    );
    expect(() => loadOrchestratorConfig({ ...base, DOCKER_HOST: "http://x" })).toThrow(
      /DOCKER_HOST/,
    );
    expect(() =>
      loadOrchestratorConfig({ ...base, PROJECT_PM2_JSON: '{"kervan":["a b"]}' }),
    ).toThrow(/PROJECT_PM2_JSON/);
  });

  test("action scopes accept www", () => {
    const c = loadOrchestratorConfig({
      ...base,
      ...domains,
      PROJECT_ACTION_SCOPES_JSON: JSON.stringify({
        kervan: { nginx: true, webroot: "/var/www/acme", www: true },
      }),
    });
    expect(c.actionScopes.kervan).toMatchObject({ www: true, domains: ["kervan.uz"] });
  });
});
