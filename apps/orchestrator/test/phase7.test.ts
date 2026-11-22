import { randomUUID } from "node:crypto";
import { KNOWN_PRICING, type ModelPricing } from "@incidentpulse/config";
import { loadRunbookRegistry } from "@incidentpulse/mcp-actions";
import type { HttpProbeResult } from "@incidentpulse/mcp-infra";
import { createRedactor } from "@incidentpulse/redact";
import type { RunnerClient } from "@incidentpulse/runner-client";
import type { IncidentJob } from "@incidentpulse/schemas";
import { type Redis, Redis as RedisClient } from "ioredis";
import { describe, expect, test, vi } from "vitest";
import { causeFingerprint } from "../src/correlate.ts";
import { buildEvidence } from "../src/evidence.ts";
import { buildIncidentGraph, isTransient } from "../src/graph.ts";
import { createHealthPoller, failureOf, HEALTH_POLL_CHECK } from "../src/health-poller.ts";
import { createHostInventory } from "../src/host-inventory.ts";
import { createLogger } from "../src/log.ts";
import { createRemediationProposer } from "../src/remediation-proposer.ts";
import { runIncident } from "../src/run.ts";
import { createIncidentWorker } from "../src/worker.ts";
import { job, makeMocks } from "./helpers.ts";
import { finalText, ScriptedModel } from "./scripted-model.ts";

// ------------------------------------------------------------------ health poller

function fakeRedis(): Redis {
  const hashes = new Map<string, Map<string, string>>();
  return {
    hget: async (key: string, field: string) => hashes.get(key)?.get(field) ?? null,
    hset: async (key: string, field: string, value: string) => {
      hashes.set(key, (hashes.get(key) ?? new Map()).set(field, value));
      return 1;
    },
  } as unknown as Redis;
}

const answer = (over: Partial<HttpProbeResult> = {}): HttpProbeResult => ({
  url: "https://kervan.uz/",
  completed: true,
  status: 200,
  redirects: [],
  latencyMs: 5,
  ...over,
});

function pollerFixture(initial: Array<HttpProbeResult | Error> = []) {
  const redis = fakeRedis();
  const results = [...initial];
  let fallback: HttpProbeResult = answer();
  const probe = vi.fn(async () => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next ?? fallback;
  });
  const monitor = vi.fn(async (_job: IncidentJob) => "investigated");
  const notifier = { send: vi.fn(async () => ({ messageId: 1 })) };
  const clock = { at: new Date("2026-11-21T10:00:00Z") };
  const poller = createHealthPoller({
    redis,
    targets: { kervan: ["https://kervan.uz/"] },
    allowedHosts: {
      kervan: ["kervan.uz"],
      gotrip: [],
      "camera-studio": [],
      codetrail: [],
      findit: [],
      "food-lens": [],
    },
    notifier,
    redact: createRedactor(),
    monitor,
    probe,
    now: () => clock.at,
    sleep: async () => undefined,
    confirmDelayMs: 0,
  });
  return {
    poller,
    probe,
    monitor,
    notifier,
    setFallback: (value: HttpProbeResult) => {
      fallback = value;
    },
    advance: (minutes = 15) => {
      clock.at = new Date(clock.at.getTime() + minutes * 60_000);
    },
  };
}

