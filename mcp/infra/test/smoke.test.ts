import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test } from "vitest";
import { createInfraServer, DnsLookupResultSchema, HttpProbeResultSchema } from "../src/index.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function connect(options: Parameters<typeof createInfraServer>[0]) {
  const server = createInfraServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(
    () => client.close(),
    () => server.close(),
  );
  return client;
}

describe("mcp-infra over the MCP protocol", () => {
  test("exposes exactly the three read-only tools", async () => {
    const client = await connect({ allowedHosts: ["kervan.uz"] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["dns_lookup", "http_probe", "tls_inspect"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.outputSchema).toBeDefined();
    }
  });

  test("dns_lookup returns schema-valid structured content", async () => {
    const client = await connect({
      allowedHosts: ["kervan.uz"],
      resolver: {
        resolve4: async () => ["203.0.113.10"],
        resolve6: async () => [],
        resolveCname: async () => [],
      },
    });
    const res = await client.callTool({ name: "dns_lookup", arguments: { host: "kervan.uz" } });
    expect(res.isError).toBeFalsy();
    expect(DnsLookupResultSchema.parse(res.structuredContent).a).toEqual(["203.0.113.10"]);
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual(res.structuredContent);
  });

  test("http_probe goes through the fetch seam and is schema-valid", async () => {
    const client = await connect({
      allowedHosts: ["kervan.uz"],
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    const res = await client.callTool({
      name: "http_probe",
      arguments: { url: "https://kervan.uz/" },
    });
    expect(HttpProbeResultSchema.parse(res.structuredContent)).toMatchObject({
      completed: true,
      status: 503,
    });
  });

  test.each([
    ["tls_inspect", { host: "example.com" }],
    ["tls_inspect", { host: "169.254.169.254" }],
    ["dns_lookup", { host: "example.com" }],
    ["tls_inspect", { host: "https://kervan.uz" }],
  ])("%s refuses %j without touching the network", async (name, args) => {
    const client = await connect({ allowedHosts: ["kervan.uz"] });
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError).toBe(true);
  });

  test("http_probe refuses an off-allowlist URL (no request made)", async () => {
    let called = false;
    const client = await connect({
      allowedHosts: ["kervan.uz"],
      fetchImpl: async () => {
        called = true;
        return new Response(null, { status: 200 });
      },
    });
    const res = await client.callTool({
      name: "http_probe",
      arguments: { url: "http://example.com/" },
    });
    expect(HttpProbeResultSchema.parse(res.structuredContent).error).toBe("HOST_NOT_ALLOWED");
    expect(called).toBe(false);
  });
});
