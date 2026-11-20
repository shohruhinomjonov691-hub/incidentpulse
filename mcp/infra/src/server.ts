import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isAllowedHost, isPlainHostname, normalizeHost } from "./allowlist.ts";
import { DnsLookupResultSchema, HttpProbeResultSchema, TlsInspectResultSchema } from "./schemas.ts";
import { type DnsResolver, dnsLookup } from "./tools/dns.ts";
import { httpProbe } from "./tools/http.ts";
import { tlsInspect } from "./tools/tls.ts";

export interface InfraServerOptions {
  /** Hosts (and their subdomains) the tools may touch. Empty list = nothing is reachable. */
  allowedHosts: readonly string[];
  /** Per-call network timeout. Fixed by the operator, not the model. */
  timeoutMs?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  resolver?: DnsResolver;
  tlsPort?: number;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

function ok<T extends Record<string, unknown>>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function denied(what: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `${what} is not in this server's allowlist; no request was made.`,
      },
    ],
  };
}

/** mcp-infra (SPEC §5.1): read-only network diagnostics. Phase 1 scope: tls, http, dns. */
export function createInfraServer(options: InfraServerOptions): McpServer {
  const timeoutMs = options.timeoutMs ?? 8000;
  const allowed = options.allowedHosts.map(normalizeHost);
  const server = new McpServer({ name: "mcp-infra", version: "0.0.0" });

  server.registerTool(
    "tls_inspect",
    {
      title: "Inspect TLS certificate",
      description:
        "Read-only TLS handshake to host:443. Returns issuer, SANs, notBefore/notAfter, days remaining, whether the chain validates and whether the hostname matches.",
      inputSchema: { host: z.string().min(1).max(253).describe("Bare hostname, e.g. example.com") },
      outputSchema: TlsInspectResultSchema,
      annotations: { title: "tls_inspect", ...READ_ONLY },
    },
    async ({ host }) => {
      if (!isPlainHostname(host) || !isAllowedHost(host, allowed)) return denied(`host "${host}"`);
      return ok(
        await tlsInspect(normalizeHost(host), {
          timeoutMs,
          ...(options.tlsPort !== undefined ? { port: options.tlsPort } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "http_probe",
    {
      title: "HTTP probe",
      description:
        "Read-only GET (body is never read). Returns status, latency, redirect chain (followed only within the allowlist) and a TLS error code if the handshake failed.",
      inputSchema: {
        url: z.string().min(1).max(2048).describe("http(s) URL, e.g. https://example.com/"),
      },
      outputSchema: HttpProbeResultSchema,
      annotations: { title: "http_probe", ...READ_ONLY },
    },
    async ({ url }) =>
      ok(
        await httpProbe(url, {
          timeoutMs,
          allowedHosts: allowed,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        }),
      ),
  );

  server.registerTool(
    "dns_lookup",
    {
      title: "DNS lookup",
      description: "Read-only A, AAAA and CNAME lookup for a hostname.",
      inputSchema: { host: z.string().min(1).max(253).describe("Bare hostname") },
      outputSchema: DnsLookupResultSchema,
      annotations: { title: "dns_lookup", ...READ_ONLY },
    },
    async ({ host }) => {
      if (!isPlainHostname(host) || !isAllowedHost(host, allowed)) return denied(`host "${host}"`);
      return ok(
        await dnsLookup(normalizeHost(host), {
          timeoutMs,
          ...(options.resolver ? { resolver: options.resolver } : {}),
        }),
      );
    },
  );

  return server;
}
