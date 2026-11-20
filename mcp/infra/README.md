# @incidentpulse/mcp-infra

Read-only MCP server (stdio, `@modelcontextprotocol/sdk`). Phase 1 tools: `tls_inspect`, `http_probe`, `dns_lookup` (SPEC §5.1). More tools arrive in Phase 2.

- Every result is parsed with a zod schema (`src/schemas.ts`) and returned as `structuredContent` with a declared `outputSchema`.
- **Allowlist** (`INFRA_ALLOWED_HOSTS`, comma-separated; subdomains included): the permission boundary of this process. Off-list hosts, IP literals and redirects to other hosts are refused without a request (SSRF guard). The server refuses to start with an empty list.
- Fixed network timeouts (default 8 s, `INFRA_TIMEOUT_MS`); failures such as `ECONNREFUSED`, `ETIMEDOUT`, `ERR_TLS_CERT_ALTNAME_INVALID` are returned as data.
- `tls_inspect` handshakes with `rejectUnauthorized: false` on purpose (to read a *broken* certificate) and never sends application data. `http_probe` never reads the response body.

```bash
INFRA_ALLOWED_HOSTS=kervan.uz pnpm --filter @incidentpulse/mcp-infra start   # speaks MCP on stdio
```
