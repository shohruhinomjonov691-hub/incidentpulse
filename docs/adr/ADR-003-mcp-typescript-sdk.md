# ADR-003: Model Context Protocol (TypeScript SDK) for all tools

- **Status:** Accepted
- **Date:** 2026-11-21 (written at the end of Phase 6, from what was built)
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-003

## Context

The model must be able to look at production, but never to change it, and the permission boundary must not depend on the model behaving.

## Decision

Three stdio MCP servers: `mcp/infra` (read-only: `tls_inspect`, `http_probe`, `dns_lookup`, `docker_ps`, `docker_logs`, `pm2_list`), `mcp/codetrail` (read-only: code search, recent commits) and `mcp/actions` (state-changing). The first two are the only tools an LLM ever sees. `mcp/actions` is called by the orchestrator, never by a model, and only with a single-use approval token. Each child process gets only its own allowlist through its environment (hosts, container prefixes, pm2 apps).

Pinned version(s) (see [docs/VERSIONS.md](../VERSIONS.md)): `@modelcontextprotocol/sdk` 1.32.2

## Why this and not another

The allowlist lives at the process boundary: an off-list host, container or pm2 app is refused by the server with no request made, whatever the model asks. The same servers work from Claude Desktop or Cursor.

## Alternatives considered

- **In-process function tools.** Fewer moving parts, but the permission boundary would be a convention inside one process.
- **OpenAPI tools over HTTP.** More infrastructure and an auth story for each tool.

## Consequences

One child process per specialist run adds start-up time per run and needs stderr-only logging (stdout belongs to the protocol). Tool results are untrusted data, so each passes the injection guardrail before the agent sees it.
