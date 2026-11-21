# Architecture Decision Records

One short ADR per framework choice (see [SPEC §2](../SPEC.md)). Written at the end of Phase 6 from what was actually built, including two places where the build deviates from the spec (ADR-008, ADR-011).

| ADR | Decision | Status |
|---|---|---|
| [001](ADR-001-langgraph-js.md) | LangGraph.js as the incident state machine | accepted |
| [002](ADR-002-openai-agents-sdk.md) | OpenAI Agents SDK (JS) for triage, handoffs and guardrails | accepted |
| [003](ADR-003-mcp-typescript-sdk.md) | Model Context Protocol (TS SDK) for all tools | accepted |
| [004](ADR-004-autogen-or-agent-framework.md) | Microsoft Agent Framework for the debate verifier (instead of AutoGen) | accepted |
| [005](ADR-005-crewai.md) | CrewAI for the postmortem crew | accepted |
| [006](ADR-006-vercel-ai-sdk-nextjs.md) | Vercel AI SDK + Next.js for the live UI | accepted (narrower than the spec) |
| [007](ADR-007-langfuse-opentelemetry.md) | Langfuse + OpenTelemetry for observability | accepted (not verified against live Langfuse) |
| [008](ADR-008-postgresql-drizzle.md) | PostgreSQL for durable state (Drizzle not adopted) | deviation |
| [009](ADR-009-redis-bullmq.md) | Redis + BullMQ for the intake queue | accepted |
| [010](ADR-010-grammy.md) | grammY for the Telegram bot | accepted |
| [011](ADR-011-promptfoo.md) | Custom eval harness (promptfoo not adopted) | deviation |
