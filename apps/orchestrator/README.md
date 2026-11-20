# @incidentpulse/orchestrator

Incident graph (LangGraph.js, Postgres checkpointer) and BullMQ worker. **Phase 4: verified, human-approved remediation.**

```
intake → triage → investigate ×N → join → synthesize → verify
                                                 ↑         │
                                                 └ missing facts
                                                           ↓
                 propose → await_approval → execute → verify_recovery → close
```

- **triage** (Agents SDK `Agent` with **handoffs**): reads the signal and the quick `http_probe` / `tls_inspect` results, sets the SPEC §3.1 `category`, and **hands off** to a specialist
  (`transfer_to_infra_specialist` …). The handoff carries `category`, a reason and `alsoNeeded` (other specialists to run in parallel). It must hand off and may not conclude; if it does not, every available specialist runs
  and the trace says `handoff_fallback`. Handoff targets are zero-cost receiver agents (no LLM): triage only *decides*, the work happens in the fan-out below.
- **investigate** (LangGraph `Send` fan-out): one parallel run per chosen specialist, each an Agents SDK agent with **its own MCP server process**:
  `infra` → mcp-infra (`tls_inspect`, `http_probe`, `dns_lookup`), `logs` → mcp-infra (`docker_ps`, `docker_logs`), `code` → mcp-codetrail (`codetrail_search`, `codetrail_explain`, `git_recent_commits`).
  A specialist is offered to triage only if the project has something for it (domains, containers, CodeTrail/GitHub). One failing specialist is traced and does not sink the incident.
- **join** merges evidence in a deterministic order (`p*` preflight, `t*` triage, `i*` infra, `l*` logs, `c*` code), then checks budgets.
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

## Investigation and LLM budget

- `INVESTIGATE_MODE=on_change` checks incoming signals immediately and rechecks active Down observations daily at 09:00 Asia/Seoul. `weekly` batches the latest observations and checks active Down signals on Sunday at 09:00 Asia/Seoul.
- A read-only preflight fingerprints the project, category and stable primary evidence before spending tokens. Conclusions expire after seven days. Matching fingerprints reuse the conclusion with at most one Telegram reminder per project per day. An unchanged Down stays idle after expiration. A recovery, category change, or different evidence can open a new investigation.
- Set `TELEGRAM_ALLOWED_USER_IDS` and use `/investigate <project>` in `TELEGRAM_CHAT_ID` to investigate immediately with a fresh model run. The same budget applies.
- `WEEKLY_BUDGET_USD` defaults to $0.50 across all projects and resets Monday at midnight in Seoul. `INCIDENT_BUDGET_USD` also defaults to $0.50. The worker checks the weekly ledger before each provider call and records response usage before admitting another. One already-started call can cross the threshold. Once exhausted, new investigations escalate without the LLM.
- The same model (`gpt-5.4-mini`) receives compact tool results and deduplicated evidence, with output ceilings of 400, 480 and 900 tokens for triage, specialists and synthesis respectively.

## Debate and approval

- Set `DEBATE_MODE=auto` to verify a synthesis below 0.9 confidence or supported by fewer than two tool sources. `always` and `off` override the gate. If the Judge returns confidence below 0.7, the graph sends missing facts to the configured specialists. The graph permits two debate rounds and traces unavailability.
- Enable actions with `ACTIONS_ENABLED=true` and an explicit project scope, approval secret, dedicated Unix account and Telegram user allowlist. A proposal passes registry validation and a dry run before LangGraph pauses for Telegram approval.
- Approvals expire after 60 minutes. Expired incidents wait for human review with reminders at most every two hours. An approved action has a fresh 15-minute token. Recovery reruns the configured health probe. Two failed-recovery retries may create new proposals, each requiring its own approval.
- `/stop` prevents nodes and new execution steps from starting. A subprocess already executing may finish. `/resume` continues saved checkpoints. `/status` shows the stop flag, paused graph count and weekly spend.

## Run

```bash
pnpm --filter @incidentpulse/orchestrator start               # reads ../../.env
pnpm --filter @incidentpulse/orchestrator show <incidentId>   # evidence, hypotheses, trace and the Telegram text
# integration tests need real Postgres + Redis (docker compose up -d):
IT_DATABASE_URL=postgres://incidentpulse:incidentpulse_dev@127.0.0.1:5432/incidentpulse \
IT_REDIS_URL=redis://:incidentpulse_dev@127.0.0.1:6379 pnpm --filter @incidentpulse/orchestrator test
# real agents against the local sandbox (costs a few cents; see ../../sandbox/README.md):
pnpm sandbox:eval
```

Optional integrations (unset = that specialist's tools answer `not_configured`, or the specialist is not offered):
`PROJECT_CONTAINERS_JSON`, `CODETRAIL_BASE_URL`, `CODETRAIL_API_KEY`, `CODETRAIL_PROJECT_IDS_JSON`, `GITHUB_READONLY_TOKEN` (fine-grained, read-only), `PROJECT_REPOS_JSON`. See `.env.example`.