describe("health poller (no LLM)", () => {
  test("a healthy project raises nothing, however many times it is polled", async () => {
    const f = pollerFixture();
    await f.poller.run();
    f.advance();
    await f.poller.run();
    expect(f.monitor).not.toHaveBeenCalled();
    expect(f.notifier.send).not.toHaveBeenCalled();
  });

  test("ok -> down starts exactly one investigation; staying down raises nothing more", async () => {
    const f = pollerFixture();
    await f.poller.run();
    f.setFallback(answer({ completed: false, status: undefined, error: "ECONNREFUSED" }));
    f.advance();
    await f.poller.run();
    expect(f.monitor).toHaveBeenCalledTimes(1);
    const raised = f.monitor.mock.calls[0]?.[0] as IncidentJob;
    expect(raised).toMatchObject({
      project: "kervan",
      signal: { check: HEALTH_POLL_CHECK, level: "down" },
    });
    expect(raised.signal.summary).toContain("kervan.uz: ECONNREFUSED");
    for (let i = 0; i < 4; i++) {
      f.advance();
      await f.poller.run();
    }
    expect(f.monitor).toHaveBeenCalledTimes(1);
  });

  test("a project that is already down on the first look is reported", async () => {
    const f = pollerFixture();
    f.setFallback(answer({ status: 502 }));
    await f.poller.run();
    expect(f.monitor).toHaveBeenCalledTimes(1);
    expect(((f.monitor.mock.calls[0] ?? [])[0] as IncidentJob).signal.summary).toContain(
      "HTTP 502",
    );
  });

  test("a blip is confirmed before it counts: one failure then a success is not an incident", async () => {
    const f = pollerFixture([answer({ completed: false, status: undefined, error: "ETIMEDOUT" })]);
    await f.poller.run();
    expect(f.monitor).not.toHaveBeenCalled();
    expect(f.probe).toHaveBeenCalledTimes(2);
  });

  test("down -> ok informs the policy and Telegram once", async () => {
    const f = pollerFixture();
    f.setFallback(answer({ status: 503 }));
    await f.poller.run();
    f.setFallback(answer());
    f.advance();
    await f.poller.run();
    expect(f.monitor).toHaveBeenCalledTimes(2);
    expect(((f.monitor.mock.calls[1] ?? [])[0] as IncidentJob).signal.level).toBe("ok");
    expect(f.notifier.send).toHaveBeenCalledTimes(1);
    f.advance();
    await f.poller.run();
    expect(f.monitor).toHaveBeenCalledTimes(2);
  });

  test("if the policy throws, the change is raised again at the next poll", async () => {
    const f = pollerFixture();
    f.setFallback(answer({ status: 500 }));
    f.monitor.mockRejectedValueOnce(new Error("redis down"));
    await f.poller.run();
    f.advance();
    await f.poller.run();
    expect(f.monitor).toHaveBeenCalledTimes(2);
  });

  test("4xx is the app answering, not an outage; TLS failures are", () => {
    expect(failureOf("https://a.example/", answer({ status: 404 }))).toBeUndefined();
    expect(failureOf("https://a.example/", answer({ status: 500 }))).toContain("HTTP 500");
    expect(
      failureOf(
        "https://a.example/",
        answer({ completed: false, certErrorCode: "CERT_HAS_EXPIRED" }),
      ),
    ).toContain("CERT_HAS_EXPIRED");
  });
});

// ------------------------------------------------------------- proposer with inventory

const registry = loadRunbookRegistry(
  {
    kervan: {
      domains: ["kervan.uz"],
      pm2: ["KERVAN", "KERVAN-REACT"],
      nginx: true,
      webroot: "/var/www/acme",
      www: true,
    },
  },
  undefined,
  { remote: true },
);

const pricing = KNOWN_PRICING["gpt-5.4-mini"] as ModelPricing;
const pick = (runbookId: string | null, params: Array<{ name: string; value: string }> = []) =>
  finalText(JSON.stringify({ runbookId, params }));

// Kervan's first rollout: no www (policy, scope and DNS all say so).
const registryNoWww = loadRunbookRegistry(
  {
    kervan: {
      domains: ["kervan.uz"],
      pm2: ["KERVAN", "KERVAN-REACT"],
      nginx: true,
      webroot: "/var/www/acme",
      www: false,
    },
  },
  undefined,
  { remote: true },
);

