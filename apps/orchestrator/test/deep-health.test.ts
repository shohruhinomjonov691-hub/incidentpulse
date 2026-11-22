import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { KNOWN_PRICING } from "@incidentpulse/config";
import { loadRunbookRegistry } from "@incidentpulse/mcp-actions";
import type { HttpProbeResult } from "@incidentpulse/mcp-infra";
import { createRedactor } from "@incidentpulse/redact";
import type { IncidentJob, ProjectId } from "@incidentpulse/schemas";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createDeepChecker,
  DEEP_LIMITS,
  fetchText,
  scanHtml,
  scanScript,
} from "../src/deep-health.ts";
import { buildIncidentGraph } from "../src/graph.ts";
import { createHealthPoller, effectiveLevel } from "../src/health-poller.ts";
import { createRemediationProposer } from "../src/remediation-proposer.ts";
import { formatDegraded, formatDegradedRecovered } from "../src/report.ts";
import { runIncident } from "../src/run.ts";
import { job, makeMocks } from "./helpers.ts";
import { finalText, ScriptedModel } from "./scripted-model.ts";

const PAGE = "https://kervan.uz/";
const NO_DOMAINS = { gotrip: [], "camera-studio": [], codetrail: [], findit: [], "food-lens": [] };
const ALLOWED = { ...NO_DOMAINS, kervan: ["kervan.uz"] } as Record<ProjectId, string[]>;

// ------------------------------------------------------------------------------- html scanning

describe("scanHtml", () => {
  test("finds http:// in <script src>, <link href> and <img src>, resolved against the page", () => {
    const html = `
      <link rel="stylesheet" href="http://cdn.example.com/a.css">
      <script src='http://kervan.uz:3003/app.js'></script>
      <img alt=x src=http://img.example.com/logo.png>
      <script src="/static/js/main.abc.js"></script>
      <script src="https://cdn.example.com/lib.js"></script>
      <link rel="icon" href="//kervan.uz/favicon.ico">
      <img src="/relative.png"><img data-src="http://lazy.example.com/x.png">
    `;
    const scan = scanHtml(html, PAGE);
    expect(scan.insecure).toEqual([
      { url: "http://cdn.example.com/a.css", tag: "<link href>" },
      { url: "http://kervan.uz:3003/app.js", tag: "<script src>" },
      { url: "http://img.example.com/logo.png", tag: "<img src>" },
    ]);
    expect(scan.scripts).toEqual([
      "http://kervan.uz:3003/app.js",
      "https://kervan.uz/static/js/main.abc.js",
      "https://cdn.example.com/lib.js",
    ]);
  });

  test("ignores comments, inline script bodies, namespaces and links that load nothing", () => {
    const html = `
      <!-- <script src="http://kervan.uz:3003/old.js"></script> -->
      <script>var tpl = '<img src="http://kervan.uz/inline.png">';</script>
      <link rel="canonical" href="http://kervan.uz/">
      <link rel="alternate" hreflang="uz" href="http://kervan.uz/uz">
      <link rel="dns-prefetch preconnect" href="http://fonts.example.com">
      <img src="http://www.w3.org/2000/svg">
      <link rel="stylesheet" href="http://kervan.uz/late.css">
    `;
    expect(scanHtml(html, PAGE).insecure.map((i) => i.url)).toEqual(["http://kervan.uz/late.css"]);
  });

  test("decodes &amp; and survives garbage", () => {
    expect(
      scanHtml('<img src="http://a.example/x?a=1&amp;b=2"><img src="http://[bad">', PAGE).insecure,
    ).toEqual([{ url: "http://a.example/x?a=1&b=2", tag: "<img src>" }]);
  });
});

// ------------------------------------------------------------------------------ script scanning

