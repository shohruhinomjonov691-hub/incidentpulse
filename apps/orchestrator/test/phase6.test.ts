import { randomUUID } from "node:crypto";
import type { Evidence } from "@incidentpulse/schemas";
import type { Telemetry } from "@incidentpulse/telemetry";
import { Redis } from "ioredis";
import { afterEach, describe, expect, test } from "vitest";
import { causeFingerprint, correlateIncidents } from "../src/correlate.ts";
import { isTransient } from "../src/graph.ts";
import { createInvestigationPolicy } from "../src/investigation-policy.ts";
import { setTelemetry } from "../src/observability.ts";
import type { PrimaryEvidence } from "../src/primary-evidence.ts";
import { runIncident } from "../src/run.ts";
import { graphFor, job, makeMocks } from "./helpers.ts";

const primary = (
  health: PrimaryEvidence["health"],
  category: PrimaryEvidence["category"] = "unknown",
): PrimaryEvidence => ({
  category,
  hash: "h",
  quickEvidence: [],
  unsafeAttempts: 0,
  injectionFlags: 0,
  ...(health ? { health } : {}),
});

const healthy = primary({
  endpoints: [{ url: "https://a.localhost:18443/", ok: true }],
  containers: { "ipsb-a-app": true, "ipsb-a-nginx": true },
});

describe("flapping: the incident closes as transient", () => {
  test("every probe healthy → no triage, no specialist, no LLM spend, no remediation", async () => {
    const m = makeMocks();
    const { state } = await runIncident(graphFor(m), job(), healthy);
    expect(state.workflowStatus).toBe("transient");
    expect(state.costUsd).toBe(0);
    expect(m.triage.calls + m.synth.calls).toBe(0);
    expect(Object.values(m.specialists).every((s) => s.calls === 0)).toBe(true);
    expect(state.remediation).toBeUndefined();
    expect(m.notifier.sent).toHaveLength(1);
    expect(m.notifier.sent[0]).toContain("vaqtincha uzilish");
    expect(state.trace.some((e) => e.event === "closed_as_transient")).toBe(true);
  });

  test("a manual check of a healthy project says so instead of calling it an outage", async () => {
    const m = makeMocks();
    const manual = job({ signal: { ...job().signal, check: "manual" } });
    await runIncident(graphFor(m), manual, healthy);
    expect(m.notifier.sent[0]).toContain("hozir muammo yo‘q");
  });

  test("anything unhealthy (or no probe data at all) keeps the normal investigation", async () => {
    const down = primary({
      endpoints: [{ url: "https://a.localhost:18443/", ok: true }],
      containers: { "ipsb-a-app": false },
    });
    expect(isTransient(down)).toBe(false);
    expect(isTransient(primary(undefined))).toBe(false);
    expect(isTransient(primary({ endpoints: [], containers: { x: true } }))).toBe(false);
    expect(isTransient(undefined)).toBe(false);
    const m = makeMocks();
    const { state } = await runIncident(graphFor(m), job(), down);
    expect(state.workflowStatus).toBeUndefined();
    expect(m.triage.calls).toBe(1);
  });
});

const ev = (tool: string, excerpt: string): Evidence => ({
  id: "p1",
  source: "mcp-infra",
  tool,
  excerpt,
  at: "2026-11-21T04:00:05.000Z",
  hash: "sha256:x",
});
const expiredCert = (host: string) => [
  ev(
    "tls_inspect",
    `tls_inspect(${host}:18443): chainValid=false hostnameMatch=true expired=true notAfter=2025-01-31 (-659d) error=CERT_HAS_EXPIRED subject=${host} issuer=IncidentPulse Sandbox CA`,
  ),
  ev(
    "http_probe",
    `http_probe(https://${host}:18443/): completed=false error=CERT_HAS_EXPIRED certError=CERT_HAS_EXPIRED`,
  ),
];