async function propose(
  inventory: Parameters<typeof createRemediationProposer>[0]["inventory"],
  script: ReturnType<typeof pick>,
  using: typeof registry = registry,
) {
  const m = makeMocks();
  const { state } = await runIncident(buildIncidentGraph(m.deps), job());
  const model = new ScriptedModel([script]);
  const proposer = createRemediationProposer({
    registry: using,
    model,
    pricing,
    redact: m.deps.redact,
    ...(inventory ? { inventory } : {}),
  });
  return { result: await proposer(state), model };
}

const missingEverything = async () => ({
  domains: [{ domain: "kervan.uz", vhost: false, certificate: false }],
  upstreams: [
    { app: "KERVAN", upstream: "127.0.0.1:3000" },
    { app: "KERVAN-REACT", upstream: "127.0.0.1:3001" },
  ],
});

describe("remediation proposer with a host inventory", () => {
  test("no vhost: only nginx_site_proxy is offered, with the discovered upstreams", async () => {
    const { result, model } = await propose(
      missingEverything,
      pick("nginx_site_proxy", [
        { name: "domain", value: "kervan.uz" },
        { name: "upstream", value: "127.0.0.1:3001" },
      ]),
    );
    expect(result.book).toMatchObject({
      runbookId: "nginx_site_proxy",
      risk: "medium",
      params: { domain: "kervan.uz", upstream: "127.0.0.1:3001" },
    });
    const shown = model.seen();
    expect(shown).toContain("127.0.0.1:3001");
    expect(shown).toContain('\\"id\\":\\"nginx_site_proxy\\"');
    expect(shown).not.toContain('\\"id\\":\\"certbot_nginx_issue\\"');
  });

  test("an upstream the runner did not discover is rejected", async () => {
    const { result } = await propose(
      missingEverything,
      pick("nginx_site_proxy", [
        { name: "domain", value: "kervan.uz" },
        { name: "upstream", value: "127.0.0.1:9999" },
      ]),
    );
    expect(result.book).toBeUndefined();
    expect(result.rejected).toBe(true);
  });

  test("vhost present, certificate missing: certbot_nginx_issue only (and it covers www)", async () => {
    const { result, model } = await propose(
      async () => ({
        domains: [{ domain: "kervan.uz", vhost: true, certificate: false }],
        upstreams: [{ app: "KERVAN", upstream: "127.0.0.1:3000" }],
      }),
      pick("certbot_nginx_issue", [{ name: "domain", value: "kervan.uz" }]),
    );
    expect(result.book?.runbookId).toBe("certbot_nginx_issue");
    expect(result.book?.run[0]?.args).toContain("www.kervan.uz");
    expect(model.seen()).toContain('\\"id\\":\\"certbot_nginx_issue\\"');
    expect(model.seen()).not.toContain('\\"id\\":\\"nginx_site_proxy\\"');
  });

  test("the model cannot pick certbot while the vhost is missing", async () => {
    const { result } = await propose(
      missingEverything,
      pick("certbot_nginx_issue", [{ name: "domain", value: "kervan.uz" }]),
    );
    expect(result.book).toBeUndefined();
    expect(result.rejected).toBe(true);
  });

  describe("Kervan as it really is: vhost in conf.d/kervan.conf (listen 80), no certificate, no www", () => {
    const kervanReal = async () => ({
      domains: [{ domain: "kervan.uz", vhost: true, certificate: false }],
      upstreams: [{ app: "KERVAN", upstream: "127.0.0.1:3000" }],
    });

    test("nginx_site_proxy is not offered; certbot_nginx_issue is, with -d kervan.uz only", async () => {
      const { result, model } = await propose(
        kervanReal,
        pick("certbot_nginx_issue", [{ name: "domain", value: "kervan.uz" }]),
        registryNoWww,
      );
      expect(result.book?.runbookId).toBe("certbot_nginx_issue");
      expect(result.book?.dryRun[0]?.args).toEqual([
        "certonly",
        "--dry-run",
        "--non-interactive",
        "--nginx",
        "-d",
        "kervan.uz",
      ]);
      expect(result.book?.run[0]?.args).toEqual([
        "--nginx",
        "-d",
        "kervan.uz",
        "--non-interactive",
        "--redirect",
      ]);
      expect(JSON.stringify(result.book)).not.toContain("www.");
      expect(model.seen()).not.toContain('\\"id\\":\\"nginx_site_proxy\\"');
    });

    test("the model cannot pick nginx_site_proxy even if it tries: the proposal is rejected", async () => {
      const { result } = await propose(
        kervanReal,
        pick("nginx_site_proxy", [
          { name: "domain", value: "kervan.uz" },
          { name: "upstream", value: "127.0.0.1:3000" },
        ]),
        registryNoWww,
      );
      expect(result.book).toBeUndefined();
      expect(result.rejected).toBe(true);
    });

    test("vhost and certificate both present: nothing is proposed for the web-serving runbooks", async () => {
      const { result } = await propose(
        async () => ({
          domains: [{ domain: "kervan.uz", vhost: true, certificate: true }],
          upstreams: [{ app: "KERVAN", upstream: "127.0.0.1:3000" }],
        }),
        pick("nginx_site_proxy", [
          { name: "domain", value: "kervan.uz" },
          { name: "upstream", value: "127.0.0.1:3000" },
        ]),
        registryNoWww,
      );
      expect(result.book).toBeUndefined();
    });
  });

  test("without an inventory (runner down) nginx_site_proxy is never offered", async () => {
    const { result } = await propose(
      async () => undefined,
      pick("nginx_site_proxy", [
        { name: "domain", value: "kervan.uz" },
        { name: "upstream", value: "127.0.0.1:3000" },
      ]),
    );
    expect(result.book).toBeUndefined();
  });
});

