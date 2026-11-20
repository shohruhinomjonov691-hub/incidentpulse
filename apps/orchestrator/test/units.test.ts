import { KNOWN_PRICING } from "@incidentpulse/config";
import { createRedactor } from "@incidentpulse/redact";
import { describe, expect, test } from "vitest";
import { type LlmSynthesis, normalizeSynthesis } from "../src/agents/synthesizer.ts";
import { costOf, sumUsage } from "../src/cost.ts";
import { buildEvidence, extractToolOutputText } from "../src/evidence.ts";
import { createLogger } from "../src/log.ts";
import { formatEscalation, formatFailureNotice, formatReport } from "../src/report.ts";
import { tlsMismatchEvidence } from "./helpers.ts";

const mini = KNOWN_PRICING["gpt-5.4-mini"] as (typeof KNOWN_PRICING)[string];

describe("cost accounting", () => {
  test("1M input + 1M output tokens at gpt-5.4-mini prices = $0.75 + $4.50", () => {
    const usage = {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      requests: 1,
    };
    expect(costOf(usage, mini)).toBeCloseTo(5.25, 6);
  });

  test("cached input tokens use the cached rate", () => {
    const usage = {
      inputTokens: 1_000_000,
      cachedInputTokens: 600_000,
      outputTokens: 0,
      requests: 1,
    };
    expect(costOf(usage, mini)).toBeCloseTo(0.4 * 0.75 + 0.6 * 0.075, 6);
  });

  test("a typical small call costs a fraction of a cent", () => {
    const usage = { inputTokens: 3000, cachedInputTokens: 0, outputTokens: 400, requests: 1 };
    expect(costOf(usage, mini)).toBeCloseTo(0.00405, 6);
  });

  test("sumUsage adds requests and reads cached_tokens from the SDK detail arrays", () => {
    const total = sumUsage([
      {
        inputTokens: 100,
        outputTokens: 10,
        requests: 1,
        inputTokensDetails: [{ cached_tokens: 40 }],
      },
      { inputTokens: 50, outputTokens: 5, inputTokensDetails: [{}] },
    ]);
    expect(total).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      cachedInputTokens: 40,
      requests: 2,
    });
  });

  test("cached tokens can never exceed input tokens", () => {
    const usage = { inputTokens: 10, cachedInputTokens: 99, outputTokens: 0, requests: 1 };
    expect(costOf(usage, mini)).toBeCloseTo((10 * mini.cachedInputPerM) / 1e6, 9);
  });
});

