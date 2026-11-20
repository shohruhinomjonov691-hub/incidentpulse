# @incidentpulse/orchestrator

Incident graph (LangGraph.js, Postgres checkpointer) and BullMQ worker. **Phase 2: multi-agent.**

```
intake ─► triage ──Send──► investigate ×N (parallel) ─► join ─► synthesize ─► report
   │        │                 infra | logs | code                  │
   │        └─ budget spent ──────────────────────────┐            └─ guardrail rejected twice ─┐
   └─ today's budget already spent ────────────────► escalate  ◄───────────────────────────────┘
```

- **triage** (Agents SDK `Agent` with **handoffs**): reads the signal, does up to two quick `http_probe` / `tls_inspect` calls, sets the SPEC §3.1 `category`, and **hands off** to a specialist
  (`transfer_to_infra_specialist` …). The handoff carries `category`, a reason and `alsoNeeded` (other specialists to run in parallel). It must hand off and may not conclude; if it does not, every available specialist runs
  and the trace says `handoff_fallback`. Handoff targets are zero-cost receiver agents (no LLM): triage only *decides*, the work happens in the fan-out below.
- **investigate** (LangGraph `Send` fan-out): one parallel run per chosen specialist, each an Agents SDK agent with **its own MCP server process**:
  `infra` → mcp-infra (`tls_inspect`, `http_probe`, `dns_lookup`), `logs` → mcp-infra (`docker_ps`, `docker_logs`), `code` → mcp-codetrail (`codetrail_search`, `codetrail_explain`, `git_recent_commits`).
  A specialist is offered to triage only if the project has something for it (domains, containers, CodeTrail/GitHub). One failing specialist is traced and does not sink the incident.
- **join** merges evidence in a deterministic order (`t*` triage, `i*` infra, `l*` logs, `c*` code), then checks budgets.
- **synthesize**: structured output + OUTPUT guardrail; **report**: Uzbek, read-only (SPEC §6 layout, no buttons); **escalate**: short "needs a human" notice.
- **Trace**: `state.trace` is an append-only audit trail (handoff, decision, specialist runs, guardrail events). `pnpm --filter @incidentpulse/orchestrator show <incidentId>` prints it.

## Guardrails (SPEC §4)

| | Where | What |
|---|---|---|
| **Input** | every MCP tool result (`GuardedMcpServer`), the monitor summary, an Agents SDK `inputGuardrail` | log / HTML / code / commit text is wrapped in `<untrusted source=…>` (a closing tag inside the data is defused), injection-looking lines are **flagged** and, in `strip` mode (default), **removed**. Evidence is *always* built from the scrubbed text. `INJECTION_MODE=mark` keeps the lines (flagged) so the model's own resistance can be tested |
| **Output** | Agents SDK `outputGuardrail` on the synthesizer | rejects a synthesis that is not valid against the zod schema, cites evidence ids that do not exist, has confidence outside 0..1, or makes a confident claim without evidence. One retry with the reasons; a second rejection **escalates** |

Pattern matching is a heuristic and will miss things. The real limits are structural: read-only tools, host/port and container allowlists in the MCP processes, MCP children that never receive the LLM or Telegram keys,
and the rule that evidence (and therefore the report) is never LLM-authored.
**Unsafe attempts** = tool calls the MCP servers refused (off-allowlist host/container, denied project). SPEC §9 wants this to be 0.

## Budgets (SPEC §8)

`costUsd` is computed from token usage × price (`packages/config`).
- Per incident: `INCIDENT_BUDGET_USD` (default $0.50). Per day: `DAILY_BUDGET_USD` (default $3) across all incidents in Redis (`incidentpulse:budget:daily:<date>`, integer micro-USD via atomic `INCRBY`, 48 h TTL).
  A "day" is the calendar day in `BUDGET_TIMEZONE` (default **Asia/Seoul**).
- Checked before each LLM step. If today's budget is already spent, the incident goes straight to `escalate` with **no LLM call**; if a budget is spent after triage or the specialists, `synthesize` is skipped and the incident escalates with the evidence so far.
  If `synthesize` itself crosses the limit, the report is still sent (already paid for) with a warning. Small amounts in messages use 4 decimals (`$0.0034`), larger ones 2 (`$3.00`).
- Parallel specialists each add to the counter when they finish; a step can overshoot (bounded by `maxTurns`).

## Run

```bash
pnpm --filter @incidentpulse/orchestrator start               # reads ../../.env
pnpm --filter @incidentpulse/orchestrator show <incidentId>   # evidence, hypotheses, trace and the Telegram text
# integration tests need real Postgres + Redis (docker compose up -d):
IT_DATABASE_URL=postgres://incidentpulse:incidentpulse_dev@127.0.0.1:5432/incidentpulse \
IT_REDIS_URL=redis://:incidentpulse_dev@127.0.0.1:6379 pnpm --filter @incidentpulse/orchestrator test
# real agents against the local sandbox (costs a few cents; see ../../sandbox/README.md):
pnpm --filter @incidentpulse/orchestrator sandbox:eval
```

Optional integrations (unset = that specialist's tools answer `not_configured`, or the specialist is not offered):
`PROJECT_CONTAINERS_JSON`, `CODETRAIL_BASE_URL`, `CODETRAIL_API_KEY`, `CODETRAIL_PROJECT_IDS_JSON`, `GITHUB_READONLY_TOKEN` (fine-grained, read-only), `PROJECT_REPOS_JSON`. See `.env.example`.