describe("host inventory", () => {
  const client = (over: Partial<RunnerClient> = {}): RunnerClient => ({
    read: (async (op: string) =>
      ({
        nginx_config: {
          servers: [{ names: ["kervan.uz"], listens: ["80"], ssl: false, proxyPass: [] }],
        },
        cert_list: { certificates: [] },
        pm2_ports: {
          apps: [
            { app: "KERVAN", ports: [3000] },
            { app: "OTHER", ports: [22] },
          ],
        },
      })[op]) as never,
    dryRun: async () => ({ ok: true, output: "" }),
    execute: async () => ({ ok: true, output: "" }),
    health: async () => true,
    ...over,
  });
  const scopes = { kervan: { domains: ["kervan.uz"], pm2: ["KERVAN"], www: false } };

  test("a vhost from any included file (conf.d) counts; foreign apps are ignored", async () => {
    // nginx_config reads `nginx -T`, so the runner reports conf.d/kervan.conf like any sites-enabled file.
    const inventory = await createHostInventory(client(), scopes)("kervan");
    expect(inventory).toEqual({
      domains: [{ domain: "kervan.uz", vhost: true, certificate: false }],
      upstreams: [{ app: "KERVAN", upstream: "127.0.0.1:3000" }],
    });
  });

  test("with www in scope, a block naming only the apex still counts as a vhost (never a second block)", async () => {
    const inventory = await createHostInventory(client(), {
      kervan: { ...scopes.kervan, www: true },
    })("kervan");
    expect(inventory?.domains).toEqual([{ domain: "kervan.uz", vhost: true, certificate: false }]);
  });

  test("no server block names the domain: vhost=false, so nginx_site_proxy may be offered", async () => {
    const none = client({
      read: (async (op: string) =>
        ({
          nginx_config: { servers: [] },
          cert_list: { certificates: [] },
          pm2_ports: { apps: [] },
        })[op]) as never,
    });
    const inventory = await createHostInventory(none, scopes)("kervan");
    expect(inventory?.domains).toEqual([{ domain: "kervan.uz", vhost: false, certificate: false }]);
  });

  test("a runner failure yields undefined, never a guess", async () => {
    const down = client({ read: async () => Promise.reject(new Error("ENOENT")) });
    expect(await createHostInventory(down, scopes)("kervan")).toBeUndefined();
    expect(await createHostInventory(client(), scopes)("gotrip")).toBeUndefined();
  });
});

