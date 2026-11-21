import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { insecureBaseUrl, langfuseEnabled, noopTelemetry, startTelemetry } from "../src/index.ts";

describe("Langfuse never sends over cleartext HTTP", () => {
  const keys = { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" };
  test("only https or loopback base URLs are accepted", () => {
    expect(insecureBaseUrl({})).toBe(false);
    expect(insecureBaseUrl({ LANGFUSE_BASE_URL: "https://cloud.langfuse.com" })).toBe(false);
    expect(insecureBaseUrl({ LANGFUSE_BASE_URL: "http://127.0.0.1:3000" })).toBe(false);
    expect(insecureBaseUrl({ LANGFUSE_HOST: "http://langfuse.example.com" })).toBe(true);
    expect(insecureBaseUrl({ LANGFUSE_BASE_URL: "not a url" })).toBe(true);
  });

  test("with keys but a plain-HTTP remote host tracing stays off", async () => {
    const telemetry = await startTelemetry({
      ...keys,
      LANGFUSE_BASE_URL: "http://langfuse.example.com",
    });
    expect(telemetry).toBe(noopTelemetry);
  });
});

describe("Langfuse is off unless both keys are set", () => {
  test("langfuseEnabled needs both non-blank keys", () => {
    expect(langfuseEnabled({})).toBe(false);
    expect(langfuseEnabled({ LANGFUSE_PUBLIC_KEY: "pk" })).toBe(false);
    expect(langfuseEnabled({ LANGFUSE_SECRET_KEY: "sk" })).toBe(false);
    expect(langfuseEnabled({ LANGFUSE_PUBLIC_KEY: " ", LANGFUSE_SECRET_KEY: "sk" })).toBe(false);
    expect(langfuseEnabled({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" })).toBe(true);
  });

  test("without keys: the no-op object, work runs untouched, no network", async () => {
    const originalFetch = globalThis.fetch;
    let touched = false;
    globalThis.fetch = (async () => {
      touched = true;
      throw new Error("no network expected");
    }) as typeof fetch;
    try {
      const telemetry = await startTelemetry({ LANGFUSE_BASE_URL: "http://127.0.0.1:9" });
      expect(telemetry).toBe(noopTelemetry);
      expect(telemetry.enabled).toBe(false);
      const value = await telemetry.observe({ incidentId: "i1", name: "triage" }, async () => 42);
      expect(value).toBe(42);
      await expect(
        telemetry.observe({ incidentId: "i1", name: "x" }, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      telemetry.generation({
        name: "g",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1 },
        startTime: new Date(),
        endTime: new Date(),
      });
      await telemetry.shutdown();
      expect(touched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

interface Received {
  path: string;
  authorization: string | undefined;
  body: string;
}

function receiver() {
  const received: Received[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise<{ received: Received[]; url: string; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          received,
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    },
  );
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

describe("with keys: OTLP spans reach the configured Langfuse host, redacted", () => {
  test("a node span, a generation and a tool call arrive with Basic auth and no secrets", async () => {
    const lf = await receiver();
    closers.push(lf.close);
    const telemetry = await startTelemetry(
      { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test", LANGFUSE_BASE_URL: lf.url },
      {
        redact: (text) => text.replaceAll("SUPER-SECRET-TOKEN", "[REDACTED]"),
        exportMode: "immediate",
        compression: "none",
      },
    );
    closers.push(() => telemetry.shutdown());
    expect(telemetry.enabled).toBe(true);

    await telemetry.observe(
      {
        incidentId: "inc-1",
        project: "kervan",
        name: "node:triage",
        input: { note: "SUPER-SECRET-TOKEN" },
      },
      async () => {
        telemetry.generation({
          name: "llm",
          model: "gpt-5.4-mini",
          input: "prompt with SUPER-SECRET-TOKEN",
          output: "ok",
          usage: { inputTokens: 100, outputTokens: 20 },
          costUsd: 0.0001,
          startTime: new Date(Date.now() - 50),
          endTime: new Date(),
        });
        telemetry.tool({
          name: "http_probe",
          source: "quick_probes",
          output: "status=200",
          startTime: new Date(Date.now() - 10),
          endTime: new Date(),
        });
        return { category: "tls" };
      },
    );
    await telemetry.shutdown();

    expect(lf.received.length).toBeGreaterThan(0);
    for (const r of lf.received) {
      expect(r.path).toBe("/api/public/otel/v1/traces");
      expect(r.authorization).toBe(`Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);
    }
    const payload = lf.received.map((r) => r.body).join("\n");
    expect(payload).toContain("node:triage");
    expect(payload).toContain("http_probe");
    expect(payload).toContain("gpt-5.4-mini");
    expect(payload).toContain("project:kervan");
    expect(payload).not.toContain("SUPER-SECRET-TOKEN");
    expect(payload).toContain("[REDACTED]");
  });

  test("an error inside the observed work is rethrown unchanged", async () => {
    const lf = await receiver();
    closers.push(lf.close);
    const telemetry = await startTelemetry(
      { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: lf.url },
      { exportMode: "immediate", compression: "none" },
    );
    closers.push(() => telemetry.shutdown());
    await expect(
      telemetry.observe({ incidentId: "inc-2", name: "node:x" }, async () => {
        throw new Error("node failed");
      }),
    ).rejects.toThrow("node failed");
    expect(await telemetry.observe({ incidentId: "inc-2", name: "n" }, async () => 7)).toBe(7);
  });

  test("an unreachable Langfuse never breaks the work", async () => {
    const telemetry = await startTelemetry(
      {
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
        LANGFUSE_BASE_URL: "http://127.0.0.1:9",
      },
      { exportMode: "immediate", compression: "none" },
    );
    closers.push(() => telemetry.shutdown());
    expect(await telemetry.observe({ incidentId: "inc-3", name: "n" }, async () => "fine")).toBe(
      "fine",
    );
  });
});
