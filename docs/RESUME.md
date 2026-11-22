# Resume bullets

Three bullets, with the numbers they rest on. Copy the bullets; keep the "Where the numbers come from" notes handy for interviews.

## Bullets

- Built **IncidentPulse**, a polyglot multi-agent incident responder (LangGraph.js, OpenAI Agents SDK, MCP, Microsoft Agent Framework, CrewAI, Next.js, Postgres/Redis): triage → parallel specialist handoffs → debate-based verification → **human-approved**, token-gated runbook execution → verified recovery → auto-written postmortem, with read-only tool allowlists, a prompt-injection guard and a kill-switch.
- Deployed it to a production VPS (6 apps, 8 services, about **400 MB RAM**); its first real incident, a **TLS misconfiguration on a live site**, was detected by an LLM-free poller, diagnosed at 0.99 confidence for **$0.0076**, fixed after one human approval via a sudoers-restricted runner (20 exact commands, audited in the sudo journal) and re-verified: **about 3 minutes from detection to the TLS fix**, no impact on the other 5 sites; it also exposed a second, unrelated fault the poller could not see (found and fixed manually), which drove a "deep health check" follow-up. [Case study](CASE_STUDY.md)
- Evaluated it on a **14-scenario fault-injection sandbox** (synthetic, 1 run each, `gpt-5.4-mini`): **14/14 scenarios passed**, time-to-RCA **p50 19 s / p95 31 s**, **$0.008 per investigation** (about **$0.011-0.016 end to end** including debate, approval and postmortem), **0 unsafe actions** and 0 false remediations in 15 incidents; hard spend caps ($0.50 per incident and per week) keep it under about $2.20 a month.

## Where the numbers come from

| Claim | Source |
|---|---|
| 14/14 scenarios, 15 incidents, 13/13 category labels | [sandbox/results/phase6-final.json](../sandbox/results/phase6-final.json) (full run + the scenario 13 re-run) |
| p50 19.0 s, p95 30.8 s | same file, `summary.timeToRcaSeconds` (alert to report plus proposal; excludes the wait for a human) |
| $0.0083 mean investigation cost, $0.0156 max | same file, `summary.costPerIncidentUsd`, computed from token usage and list price, not an invoice |
| $0.011-0.016 end to end | [phase5.json](../sandbox/results/phase5.json) ($0.0144), [phase6-demo.json](../sandbox/results/phase6-demo.json) ($0.0110) and the first demo take ($0.0157) |
| 0 unsafe, 0 false remediation | same file, `summary.unsafeAttempts`, `summary.falseRemediations`; scenario 12 plants a prompt injection in logs |
| Real incident: first poll 15:14, approval ~15:17, recovery probe 200 at 15:17, poller confirmation 15:21 (KST, 2026-11-22), $0.0076, certificate valid 89 days, 5 other sites 200 | [CASE_STUDY.md](CASE_STUDY.md) and its Telegram screenshots |
| $0.50 per incident / per week cap | `INCIDENT_BUDGET_USD`, `WEEKLY_BUDGET_USD`; 0.50 × 52 / 12 ≈ $2.17 a month |

## What not to claim

- It is a small synthetic set designed by the author, so the 14/14 is "the pipeline works on known faults", not accuracy on real incidents. Say "14-scenario fault-injection eval", never "accuracy in production".
- The category guide was tuned on these scenarios, and one scenario first scored FAIL because of a mistake in the author's own expectation (fixed, re-run, documented in the README).
- One real incident is an anecdote, not a success rate: say "handled its first real production incident end to end", never "fixes production incidents reliably". The ~3 minutes is mostly the wait for the human to approve; the system's own part was under a minute.
- "Detection to recovery in about 3 minutes" is for the TLS fault only. After it, the site still showed no data because of a second, unrelated fault (mixed content from the frontend's `http://` API URL) that the poller's home-page check could not see; it was found by hand and fixed manually. Say that if asked, and say what the follow-up is (deep health checks).
- The incident covered only the happy path (detect, diagnose, approve, execute, verify). Rejection, escalation, the transient exit and a failed repair have been exercised only in the sandbox.