// ---------------------------------------------------------------- evidence and transient

describe("evidence digests carry the markers the proposer relies on", () => {
  const redact = createRedactor();
  const digest = (tool: string, output: unknown) =>
    buildEvidence({ id: "e", tool, output: JSON.stringify(output), at: new Date(), redact })
      .excerpt;

  test("nginx_config and cert_list", () => {
    expect(
      digest("nginx_config", {
        hosts: [
          { host: "kervan.uz", vhost: false, listens: [], ssl: false, proxyPass: [] },
          {
            host: "a.example",
            vhost: true,
            listens: ["443"],
            ssl: true,
            proxyPass: ["http://127.0.0.1:3000"],
          },
        ],
      }),
    ).toBe(
      "nginx_config: kervan.uz vhost=missing; a.example vhost=present listen=443 ssl=true proxy=http://127.0.0.1:3000",
    );
    expect(
      digest("cert_list", {
        hosts: [
          { host: "kervan.uz", certificate: false },
          {
            host: "a.example",
            certificate: true,
            expiresAt: "2027-01-05T10:00:00.000Z",
            valid: true,
          },
        ],
      }),
    ).toBe("cert_list: kervan.uz cert=missing; a.example cert=present notAfter=2027-01-05");
  });

  test("pm2_ports and pm2_logs", () => {
    expect(
      digest("pm2_ports", {
        apps: [
          { name: "KERVAN", ports: [3000] },
          { name: "X", ports: [] },
        ],
      }),
    ).toBe("pm2_ports: KERVAN ports=3000; X ports=none");
    expect(digest("pm2_logs", { app: "KERVAN", lines: ["ok", "Error: boom"] })).toContain(
      "«Error: boom»",
    );
  });
});

describe("correlation fingerprints", () => {
  const evidence = (tool: string, excerpt: string) => ({
    id: "e1",
    source: "mcp-infra",
    tool,
    excerpt,
    at: "2026-11-21T04:00:05.000Z",
    hash: "sha256:e1",
  });
  test("come from fixed probes, never from application log text", () => {
    const probe = evidence(
      "tls_inspect",
      "tls_inspect(a.example): chainValid=false expired=true error=CERT_HAS_EXPIRED notAfter=2026-11-18 (-3d)",
    );
    const log = evidence(
      "docker_logs",
      "docker_logs(app): 3 lines; key lines: «error=CERT_HAS_EXPIRED notAfter=2026-11-18»",
    );
    expect(causeFingerprint("tls", [probe])).toBeDefined();
    expect(causeFingerprint("tls", [log])).toBeUndefined();
    expect(causeFingerprint("tls", [probe, log])).toBe(causeFingerprint("tls", [probe]));
  });
});

describe("transient", () => {
  const primary = (health: NonNullable<Parameters<typeof isTransient>[0]>["health"]) =>
    ({
      category: "unknown",
      hash: "h",
      quickEvidence: [],
      unsafeAttempts: 0,
      injectionFlags: 0,
      health,
    }) as never;

  test("healthy endpoints and containers close as transient", () => {
    expect(
      isTransient(
        primary({ endpoints: [{ url: "https://a/", ok: true }], containers: { c: true } }),
      ),
    ).toBe(true);
  });
  test("a down endpoint or container never does", () => {
    expect(
      isTransient(primary({ endpoints: [{ url: "https://a/", ok: false }], containers: {} })),
    ).toBe(false);
    expect(
      isTransient(
        primary({ endpoints: [{ url: "https://a/", ok: true }], containers: { c: false } }),
      ),
    ).toBe(false);
  });
  test("a docker or pm2 probe that could not answer is unknown, not healthy", () => {
    expect(
      isTransient(
        primary({ endpoints: [{ url: "https://a/", ok: true }], containers: {}, unknown: true }),
      ),
    ).toBe(false);
  });
});

