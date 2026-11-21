import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createInfraServer } from "../src/index.ts";
import { containerPm2, type Pm2Runner, pm2List } from "../src/tools/pm2.ts";

const row = (name: string, status: string, restart: number, since = 1_000_000) => ({
  name,
  pm2_env: { status, restart_time: restart, pm_uptime: since },
});

function runner(stdout: string): Pm2Runner {
  return { jlist: async () => stdout };
}

describe("pm2List", () => {
  test("returns only allowlisted apps; uptime only while online", async () => {
    const out = JSON.stringify([
      row("toy-api", "stopped", 2),
      row("other-app", "online", 0),
      row("worker", "online", 1, 940_000),
    ]);
    const r = await pm2List({
      allowedApps: ["toy-api", "worker"],
      timeoutMs: 1000,
      runner: runner(out),
      now: () => 1_000_000,
    });
    expect(r).toEqual({
      apps: [
        { name: "toy-api", status: "stopped", restarts: 2 },
        { name: "worker", status: "online", restarts: 1, uptimeSeconds: 60 },
      ],
    });
  });

  test("tolerates a banner before the JSON and reports bad output as data", async () => {
    const banner = `[PM2] Spawning PM2 daemon\n${JSON.stringify([row("toy-api", "online", 0)])}`;
    const ok = await pm2List({ allowedApps: ["toy-api"], timeoutMs: 1000, runner: runner(banner) });
    expect(ok.apps[0]?.name).toBe("toy-api");
    const bad = await pm2List({
      allowedApps: ["toy-api"],
      timeoutMs: 1000,
      runner: runner("nope"),
    });
    expect(bad).toEqual({ apps: [], error: "BAD_OUTPUT" });
    const broken = await pm2List({
      allowedApps: ["toy-api"],
      timeoutMs: 1000,
      runner: {
        jlist: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" })),
      },
    });
    expect(broken).toEqual({ apps: [], error: "ENOENT" });
  });

  test("the container runner uses a fixed argv (no shell)", async () => {
    const calls: string[][] = [];
    const r = containerPm2("ipsb-p-app", async (args) => {
      calls.push([...args]);
      return { stdout: "[]", stderr: "" };
    });
    await r.jlist({ timeoutMs: 1000 });
    expect(calls).toEqual([["exec", "ipsb-p-app", "pm2", "jlist"]]);
  });
});

describe("pm2_list over MCP", () => {
  async function connect(options: Parameters<typeof createInfraServer>[0]) {
    const server = createInfraServer(options);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  }

  test("is registered only with a pm2 allowlist, and is read-only", async () => {
    const without = await connect({ allowedHosts: ["a.localhost"] });
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain("pm2_list");
    const withPm2 = await connect({
      allowedHosts: ["a.localhost"],
      pm2: { apps: ["toy-api"] },
      pm2Runner: runner(JSON.stringify([row("toy-api", "stopped", 0)])),
    });
    const tool = (await withPm2.listTools()).tools.find((t) => t.name === "pm2_list");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    const result = await withPm2.callTool({ name: "pm2_list", arguments: {} });
    expect(result.structuredContent).toEqual({
      apps: [{ name: "toy-api", status: "stopped", restarts: 0 }],
    });
  });

  test("a pm2 container outside the container allowlist is refused at startup", () => {
    expect(() =>
      createInfraServer({
        allowedHosts: ["a.localhost"],
        allowedContainers: ["ipsb-a-"],
        pm2: { apps: ["toy-api"], container: "incidentpulse-postgres-1" },
      }),
    ).toThrow(/allowlist/);
  });
});
