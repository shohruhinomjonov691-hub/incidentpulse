import { type RunnerClient, RunnerError } from "@incidentpulse/runner-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import {
  type ApprovalStore,
  createActionsServer,
  createRemoteExecutor,
  loadRunbookRegistry,
} from "../src/index.ts";

const registry = loadRunbookRegistry(
  { kervan: { domains: ["kervan.uz"], pm2: ["KERVAN"], nginx: true, webroot: "/var/www/acme" } },
  undefined,
  { remote: true },
);

function setup(
  options: { claim?: boolean; client?: Partial<RunnerClient>; stopped?: boolean } = {},
) {
  const sent: unknown[] = [];
  const client: RunnerClient = {
    read: async () => ({}) as never,
    dryRun: async (body) => {
      sent.push(body);
      return { ok: true, output: "dry ok" };
    },
    execute: async (body) => {
      sent.push(body);
      return { ok: true, output: "done password=hunter2hunter2" };
    },
    health: async () => true,
    ...options.client,
  };
  let completed: unknown;
  const approvals = {
    claim: async () => options.claim ?? true,
    complete: async (_id: string, result: unknown) => {
      completed = result;
    },
  } as unknown as ApprovalStore;
  const server = createActionsServer({
    registry,
    approvals,
    remote: createRemoteExecutor(client),
    redact: (t) => t.replace(/password=\S+/g, "password=[REDACTED]"),
    isStopped: async () => options.stopped ?? false,
  });
  const run = async (args: Record<string, unknown>) => {
    const mcp = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await mcp.connect(b);
    const result = await mcp.callTool({ name: "execute_runbook", arguments: args });
    await mcp.close();
    return result.structuredContent as { ok: boolean; output: string };
  };
  return { run, sent, completed: () => completed };
}

const request = {
  approvalId: "AAAAAAAAAAAAAAAA",
  incidentId: "inc-1",
  project: "kervan",
  runbookId: "nginx_site_proxy",
  params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
  approvalToken: "t".repeat(43),
  tokenExpiresAt: 1_800_000_000_000,
};

describe("execute_runbook through the host runner", () => {
  test("claims the token, forwards the claims, and redacts the runner's output", async () => {
    const { run, sent, completed } = setup();
    const result = await run(request);
    expect(result).toEqual({ ok: true, output: "done password=[REDACTED]" });
    expect(sent[0]).toMatchObject({
      project: "kervan",
      runbookId: "nginx_site_proxy",
      approvalId: "AAAAAAAAAAAAAAAA",
      tokenExpiresAt: 1_800_000_000_000,
    });
    expect(completed()).toEqual(result);
  });

  test("an unclaimed token (used, expired or unknown) never reaches the runner", async () => {
    const { run, sent } = setup({ claim: false });
    expect((await run(request)).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a missing expiry, a paused system and an out-of-scope domain never reach the runner", async () => {
    const { run, sent } = setup();
    expect((await run({ ...request, tokenExpiresAt: undefined })).output).toContain("expiry");
    expect((await setup({ stopped: true }).run(request)).output).toBe("Actions are paused");
    expect(
      (await run({ ...request, params: { domain: "evil.example", upstream: "127.0.0.1:3000" } }))
        .ok,
    ).toBe(false);
    expect(sent).toEqual([]);
  });

  test("an unreachable runner is a failed execution, not a crash", async () => {
    const { run, completed } = setup({
      client: { execute: async () => Promise.reject(new RunnerError("ENOENT")) },
    });
    const result = await run(request);
    expect(result).toEqual({ ok: false, output: "Host runner unavailable: ENOENT" });
    expect(completed()).toEqual(result);
  });
});

describe("remote dry-run", () => {
  test("sends only project, runbook and params (no token)", async () => {
    const sent: unknown[] = [];
    const remote = createRemoteExecutor({
      read: async () => ({}) as never,
      dryRun: async (body) => {
        sent.push(body);
        return { ok: true, output: "ok" };
      },
      execute: async () => ({ ok: false, output: "" }),
      health: async () => true,
    });
    const book = registry.resolve(
      "kervan",
      {
        runbookId: "nginx_site_proxy",
        params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
      },
      { upstreams: ["127.0.0.1:3000"] },
    );
    expect(await remote.dryRun("kervan", book)).toEqual({ ok: true, output: "ok" });
    expect(sent).toEqual([
      {
        project: "kervan",
        runbookId: "nginx_site_proxy",
        params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" },
      },
    ]);
  });
});