describe("scanScript", () => {
  const firstParty = (host: string) =>
    host === "kervan.uz" || host.endsWith(".kervan.uz") || host === "203.0.113.7";

  test("finds http:// and ws:// URLs that point at the project or its server IP", () => {
    const js = `
      const API=process.env.REACT_APP_API_URL||"http://kervan.uz:3003";
      const sock=io('ws://kervan.uz:3003/socket.io');
      fetch(\`http://api.kervan.uz/v1/\${id}\`);
      axios.get("http://203.0.113.7:3003/api/dishes?x=1");
    `;
    expect(scanScript(js, firstParty).sort()).toEqual([
      "http://203.0.113.7:3003/api/dishes?x=1",
      "http://api.kervan.uz/v1/",
      "http://kervan.uz:3003/",
      "ws://kervan.uz:3003/socket.io",
    ]);
  });

  test("ignores foreign hosts, standard namespaces and secure URLs", () => {
    const js = `
      "http://www.w3.org/2000/svg"; "http://www.w3.org/1999/xlink";
      "http://schemas.xmlsoap.org/soap/envelope/"; "http://cdn.example.com/x.js";
      "https://kervan.uz:8443/api"; "wss://kervan.uz:8443/socket.io"; "http://notkervan.uz/";
    `;
    expect(scanScript(js, firstParty)).toEqual([]);
  });

  test("a bare scheme or an invalid URL is not a finding", () => {
    expect(scanScript('"http://" + host; "ws://[bad"', firstParty)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------- fetching

describe("fetchText (real sockets)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise((r) => server?.close(r));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1]) {
    server = createServer(handler);
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}`, allowedHosts: [`127.0.0.1:${port}`], port };
  }

  test("reads a small body", async () => {
    const s = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>hi</p>");
    });
    expect(
      await fetchText(`${s.url}/`, {
        allowedHosts: s.allowedHosts,
        maxBytes: 1000,
        timeoutMs: 2000,
      }),
    ).toMatchObject({
      status: 200,
      body: "<p>hi</p>",
      bytes: 9,
      contentType: "text/html",
    });
  });

  test("a declared size over the cap is skipped without reading it", async () => {
    const s = await listen((_req, res) => {
      res.writeHead(200, { "content-length": "5000" });
      res.write("x".repeat(100));
      // the body is never finished: the cap must not wait for it
    });
    const r = await fetchText(`${s.url}/`, {
      allowedHosts: s.allowedHosts,
      maxBytes: 1000,
      timeoutMs: 2000,
    });
    expect(r).toMatchObject({ status: 200, tooLarge: true });
    expect(r.body).toBeUndefined();
  });

  test("a chunked body that grows past the cap stops at the cap", async () => {
    const s = await listen((_req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write("y".repeat(400)), 5);
      res.on("close", () => clearInterval(timer));
    });
    const r = await fetchText(`${s.url}/`, {
      allowedHosts: s.allowedHosts,
      maxBytes: 1000,
      timeoutMs: 3000,
    });
    expect(r).toMatchObject({ status: 200, tooLarge: true });
  });

  test("a server that never answers times out", async () => {
    const s = await listen(() => undefined);
    const started = Date.now();
    const r = await fetchText(`${s.url}/`, {
      allowedHosts: s.allowedHosts,
      maxBytes: 1000,
      timeoutMs: 150,
    });
    expect(r).toEqual({ error: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a server that stalls mid-body times out too", async () => {
    const s = await listen((_req, res) => {
      res.writeHead(200);
      res.write("start");
    });
    const r = await fetchText(`${s.url}/`, {
      allowedHosts: s.allowedHosts,
      maxBytes: 1000,
      timeoutMs: 150,
    });
    expect(r).toEqual({ error: "ETIMEDOUT" });
  });

  test("redirects are followed inside the allowlist and refused outside it", async () => {
    const s = await listen((req, res) => {
      if (req.url === "/a") {
        res.writeHead(302, { location: "/b" });
        return res.end();
      }
      if (req.url === "/out") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        return res.end();
      }
      res.writeHead(200);
      res.end("b");
    });
    const options = { allowedHosts: s.allowedHosts, maxBytes: 1000, timeoutMs: 2000 };
    expect(await fetchText(`${s.url}/a`, options)).toMatchObject({
      status: 200,
      body: "b",
      finalUrl: `${s.url}/b`,
    });
    expect(await fetchText(`${s.url}/out`, options)).toEqual({ error: "HOST_NOT_ALLOWED" });
  });

  test("a host outside the allowlist, a bad URL and credentials are refused before any request", async () => {
    const fetchImpl = vi.fn();
    const options = {
      allowedHosts: ["kervan.uz"],
      maxBytes: 10,
      timeoutMs: 100,
      fetchImpl: fetchImpl as never,
    };
    expect((await fetchText("https://evil.example/", options)).error).toBe("HOST_NOT_ALLOWED");
    expect((await fetchText("https://kervan.uz:8443/", options)).error).toBe("HOST_NOT_ALLOWED");
    expect((await fetchText("https://u:p@kervan.uz/", options)).error).toBe("UNSUPPORTED_URL");
    expect((await fetchText("nope", options)).error).toBe("INVALID_URL");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------------- checker

type Route = {
  status?: number;
  type?: string;
  body?: string | Error;
  headers?: Record<string, string>;
};

function site(routes: Record<string, Route>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    if (route.body instanceof Error) throw route.body;
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: { "content-type": route.type ?? "text/html", ...route.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

const html = (...scripts: string[]) =>
  `<!doctype html><html><head>${scripts.map((s) => `<script src="${s}"></script>`).join("")}</head><body><div id=root></div></body></html>`;

function checker(
  routes: Record<string, Route>,
  over: Partial<Parameters<typeof createDeepChecker>[0]> = {},
) {
  const s = site(routes);
  return {
    ...s,
    deep: createDeepChecker({
      allowedHosts: ALLOWED,
      apis: {},
      fetchImpl: s.fetchImpl,
      resolveIps: async () => ["203.0.113.7"],
      sleep: async () => undefined,
      confirmDelayMs: 0,
      ...over,
    }),
  };
}

describe("deep checker: mixed content", () => {
  test("the Kervan case: an https page whose bundle calls http://kervan.uz:3003 and ws://", async () => {
    const { deep, requested } = checker({
      [PAGE]: { body: html("/static/js/main.1a2b.js", "https://cdn.example.com/analytics.js") },
      "https://kervan.uz/static/js/main.1a2b.js": {
        type: "application/javascript",
        body: `const a="http://kervan.uz:3003",b="ws://kervan.uz:3003",c="http://www.w3.org/2000/svg";`,
      },
    });
    const result = await deep.check("kervan", [PAGE]);
    expect(result.complete).toBe(true);
    expect(result.findings).toEqual([
      {
        category: "mixed_content",
        url: "http://kervan.uz:3003/",
        file: "https://kervan.uz/static/js/main.1a2b.js",
        detail: "script",
      },
      {
        category: "mixed_content",
        url: "ws://kervan.uz:3003/",
        file: "https://kervan.uz/static/js/main.1a2b.js",
        detail: "script",
      },
    ]);
    // a foreign CDN script is neither downloaded nor judged
    expect(requested).not.toContain("https://cdn.example.com/analytics.js");
  });

  test("the server's IP counts as the project, an unrelated host does not", async () => {
    const { deep } = checker({
      [PAGE]: { body: html("/m.js") },
      "https://kervan.uz/m.js": {
        body: `"http://203.0.113.7:3003/api"; "http://198.51.100.9/x"; "http://elsewhere.example/"`,
      },
    });
    const { findings } = await deep.check("kervan", [PAGE]);
    expect(findings.map((f) => f.url)).toEqual(["http://203.0.113.7:3003/api"]);
  });

  test("http:// resources in the HTML itself are reported with the tag and the page", async () => {
    const { deep } = checker({
      [PAGE]: {
        body: `<img src="http://kervan.uz/logo.png"><link rel="stylesheet" href="https://kervan.uz/ok.css">`,
      },
    });
    expect((await deep.check("kervan", [PAGE])).findings).toEqual([
      {
        category: "mixed_content",
        url: "http://kervan.uz/logo.png",
        file: PAGE,
        detail: "<img src>",
      },
    ]);
  });

  test("a healthy page is complete with no findings", async () => {
    const { deep } = checker({
      [PAGE]: { body: html("/main.js") },
      "https://kervan.uz/main.js": {
        body: `const a="https://kervan.uz:8443";const b="wss://kervan.uz:8443";`,
      },
    });
    expect(await deep.check("kervan", [PAGE])).toMatchObject({ findings: [], complete: true });
  });

  test("a page that is not https has nothing to mix, and a non-HTML answer has nothing to scan", async () => {
    const plain = checker({ "http://kervan.uz/": { body: `<img src="http://kervan.uz/x.png">` } });
    expect(await plain.deep.check("kervan", ["http://kervan.uz/"])).toMatchObject({
      findings: [],
      complete: true,
    });
    const json = checker({
      [PAGE]: { type: "application/json", body: `{"a":"http://kervan.uz:3003"}` },
    });
    expect(await json.deep.check("kervan", [PAGE])).toMatchObject({ findings: [], complete: true });
  });

  test("a page that cannot be fetched is not 'healthy': complete=false", async () => {
    for (const route of [{ body: new Error("boom") }, { status: 503 }] as Route[]) {
      const { deep } = checker({ [PAGE]: route });
      const result = await deep.check("kervan", [PAGE]);
      expect(result.findings).toEqual([]);
      expect(result.complete).toBe(false);
      expect(result.notes[0]).toContain("kervan.uz");
    }
  });

  test("a bundle that cannot be fetched makes the verdict incomplete, a 404 does not", async () => {
    const down = checker({
      [PAGE]: { body: html("/a.js") },
      "https://kervan.uz/a.js": { status: 502 },
    });
    expect((await down.deep.check("kervan", [PAGE])).complete).toBe(false);
    const gone = checker({ [PAGE]: { body: html("/a.js") } });
    expect((await gone.deep.check("kervan", [PAGE])).complete).toBe(true);
  });

  test("each bundle is capped at 5 MB: a bigger one is skipped, not an error", async () => {
    const big = "x".repeat(DEEP_LIMITS.bundleBytes + 1);
    const { deep } = checker({
      [PAGE]: { body: html("/big.js", "/small.js") },
      "https://kervan.uz/big.js": { body: `${big}"http://kervan.uz:3003"` },
      "https://kervan.uz/small.js": { body: `"http://kervan.uz:3003"` },
    });
    const result = await deep.check("kervan", [PAGE]);
    expect(result.complete).toBe(true);
    expect(result.findings.map((f) => f.file)).toEqual(["https://kervan.uz/small.js"]);
    expect(result.notes.join("\n")).toMatch(/big\.js.*size limit/);
  });

  test("all bundles together are capped at 10 MB", async () => {
    const chunk = "z".repeat(4 * 1024 * 1024);
    const routes: Record<string, Route> = {
      [PAGE]: { body: html("/1.js", "/2.js", "/3.js", "/4.js") },
    };
    for (const n of [1, 2, 3, 4]) routes[`https://kervan.uz/${n}.js`] = { body: `${chunk}` };
    const { deep, requested } = checker(routes);
    const result = await deep.check("kervan", [PAGE]);
    // 4 MB + 4 MB fit; the third has only 2 MB of budget left and is skipped, the fourth too
    expect(
      result.notes.filter((n) => /size limit|limit reached/.test(n)).length,
    ).toBeGreaterThanOrEqual(1);
    expect(requested.filter((u) => u.endsWith(".js")).length).toBeLessThanOrEqual(4);
  });

  test("at most 20 bundles per run, and a bundle shared by two pages is fetched once", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `/b${i}.js`);
    const a = checker({ [PAGE]: { body: html(...many) } });
    await a.deep.check("kervan", [PAGE]);
    expect(a.requested.filter((u) => u.endsWith(".js"))).toHaveLength(DEEP_LIMITS.bundlesPerRun);

    const allowed = { ...ALLOWED, kervan: ["kervan.uz", "www.kervan.uz"] };
    const b = checker(
      {
        [PAGE]: { body: html("/shared.js") },
        "https://www.kervan.uz/": { body: html("https://kervan.uz/shared.js") },
        "https://kervan.uz/shared.js": { body: `"http://kervan.uz:3003"` },
      },
      { allowedHosts: allowed },
    );
    const result = await b.deep.check("kervan", [PAGE, "https://www.kervan.uz/"]);
    expect(b.requested.filter((u) => u.endsWith("shared.js"))).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
  });

  test("hostile text in a bundle cannot smuggle control characters into the message", async () => {
    const { deep } = checker({
      [PAGE]: { body: html("/m.js") },
      "https://kervan.uz/m.js": { body: `"http://kervan.uz/‮evil\u0007\n"` },
    });
    for (const f of (await deep.check("kervan", [PAGE])).findings) {
      expect(f.url).toMatch(/^[\x21-\x7e]+$/);
    }
  });
});