describe("correlation of incidents (SPEC §9 #13)", () => {
  const at = "2026-11-21T04:00:00.000Z";

  test("two projects with the same expired certificate share one cause", () => {
    const groups = correlateIncidents([
      {
        incidentId: "i1",
        project: "gotrip",
        category: "tls",
        evidence: expiredCert("a.localhost"),
        at,
      },
      {
        incidentId: "i2",
        project: "kervan",
        category: "tls",
        evidence: expiredCert("b.localhost"),
        at,
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.projects.sort()).toEqual(["gotrip", "kervan"]);
  });

  test("different facts, the same project, a far-apart time or a generic 502 do not correlate", () => {
    const other = [
      ev(
        "tls_inspect",
        "tls_inspect(b.localhost): chainValid=false hostnameMatch=true expired=true notAfter=2024-05-01 (-1d) error=CERT_HAS_EXPIRED issuer=Other CA",
      ),
    ];
    const gotrip = {
      incidentId: "i1",
      project: "gotrip",
      category: "tls",
      evidence: expiredCert("a.localhost"),
      at,
    } as const;
    expect(
      correlateIncidents([
        gotrip,
        { incidentId: "i2", project: "kervan", category: "tls", evidence: other, at },
      ]),
    ).toEqual([]);
    expect(correlateIncidents([gotrip, { ...gotrip, incidentId: "i3" }])).toEqual([]);
    expect(
      correlateIncidents([
        gotrip,
        { ...gotrip, incidentId: "i4", project: "kervan", at: "2026-11-21T06:00:00.000Z" },
      ]),
    ).toEqual([]);
    const five = [
      ev("http_probe", "http_probe(https://x/): status=502 redirects=0 final=https://x/"),
    ];
    expect(causeFingerprint("http_5xx", five)).toBeUndefined();
    expect(causeFingerprint("unknown", expiredCert("a"))).toBeUndefined();
  });

  test("the fingerprint ignores host names and ports", () => {
    expect(causeFingerprint("tls", expiredCert("a.localhost"))).toBe(
      causeFingerprint("tls", expiredCert("b.localhost")),
    );
  });
});

const redisUrl = process.env.IT_REDIS_URL;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(!redisUrl)("correlation notice (needs Redis)", () => {
  test("the second project with the same cause triggers one 🔗 message", async () => {
    const prefix = `it:corr:${randomUUID()}`;
    const redis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    cleanups.push(async () => {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    });
    const m = makeMocks({
      triage: { category: "tls", evidence: expiredCert("a.localhost") },
      specialists: { infra: { evidence: expiredCert("a.localhost") }, logs: { available: false } },
    });
    const policy = createInvestigationPolicy({
      redis,
      prefix,
      mode: "on_change",
      graph: graphFor(m),
      notifier: m.notifier,
      redact: m.deps.redact,
      probe: async (incident) => ({
        category: "tls",
        hash: incident.project,
        quickEvidence: [],
        unsafeAttempts: 0,
        injectionFlags: 0,
      }),
    });
    await policy.monitor(job({ incidentId: "c1", project: "gotrip" }));
    expect(m.notifier.sent.filter((t) => t.startsWith("🔗"))).toHaveLength(0);
    await policy.monitor(
      job({
        incidentId: "c2",
        project: "kervan",
        signal: { ...job().signal, at: "2026-11-21T04:00:02.000Z" },
      }),
    );
    expect(m.notifier.sent.filter((t) => t.startsWith("🔗"))).toHaveLength(1);
  });
});

describe("tracing hooks", () => {
  test("every graph node runs inside an observation of its incident's trace; off by default", async () => {
    const seen: Array<{ incidentId: string; name: string }> = [];
    const recorder: Telemetry = {
      enabled: true,
      observe: (options, fn) => {
        seen.push({ incidentId: options.incidentId, name: options.name });
        return fn();
      },
      generation: () => undefined,
      tool: () => undefined,
      shutdown: async () => undefined,
    };
    setTelemetry(recorder);
    try {
      await runIncident(graphFor(makeMocks()), job({ incidentId: "inc-trace" }));
    } finally {
      setTelemetry({ ...recorder, enabled: false, observe: (_o, fn) => fn() });
    }
    const names = seen.map((s) => s.name);
    expect(new Set(seen.map((s) => s.incidentId))).toEqual(new Set(["inc-trace"]));
    expect(names).toEqual(
      expect.arrayContaining([
        "node:intake",
        "node:triage",
        "node:investigate:infra",
        "node:join",
        "node:synthesize",
        "node:report",
      ]),
    );
  });
});