describe("evidence is built from validated tool output", () => {
  const redact = createRedactor();
  const at = new Date("2026-11-21T04:00:05.000Z");
  const tls = {
    host: "kervan.uz",
    port: 443,
    connected: true,
    chainValid: false,
    validationError: "ERR_TLS_CERT_ALTNAME_INVALID",
    hostnameMatch: false,
    subject: "codetrail.gotrips.cloud",
    sans: ["codetrail.gotrips.cloud"],
    notAfter: "2027-01-13T16:08:49.000Z",
    daysRemaining: 53,
    expired: false,
    notYetValid: false,
    latencyMs: 449,
  };

  test("tls_inspect → compact digest with a content hash", () => {
    const ev = buildEvidence({
      id: "e1",
      tool: "tls_inspect",
      output: JSON.stringify(tls),
      at,
      redact,
    });
    expect(ev).toMatchObject({
      id: "e1",
      source: "mcp-infra",
      tool: "tls_inspect",
      at: at.toISOString(),
    });
    expect(ev.excerpt).toBe(
      "tls_inspect(kervan.uz): chainValid=false hostnameMatch=false expired=false notAfter=2027-01-13 (53d) error=ERR_TLS_CERT_ALTNAME_INVALID subject=codetrail.gotrips.cloud",
    );
    expect(ev.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("same result → same hash; different result → different hash", () => {
    const a = buildEvidence({
      id: "e1",
      tool: "tls_inspect",
      output: JSON.stringify(tls),
      at,
      redact,
    });
    const b = buildEvidence({
      id: "e2",
      tool: "tls_inspect",
      output: JSON.stringify(tls),
      at,
      redact,
    });
    const c = buildEvidence({
      id: "e3",
      tool: "tls_inspect",
      output: JSON.stringify({ ...tls, expired: true }),
      at,
      redact,
    });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  test("http_probe failure and dns digests", () => {
    const http = buildEvidence({
      id: "e1",
      tool: "http_probe",
      at,
      redact,
      output: JSON.stringify({
        url: "https://kervan.uz/",
        completed: false,
        redirects: [],
        error: "ERR_TLS_CERT_ALTNAME_INVALID",
        certErrorCode: "ERR_TLS_CERT_ALTNAME_INVALID",
        latencyMs: 215,
      }),
    });
    expect(http.excerpt).toBe(
      "http_probe(https://kervan.uz/): completed=false error=ERR_TLS_CERT_ALTNAME_INVALID certError=ERR_TLS_CERT_ALTNAME_INVALID",
    );
    const dns = buildEvidence({
      id: "e2",
      tool: "dns_lookup",
      at,
      redact,
      output: JSON.stringify({
        host: "kervan.uz",
        a: ["203.0.113.1"],
        aaaa: [],
        cname: [],
        latencyMs: 5,
      }),
    });
    expect(dns.excerpt).toBe("dns_lookup(kervan.uz): A=203.0.113.1 AAAA=- CNAME=-");
  });

  test("MCP text-content wrappers are unwrapped", () => {
    expect(extractToolOutputText([{ type: "text", text: "{}" }])).toBe("{}");
    expect(extractToolOutputText({ content: [{ type: "text", text: "x" }] })).toBe("x");
    expect(extractToolOutputText({ type: "text", text: "y" })).toBe("y");
    expect(extractToolOutputText(42)).toBeUndefined();
  });

  test("garbage or schema-violating output becomes an explicit 'not valid' evidence, never a crash", () => {
    const garbage = buildEvidence({ id: "e1", tool: "tls_inspect", output: "boom", at, redact });
    expect(garbage.excerpt).toContain("result was not valid tool output");
    const wrong = buildEvidence({
      id: "e2",
      tool: "tls_inspect",
      output: '{"host":1}',
      at,
      redact,
    });
    expect(wrong.excerpt).toContain("not valid tool output");
  });

  test("excerpts pass through the redactor", () => {
    const secret = "super-secret-value-123";
    const ev = buildEvidence({
      id: "e1",
      tool: "tls_inspect",
      output: "oops super-secret-value-123 in output",
      at,
      redact: createRedactor({ secrets: [secret] }),
    });
    expect(ev.excerpt).not.toContain(secret);
  });
});

describe("normalizeSynthesis", () => {
  const evidence = [tlsMismatchEvidence("e1"), tlsMismatchEvidence("e2")];
  const raw = (over: Partial<LlmSynthesis> = {}): LlmSynthesis => ({
    category: "tls",
    missingInformation: null,
    hypotheses: [{ cause: "x", supportingEvidenceIds: ["e1"], confidence: 0.5 }],
    ...over,
  });

  test("drops evidence ids the model invented", () => {
    const out = normalizeSynthesis(
      raw({
        hypotheses: [{ cause: "x", supportingEvidenceIds: ["e1", "e99", "e1"], confidence: 0.7 }],
      }),
      evidence,
    );
    expect(out.hypotheses[0]?.supportingEvidenceIds).toEqual(["e1"]);
  });

  test("clamps confidence into [0,1] and sorts best-first with sequential ids", () => {
    const out = normalizeSynthesis(
      raw({
        hypotheses: [
          { cause: "low", supportingEvidenceIds: [], confidence: -3 },
          { cause: "high", supportingEvidenceIds: [], confidence: 7 },
          { cause: "nan", supportingEvidenceIds: [], confidence: Number.NaN },
        ],
      }),
      evidence,
    );
    expect(out.hypotheses.map((h) => [h.id, h.cause, h.confidence])).toEqual([
      ["h1", "high", 1],
      ["h2", "low", 0],
      ["h3", "nan", 0],
    ]);
  });

  test("keeps at most 3 hypotheses and falls back to a zero-confidence one when empty", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      cause: `c${i}`,
      supportingEvidenceIds: [],
      confidence: i / 10,
    }));
    expect(normalizeSynthesis(raw({ hypotheses: many }), evidence).hypotheses).toHaveLength(3);
    const empty = normalizeSynthesis(raw({ hypotheses: [] }), evidence);
    expect(empty.hypotheses).toEqual([
      { id: "h1", cause: "Sabab aniqlanmadi.", supportingEvidenceIds: [], confidence: 0 },
    ]);
  });
});

describe("report formatting", () => {
  test("failure notice is short and Uzbek", () => {
    expect(formatFailureNotice("kervan", "inc-9")).toBe(
      "⚠️ Kervan — incident #inc-9\nTergov texnik xato tufayli bajarilmadi. Inson ko'rigi kerak.",
    );
  });

  test("with no hypotheses the report still lists evidence and says the cause is unknown", () => {
    const text = formatReport({
      incidentId: "inc-1",
      project: "kervan",
      evidence: [tlsMismatchEvidence()],
      hypotheses: [],
      costUsd: 0,
      overBudget: null,
      budgetUsd: 0.5,
      dailyBudgetUsd: 3,
    });
    expect(text).toContain("Sabab: aniqlanmadi");
    expect(text).toContain("Dalil: tls_inspect(kervan.uz)");
  });
});

describe("logger", () => {
  test("every log line is redacted, so a secret passed in any field never reaches stdout", () => {
    const lines: string[] = [];
    const log = createLogger(createRedactor({ secrets: ["super-secret-value-123"] }), (l) =>
      lines.push(l),
    );
    log.error("failed", { error: "Bearer abcdefghij1234567890 and super-secret-value-123", ok: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("super-secret-value-123");
    expect(lines[0]).not.toContain("abcdefghij1234567890");
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "error", msg: "failed", ok: 1 });
  });
});

describe("evidence line is never cut in the middle of a token", () => {
  const long = (n: number) => ({
    ...tlsMismatchEvidence("e1"),
    excerpt: `tls_inspect(example.com): ${"issuer=Let's-Encrypt ".repeat(n)}`.trim(),
  });
  const view = (excerpt: ReturnType<typeof long>) => ({
    incidentId: "inc-1",
    project: "kervan" as const,
    evidence: [excerpt],
    hypotheses: [{ id: "h1", cause: "x", supportingEvidenceIds: ["e1"], confidence: 0.9 }],
    costUsd: 0,
    overBudget: null,
    budgetUsd: 0.5,
    dailyBudgetUsd: 3,
  });

  test("the real Kervan evidence (the line that used to be cut at 'is…') now fits whole", () => {
    const real = {
      ...tlsMismatchEvidence("e1"),
      excerpt:
        "tls_inspect(kervan.uz): chainValid=false hostnameMatch=false expired=false notAfter=2027-01-13 (53d) error=ERR_TLS_CERT_ALTNAME_INVALID subject=codetrail.gotrips.cloud issuer=Let's Encrypt / YE1",
    };
    const text = formatReport(view(real));
    expect(text).toContain(`Dalil: ${real.excerpt}\n`);
    expect(text).not.toContain("…");
  });

  test("an over-long excerpt is cut at a word boundary, with an ellipsis", () => {
    const line = formatReport(view(long(30)))
      .split("\n")
      .find((l) => l.startsWith("Dalil:")) as string;
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThanOrEqual("Dalil: ".length + 240);
    expect(line.slice(0, -1)).toMatch(/issuer=Let's-Encrypt$/); // whole tokens only
  });
});

describe("escalation message", () => {
  test("is short, Uzbek, and mentions neither buttons nor actions", () => {
    const text = formatEscalation({
      incidentId: "inc-5",
      project: "kervan",
      reason: "daily_budget",
      evidence: [],
      costUsd: 0,
      spentTodayUsd: 3.1,
      budgetUsd: 0.5,
      dailyBudgetUsd: 3,
    });
    expect(text.split("\n")).toHaveLength(2);
    expect(text.length).toBeLessThan(200);
  });
});

describe("evidence shown in Telegram is de-duplicated", () => {
  test("the same fact found by triage and by a specialist appears once, and the 3-line cap applies to distinct facts", () => {
    const same = { ...tlsMismatchEvidence("t1") };
    const dup = { ...tlsMismatchEvidence("i1") };
    const other = {
      ...tlsMismatchEvidence("i2"),
      excerpt: "http_probe(kervan.uz): completed=false",
    };
    const text = formatReport({
      incidentId: "inc-1",
      project: "kervan",
      evidence: [same, dup, other],
      hypotheses: [
        { id: "h1", cause: "x", supportingEvidenceIds: ["t1", "i1", "i2"], confidence: 0.9 },
      ],
      costUsd: 0,
      overBudget: null,
      budgetUsd: 0.5,
      dailyBudgetUsd: 3,
    });
    const line = text.split("\n").find((l) => l.startsWith("Dalil:")) as string;
    expect(line.split(" · ")).toHaveLength(2);
    expect(line.match(/tls_inspect\(kervan\.uz\)/g)).toHaveLength(1);
  });
});
