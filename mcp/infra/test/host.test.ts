import { type RunnerClient, RunnerError } from "@incidentpulse/runner-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createInfraServer } from "../src/index.ts";
import { certList, hostPm2, nginxConfig, pm2Logs, pm2Ports } from "../src/tools/host.ts";
import { pm2List } from "../src/tools/pm2.ts";

function fakeClient(reads: Record<string, unknown>): RunnerClient & { reads: string[] } {
  const seen: string[] = [];
  return {
    reads: seen,
    async read(op) {
      seen.push(op);
      const value = reads[op];
      if (value instanceof Error) throw value;
      return value as never;
    },
    dryRun: async () => ({ ok: false, output: "unused" }),
    execute: async () => ({ ok: false, output: "unused" }),
    plan: async () => ({ planDigest: "a".repeat(64), policyDigest: "b".repeat(64), summary: [] }),
    pause: async () => ({ paused: true, running: [], queued: [] }),
    resume: async () => ({ paused: false, running: [], queued: [] }),
    status: async () => ({ paused: false, running: [], queued: [] }),
    health: async () => true,
  };
}

const redact = (text: string) => text.replace(/hunter2/g, "[REDACTED]");

describe("host runner tools", () => {
  test("hostPm2 feeds the unchanged pm2_list parser", async () => {
    const client = fakeClient({
      pm2_jlist: {
        apps: [{ name: "KERVAN", pid: 1, status: "online", restarts: 3, since: 940_000 }],
      },
    });
    const result = await pm2List({
      allowedApps: ["KERVAN"],
      timeoutMs: 1000,
      runner: hostPm2(client),
      now: () => 1_000_000,
    });
    expect(result.apps).toEqual([
      { name: "KERVAN", status: "online", restarts: 3, uptimeSeconds: 60 },
    ]);
  });

  test("pm2_logs refuses an app outside the allowlist without calling the runner", async () => {
    const client = fakeClient({});
    const result = await pm2Logs(client, "OTHER", { lines: 10, allowedApps: ["KERVAN"], redact });
    expect(result.error).toBe("NOT_ALLOWED");
    expect(client.reads).toEqual([]);
  });

  test("pm2_logs redacts, and a runner failure becomes data", async () => {
    const ok = await pm2Logs(
      fakeClient({ pm2_logs: { app: "KERVAN", lines: ["password hunter2", "fine"] } }),
      "KERVAN",
      {
        lines: 10,
        allowedApps: ["KERVAN"],
        redact,
      },
    );
    expect(ok.lines).toEqual(["password [REDACTED]", "fine"]);
    const down = await pm2Logs(fakeClient({ pm2_logs: new RunnerError("ENOENT") }), "KERVAN", {
      lines: 10,
      allowedApps: ["KERVAN"],
      redact,
    });
    expect(down).toEqual({ app: "KERVAN", lines: [], error: "ENOENT" });
  });

  test("pm2_ports only reports allowlisted apps", async () => {
    const client = fakeClient({
      pm2_ports: {
        apps: [
          { app: "KERVAN", pid: 1, ports: [3000] },
          { app: "SNEAKY", ports: [22] },
        ],
      },
    });
    expect((await pm2Ports(client, ["KERVAN"])).apps).toEqual([
      { name: "KERVAN", pid: 1, ports: [3000] },
    ]);
  });

  test("nginx_config says which hosts lack a vhost", async () => {
    const client = fakeClient({
      nginx_config: {
        servers: [
          {
            names: ["a.example", "www.a.example"],
            listens: ["443"],
            ssl: true,
            proxyPass: ["http://127.0.0.1:3000"],
          },
        ],
      },
    });
    const result = await nginxConfig(client, ["a.example", "kervan.uz"]);
    expect(result.hosts).toEqual([
      {
        host: "a.example",
        vhost: true,
        listens: ["443"],
        ssl: true,
        proxyPass: ["http://127.0.0.1:3000"],
      },
      { host: "kervan.uz", vhost: false, listens: [], ssl: false, proxyPass: [] },
    ]);
  });

  test("cert_list says which hosts lack a certificate", async () => {
    const client = fakeClient({
      cert_list: {
        certificates: [
          { name: "a.example", domains: ["a.example"], daysRemaining: 40, valid: true },
        ],
      },
    });
    const result = await certList(client, ["a.example", "kervan.uz"]);
    expect(result.hosts[0]).toMatchObject({
      host: "a.example",
      certificate: true,
      daysRemaining: 40,
    });
    expect(result.hosts[1]).toEqual({ host: "kervan.uz", certificate: false });
  });

  test("the server registers the host tools only with a runner, and they stay read-only", async () => {
    const names = async (hostRunner?: RunnerClient) => {
      const server = createInfraServer({
        allowedHosts: ["kervan.uz"],
        pm2: { apps: ["KERVAN"] },
        ...(hostRunner ? { hostRunner } : {}),
      });
      const client = new Client({ name: "t", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      const tools = (await client.listTools()).tools;
      await client.close();
      return tools;
    };
    expect((await names()).map((t) => t.name)).not.toContain("nginx_config");
    const tools = await names(fakeClient({}));
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["pm2_list", "pm2_logs", "pm2_ports", "nginx_config", "cert_list"]),
    );
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });
});