describe.skipIf(!process.env.IT_REDIS_URL)("worker and the health poller (real Redis)", () => {
  test("the poller runs once at start, as a job of the single-concurrency queue", async () => {
    const url = process.env.IT_REDIS_URL as string;
    const queueName = `it-poll-${randomUUID()}`;
    const redact = createRedactor();
    const run = vi.fn(async () => ({ checked: 0, changes: [] }));
    const worker = await createIncidentWorker({
      redisUrl: url,
      investigations: {} as never,
      investigateMode: "on_change",
      notifier: { send: async () => ({ messageId: 1 }) },
      redact,
      log: createLogger(redact),
      queueName,
      healthPoller: { run } as never,
    });
    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1), { timeout: 8000 });
    } finally {
      await worker.close();
      const redis = new RedisClient(url);
      const keys = await redis.keys(`bull:${queueName}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
  });

  test("the deep check is its own job on its own interval, once at start too, and off at 0", async () => {
    const url = process.env.IT_REDIS_URL as string;
    const redact = createRedactor();
    const make = async (queueName: string, minutes: number | undefined, withDeep = true) => {
      const run = vi.fn(async () => ({ checked: 0, changes: [] }));
      const runDeep = vi.fn(async () => ({ checked: 0, degraded: 0, levels: [] }));
      const worker = await createIncidentWorker({
        redisUrl: url,
        investigations: {} as never,
        investigateMode: "on_change",
        notifier: { send: async () => ({ messageId: 1 }) },
        redact,
        log: createLogger(redact),
        queueName,
        healthPoller: (withDeep ? { run, runDeep } : { run }) as never,
        ...(minutes === undefined ? {} : { healthDeepEveryMinutes: minutes }),
      });
      return { worker, run, runDeep };
    };
    const redis = new RedisClient(url);
    const names: string[] = [];
    const cleanup = async () => {
      for (const name of names) {
        const keys = await redis.keys(`bull:${name}:*`);
        if (keys.length) await redis.del(...keys);
      }
      await redis.quit();
    };
    try {
      const on = `it-deep-${randomUUID()}`;
      names.push(on);
      const a = await make(on, 60);
      // BullMQ fires an `every` scheduler at once and we add a boot job: a second look right after the
      // first is harmless (same findings, same day: silent), and a restart is covered even when the
      // scheduler already exists.
      await vi.waitFor(() => expect(a.runDeep.mock.calls.length).toBeGreaterThanOrEqual(1), {
        timeout: 8000,
      });
      expect(a.run).toHaveBeenCalledTimes(1);
      // the repeating scheduler exists with the configured interval (60 min), next to the 15-minute poll
      const every = await redis.zrange(`bull:${on}:repeat`, 0, -1);
      expect(every).toContain("health-deep-scheduler");
      expect(await redis.hget(`bull:${on}:repeat:health-deep-scheduler`, "every")).toBe("3600000");
      expect(await redis.hget(`bull:${on}:repeat:health-poll-every-15-minutes`, "pattern")).toBe(
        "0 */15 * * * *",
      );
      await a.worker.close();

      const off = `it-deep-off-${randomUUID()}`;
      names.push(off);
      const b = await make(off, 0);
      await vi.waitFor(() => expect(b.run).toHaveBeenCalledTimes(1), { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 500));
      expect(b.runDeep).not.toHaveBeenCalled();
      expect(await redis.zrange(`bull:${off}:repeat`, 0, -1)).not.toContain(
        "health-deep-scheduler",
      );
      await b.worker.close();
    } finally {
      await cleanup();
    }
  }, 30_000);
});
