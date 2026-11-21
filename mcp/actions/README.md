# @incidentpulse/mcp-actions

The orchestrator uses the MCP `execute_runbook` tool after a signed Telegram decision. The MCP server resolves the YAML registry again, checks the Redis stop flag and atomically consumes a Postgres-backed token. The token is bound to the approval, incident, project, runbook, exact parameters and a 15-minute expiry. Postgres records approval decisions and execution claims/results in `incidentpulse_action_audit`.

The system runner uses `execFile` and explicit executable paths through `sudo -n -H -u <ACTION_EXEC_USER>`. Configure a dedicated non-root account without LLM or Telegram credentials. Restrict sudoers and any required service permissions to the named commands and exact allowlisted targets. Leave `ACTIONS_ENABLED=false` until the account, registry settings and Telegram user allowlist are configured.

A consumed token whose execution result was lost is never executed again. The graph uses a fresh health check to assess the result. Subsequent attempts require a new proposal and approval. See [runbook configuration](../../runbooks/README.md).

In production (`HOST_RUNNER_SOCKET` set) the orchestrator does not run commands. After the Postgres claim succeeds, `execute_runbook` hands the runbook to the host actions runner (`createRemoteExecutor`), which re-verifies the HMAC token (with its expiry), keeps its own single-use ledger and executes from its own policy. See [docs/DEPLOY.md](../../docs/DEPLOY.md).