describe("deep checker: API", () => {
  const apis = { kervan: { api: ["https://kervan.uz:8443/api/dishes"], expect: [200, 401] } };
  const probeOf = (...results: Array<Partial<HttpProbeResult>>) => {
    const queue = [...results];
    return vi.fn(
      async (url: string): Promise<HttpProbeResult> => ({
        url,
        completed: true,
        status: 200,
        redirects: [],
        latencyMs: 3,
        ...(queue.shift() ?? {}),
      }),
    );
  };
  const make = (probe: ReturnType<typeof probeOf>) =>
    checker({ [PAGE]: { body: html() } }, { apis, probe }).deep;

  test("a status in the expected list is healthy, 401 included", async () => {
    for (const status of [200, 401]) {
      const probe = probeOf({ status });
      expect((await make(probe).check("kervan", [PAGE])).findings).toEqual([]);
      expect(probe).toHaveBeenCalledTimes(1);
    }
  });

  test("scenario 16: a 502 is api_down, confirmed once before it counts", async () => {
    const probe = probeOf({ status: 502 }, { status: 502 });
    const result = await make(probe).check("kervan", [PAGE]);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.findings).toEqual([
      {
        category: "api_down",
        url: "https://kervan.uz:8443/api/dishes",
        detail: "HTTP 502 (kutilgan: 200, 401)",
      },
    ]);
  });

  test("a blip that clears on the second look is not a finding", async () => {
    const probe = probeOf({ status: 503 }, { status: 200 });
    expect((await make(probe).check("kervan", [PAGE])).findings).toEqual([]);
  });

  test("a connection error is api_down", async () => {
    const probe = probeOf(
      { completed: false, status: undefined, error: "ECONNREFUSED" },
      { completed: false, status: undefined, error: "ECONNREFUSED" },
    );
    expect((await make(probe).check("kervan", [PAGE])).findings[0]).toMatchObject({
      category: "api_down",
      detail: "ECONNREFUSED",
    });
  });

  test("the probe may reach the API's own port and nothing else outside the domains", async () => {
    const probe = probeOf();
    await make(probe).check("kervan", [PAGE]);
    const [, options] = probe.mock.calls[0] as unknown as [string, { allowedHosts: string[] }];
    expect(options.allowedHosts).toEqual(["kervan.uz", "kervan.uz:8443"]);
  });

  test("no api configured: only the mixed-content check runs and the probe is never called", async () => {
    const probe = probeOf();
    const { deep } = checker({ [PAGE]: { body: html() } }, { probe });
    expect((await deep.check("kervan", [PAGE])).findings).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  test("an API failure and mixed content are reported together", async () => {
    const probe = probeOf({ status: 500 }, { status: 500 });
    const { deep } = checker(
      { [PAGE]: { body: `<img src="http://kervan.uz/a.png">` } },
      { apis, probe },
    );
    expect((await deep.check("kervan", [PAGE])).findings.map((f) => f.category)).toEqual([
      "mixed_content",
      "api_down",
    ]);
  });
});

// ------------------------------------------------------------------------------------- messages

describe("Degraded messages (LLM-free, Uzbek)", () => {
  test("name the URL and the file, propose nothing, carry no buttons", () => {
    const text = formatDegraded({
      project: "kervan",
      reminder: false,
      findings: [
        {
          category: "mixed_content",
          url: "http://kervan.uz:3003/",
          file: "https://kervan.uz/static/js/main.js",
          detail: "script",
        },
        {
          category: "mixed_content",
          url: "http://cdn.example.com/a.css",
          file: PAGE,
          detail: "<link href>",
        },
        {
          category: "api_down",
          url: "https://kervan.uz:8443/api/dishes",
          detail: "HTTP 502 (kutilgan: 200, 401)",
        },
      ],
    });
    expect(text).toContain("🟠 Kervan — Degraded (mixed_content, api_down)");
    expect(text).toContain("• http://kervan.uz:3003/ — fayl: https://kervan.uz/static/js/main.js");
    expect(text).toContain(
      "• http://cdn.example.com/a.css — fayl: https://kervan.uz/ (<link href>)",
    );
    expect(text).toContain("• https://kervan.uz:8443/api/dishes — HTTP 502 (kutilgan: 200, 401)");
    expect(text).toContain("Taklif: yo'q");
    expect(text.split("\n").length).toBeLessThanOrEqual(12);
  });

  test("a long list is cut, a reminder says so, recovery is one line", () => {
    const findings = Array.from({ length: 9 }, (_, i) => ({
      category: "mixed_content" as const,
      url: `http://kervan.uz/${i}`,
      file: PAGE,
    }));
    const text = formatDegraded({ project: "kervan", findings, reminder: true });
    expect(text).toContain("Degraded (davom etmoqda) (mixed_content)");
    expect(text).toContain("… yana 4 ta");
    expect(formatDegradedRecovered("kervan")).toMatch(/^🟢 Kervan — Degraded tugadi/);
  });
});

// ------------------------------------------------------------------------------------- poller

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

const mixed = (url = "http://kervan.uz:3003/", file = "https://kervan.uz/static/js/main.js") => ({
  category: "mixed_content" as const,
  url,
  file,
  detail: "script",
});
const apiDown = {
  category: "api_down" as const,
  url: "https://kervan.uz:8443/x",
  detail: "HTTP 502",
};

function deepPoller() {
  const clock = { at: new Date("2026-11-21T10:00:00Z") }; // 19:00 in Seoul
  const next = {
    findings: [] as ReturnType<typeof mixed>[] | Array<ReturnType<typeof mixed> | typeof apiDown>,
    complete: true,
  };
  const check = vi.fn(async () => ({
    findings: next.findings,
    complete: next.complete,
    notes: [] as string[],
  }));
  const shallow = { status: 200, completed: true };
  const notifier = { send: vi.fn(async (_text: string) => ({ messageId: 1 })) };
  const monitor = vi.fn(async (_job: IncidentJob) => "investigated");
  const poller = createHealthPoller({
    redis: fakeRedis(),
    targets: { kervan: [PAGE] },
    allowedHosts: ALLOWED,
    notifier,
    redact: createRedactor(),
    monitor,
    probe: async () => ({ url: PAGE, redirects: [], latencyMs: 1, ...shallow }) as HttpProbeResult,
    now: () => clock.at,
    sleep: async () => undefined,
    confirmDelayMs: 0,
    deep: { check },
  });
  return {
    poller,
    notifier,
    monitor,
    check,
    shallow,
    next,
    advanceMinutes: (m: number) => {
      clock.at = new Date(clock.at.getTime() + m * 60_000);
    },
    texts: () => notifier.send.mock.calls.map((c) => c[0]),
  };
}

describe("deep health in the poller (no LLM)", () => {
  test("a healthy deep check says nothing and never touches the investigation policy", async () => {
    const f = deepPoller();
    await f.poller.runDeep();
    await f.poller.runDeep();
    expect(f.notifier.send).not.toHaveBeenCalled();
    expect(f.monitor).not.toHaveBeenCalled();
  });

  test("ok -> Degraded: one Telegram message naming the URL and the file, and no investigation", async () => {
    const f = deepPoller();
    f.next.findings = [mixed()];
    const result = await f.poller.runDeep();
    expect(result).toMatchObject({ checked: 1, degraded: 1 });
    expect(f.texts()).toHaveLength(1);
    expect(f.texts()[0]).toContain("Degraded (mixed_content)");
    expect(f.texts()[0]).toContain("http://kervan.uz:3003/");
    expect(f.texts()[0]).toContain("https://kervan.uz/static/js/main.js");
    // Degraded is not Down: no incident, no LLM, no proposal
    expect(f.monitor).not.toHaveBeenCalled();
  });

  test("on_change: an unchanged Degraded is silent within the day, then reminds once per Seoul day", async () => {
    const f = deepPoller();
    f.next.findings = [mixed()];
    await f.poller.runDeep(); // 19:00 Nov 21 (Seoul): the change
    for (let i = 0; i < 4; i++) {
      f.advanceMinutes(60); // 20:00 .. 23:00
      await f.poller.runDeep();
    }
    expect(f.texts()).toHaveLength(1);
    f.advanceMinutes(60); // 00:00 Nov 22 (Seoul): a new day
    await f.poller.runDeep();
    expect(f.texts()).toHaveLength(2);
    expect(f.texts()[1]).toContain("Degraded (davom etmoqda)");
    for (let i = 0; i < 23; i++) {
      f.advanceMinutes(60); // 01:00 .. 23:00 on Nov 22
      await f.poller.runDeep();
    }
    expect(f.texts()).toHaveLength(2);
    f.advanceMinutes(60);
    await f.poller.runDeep(); // Nov 23
    expect(f.texts()).toHaveLength(3);
  });

  test("changed evidence is a new message at once, even on the same day", async () => {
    const f = deepPoller();
    f.next.findings = [mixed()];
    await f.poller.runDeep();
    f.advanceMinutes(60);
    f.next.findings = [mixed(), apiDown];
    await f.poller.runDeep();
    expect(f.texts()).toHaveLength(2);
    expect(f.texts()[1]).toContain("Degraded (mixed_content, api_down)");
    expect(f.texts()[1]).not.toContain("davom etmoqda");
    f.advanceMinutes(60);
    await f.poller.runDeep(); // same set again: silent
    expect(f.texts()).toHaveLength(2);
  });

  test("the order of findings does not count as a change", async () => {
    const f = deepPoller();
    f.next.findings = [mixed("http://kervan.uz:3003/"), mixed("ws://kervan.uz:3003/")];
    await f.poller.runDeep();
    f.advanceMinutes(60);
    f.next.findings = [mixed("ws://kervan.uz:3003/"), mixed("http://kervan.uz:3003/")];
    await f.poller.runDeep();
    expect(f.texts()).toHaveLength(1);
  });

  test("Degraded -> ok sends one recovery message, then silence", async () => {
    const f = deepPoller();
    f.next.findings = [mixed()];
    await f.poller.runDeep();
    f.advanceMinutes(60);
    f.next.findings = [];
    await f.poller.runDeep();
    expect(f.texts()).toHaveLength(2);
    expect(f.texts()[1]).toMatch(/^🟢 Kervan — Degraded tugadi/);
    f.advanceMinutes(60);
    await f.poller.runDeep();
    expect(f.texts()).toHaveLength(2);
  });

  test("an incomplete look concludes nothing: no recovery, no new alert", async () => {
    const f = deepPoller();
    f.next.findings = [mixed()];
    await f.poller.runDeep();
    f.advanceMinutes(60);
    f.next.findings = [];
    f.next.complete = false;
    await f.poller.runDeep();
    expect(f.texts()).toHaveLength(1);
    // the next complete look still reports the recovery
    f.advanceMinutes(60);
    f.next.complete = true;
    await f.poller.runDeep();
    expect(f.texts()).toHaveLength(2);
  });

  test("a project that is Down is left to the plain poller", async () => {
    const f = deepPoller();
    f.shallow.status = 502;
    await f.poller.run(); // Down: the policy is told, deep is not asked
    f.next.findings = [mixed()];
    const result = await f.poller.runDeep();
    expect(f.check).not.toHaveBeenCalled();
    expect(result.checked).toBe(0);
    expect(f.monitor).toHaveBeenCalledTimes(1);
  });

  test("when a Down project comes back, the deep check runs at once (the TLS-then-mixed-content case)", async () => {
    const f = deepPoller();
    f.shallow.status = 502;
    await f.poller.run();
    f.shallow.status = 200;
    f.next.findings = [mixed()];
    f.advanceMinutes(15);
    await f.poller.run();
    const texts = f.texts();
    expect(texts[0]).toContain("qayta ishlayapti");
    expect(texts.at(-1)).toContain("Degraded (mixed_content)");
    expect(f.check).toHaveBeenCalledTimes(1);
  });

  test("a failure inside the deep check never breaks the plain poll", async () => {
    const f = deepPoller();
    f.shallow.status = 502;
    await f.poller.run();
    f.shallow.status = 200;
    f.check.mockRejectedValueOnce(new Error("deep boom"));
    f.advanceMinutes(15);
    await expect(f.poller.run()).resolves.toMatchObject({ checked: 1 });
    // the plain state was saved: the next run does not raise 'down -> ok' again
    f.advanceMinutes(15);
    const before = f.monitor.mock.calls.length;
    await f.poller.run();
    expect(f.monitor.mock.calls.length).toBe(before);
  });

  test("a failed Telegram send leaves the state unsaved so the next look retries it", async () => {
    const f = deepPoller();
    f.next.findings = [mixed()];
    f.notifier.send.mockRejectedValueOnce(new Error("telegram down"));
    await f.poller.runDeep(); // swallowed per project
    await f.poller.runDeep();
    expect(f.texts()).toHaveLength(2); // the failed attempt and the successful retry
    f.advanceMinutes(60);
    await f.poller.runDeep();
    expect(f.texts()).toHaveLength(2);
  });

  test("without a deep checker runDeep does nothing", async () => {
    const f = createHealthPoller({
      redis: fakeRedis(),
      targets: { kervan: [PAGE] },
      allowedHosts: ALLOWED,
      notifier: { send: async () => ({ messageId: 1 }) },
      redact: createRedactor(),
      monitor: async () => "x",
    });
    expect(await f.runDeep()).toEqual({ checked: 0, degraded: 0, levels: [] });
  });
});

describe("health levels", () => {
  test("Down beats Degraded beats ok", () => {
    expect(effectiveLevel("down", "degraded")).toBe("down");
    expect(effectiveLevel("down", "ok")).toBe("down");
    expect(effectiveLevel("ok", "degraded")).toBe("degraded");
    expect(effectiveLevel("ok", "ok")).toBe("ok");
  });
});

describe("no runbook for the deep categories", () => {
  test("a mixed_content or api_down incident always escalates: the proposer never asks the model", async () => {
    const registry = loadRunbookRegistry(
      {
        kervan: {
          domains: ["kervan.uz"],
          nginx: true,
          webroot: "/var/www/acme",
          www: false,
        },
      },
      undefined,
      { remote: true },
    );
    const m = makeMocks();
    const { state } = await runIncident(buildIncidentGraph(m.deps), job());
    for (const category of ["mixed_content", "api_down"] as const) {
      const model = new ScriptedModel([
        finalText(JSON.stringify({ runbookId: "docker_restart", params: [] })),
      ]);
      const propose = createRemediationProposer({
        registry,
        model,
        pricing: KNOWN_PRICING["gpt-5.4-mini"] as never,
        redact: createRedactor(),
        // the host facts alone would offer a runbook (no certificate): the category must still win
        inventory: async () => ({
          domains: [{ domain: "kervan.uz", vhost: true, certificate: false }],
          upstreams: [],
        }),
      });
      const result = await propose({ ...state, category });
      expect(result).toEqual({ costUsd: 0 });
      expect(model.requests).toHaveLength(0);
    }
  });
});
