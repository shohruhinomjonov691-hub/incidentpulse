# @incidentpulse/schemas

Shared contracts between the TypeScript core and the Python services.

- `src/incident-state.ts` — the `IncidentState` zod schema from [docs/SPEC.md](../../docs/SPEC.md) §3.1 (strict objects).
- `json/incident-state.schema.json` — **generated** JSON Schema (draft 2020-12) via zod's built-in `z.toJSONSchema()`. Do not edit by hand.
- `fixtures/incident-state.valid.json` — one valid document, validated by both the Vitest tests and each Python service's pytest.

```bash
pnpm --filter @incidentpulse/schemas generate   # regenerate json/
pnpm --filter @incidentpulse/schemas test       # includes a drift check: json/ must match zod
```

CI runs `generate` and fails if it leaves a diff.
