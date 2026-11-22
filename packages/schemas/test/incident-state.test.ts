import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CategorySchema,
  CONTRACTS,
  DeepCategorySchema,
  IncidentStateSchema,
  renderJsonSchema,
  TriageCategorySchema,
} from "../src/index.ts";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative: string): unknown =>
  JSON.parse(readFileSync(join(pkgDir, relative), "utf8"));

describe("IncidentState schema (SPEC.md §3.1)", () => {
  const valid = readJson("fixtures/incident-state.valid.json") as Record<string, unknown>;

  test("accepts the shared valid fixture", () => {
    expect(IncidentStateSchema.safeParse(valid).success).toBe(true);
  });

  test("accepts a minimal state (all optional fields omitted)", () => {
    const minimal = {
      incidentId: "inc-1",
      project: "gotrip",
      signal: { check: "http", level: "down", summary: "x", at: "2026-11-21T04:00:00Z" },
      evidence: [],
      hypotheses: [],
      iteration: 0,
      costUsd: 0,
    };
    expect(IncidentStateSchema.safeParse(minimal).success).toBe(true);
  });

  test.each([
    ["unknown project", { project: "nope" }],
    ["iteration above the max of 3", { iteration: 4 }],
    ["negative cost", { costUsd: -0.01 }],
    ["unknown top-level key", { extra: true }],
    ["confidence above 1", { verdict: { hypothesisId: "h1", confidence: 1.5 } }],
    [
      "runbook not in the registry",
      { remediation: { runbookId: "rm_rf", params: {}, risk: "low" } },
    ],
    [
      "risk other than low/medium",
      {
        remediation: { runbookId: "certbot_renew", params: {}, risk: "high" },
      },
    ],
    ["invalid approval status", { approval: { status: "maybe" } }],
    [
      "evidence without an id",
      {
        evidence: [
          {
            source: "mcp-infra",
            tool: "tls_inspect",
            excerpt: "x",
            at: "2026-11-21T04:00:00Z",
            hash: "h",
          },
        ],
      },
    ],
  ])("rejects %s", (_name, patch) => {
    expect(IncidentStateSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe("generated JSON Schema (consumed by the Python services)", () => {
  test.each(Object.entries(CONTRACTS))("json/%s is in sync with the zod schema", (file, schema) => {
    const onDisk = readFileSync(join(pkgDir, "json", file), "utf8");
    // If this fails: pnpm --filter @incidentpulse/schemas generate
    expect(onDisk).toBe(renderJsonSchema(schema));
  });
});

describe("categories", () => {
  test("the deep-check categories exist, but an LLM may not choose them", () => {
    expect(DeepCategorySchema.options).toEqual(["mixed_content", "api_down"]);
    for (const c of DeepCategorySchema.options) {
      expect(CategorySchema.options).toContain(c);
      expect(TriageCategorySchema.options).not.toContain(c);
    }
    expect(TriageCategorySchema.options).toContain("unknown");
    expect(TriageCategorySchema.options).toHaveLength(CategorySchema.options.length - 2);
  });
});
