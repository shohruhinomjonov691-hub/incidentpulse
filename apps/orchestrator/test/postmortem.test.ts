import { randomBytes } from "node:crypto";
import { createRedactor } from "@incidentpulse/redact";
import type { IncidentState } from "@incidentpulse/schemas";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createJournal, type IncidentRow, type Journal } from "../src/journal.ts";
import { createPostmortemWorker, postmortemLink } from "../src/postmortem.ts";

const state = {
  incidentId: "inc-1",
  project: "kervan",
  signal: { check: "https", level: "down", summary: "down", at: "2026-11-21T09:00:00.000Z" },
  category: "tls",
  evidence: [
    {
      id: "E1",
      source: "x",
      tool: "tls_inspect",
      excerpt: "expired",
      at: "2026-11-21T09:00:01.000Z",
      hash: "h",
    },
  ],
  hypotheses: [{ id: "h1", cause: "expired cert", supportingEvidenceIds: ["E1"], confidence: 0.9 }],
  iteration: 0,
  costUsd: 0.01,
} satisfies Record<string, unknown> as unknown as IncidentState;

describe("postmortemLink", () => {
  test("only builds links for https or loopback http origins", () => {
    expect(postmortemLink("https://ops.example.com", "a-1")).toBe(
      "https://ops.example.com/postmortems/a-1",
    );
    expect(postmortemLink("http://127.0.0.1:3000", "a-1")).toBe(
      "http://127.0.0.1:3000/postmortems/a-1",
    );
    expect(postmortemLink("http://ops.example.com", "a-1")).toBeUndefined();
    expect(postmortemLink("https://u:p@ops.example.com", "a-1")).toBeUndefined();
    expect(postmortemLink("https://ops.example.com/path", "a-1")).toBeUndefined();
    expect(postmortemLink("https://ops.example.com", "../x")).toBeUndefined();
    expect(postmortemLink(undefined, "a-1")).toBeUndefined();
  });
});

function fakeJournal(status: IncidentRow["status"]) {
  const finished: unknown[] = [];
  const appended: unknown[] = [];
  const journal = {
    pending: async () => ["inc-1"],
    get: async () => ({ id: "inc-1", project: "kervan", status, state }),
    events: async () => [{ id: "1", type: "recovery", at: "2026-11-21T09:05:00.000Z", data: {} }],
    claimPostmortem: async () => true,
    finishPostmortem: async (...args: unknown[]) => void finished.push(args),
    append: async (input: unknown) => void appended.push(input),
  } as unknown as Journal;
  return { journal, finished, appended };
}

describe("postmortem worker", () => {
  const redact = createRedactor({ secrets: ["sk-secret-value-123"] });
  const secret = "s".repeat(32);

  test("stores redacted markdown, charges the measured cost and releases the rest", async () => {
    const { journal, finished, appended } = fakeJournal("recovered");
    const release = vi.fn(async () => undefined);
    const fetcher = vi.fn(async (url: string | Request | URL, _init?: RequestInit) =>
      String(url).endsWith("/ready")
        ? Response.json({ status: "ready" })
        : Response.json({ markdown: "## Timeline\nkey sk-secret-value-123", micro: 4000 }),
    );
    await createPostmortemWorker({
      journal,
      url: "http://127.0.0.1:9",
      secret,
      redact,
      reserve: async () => true,
      release,
      fetcher,
    })();
    expect(finished).toHaveLength(1);
    const [, micro, markdown] = finished[0] as [string, number, string];
    expect(micro).toBe(4000);
    expect(markdown).toContain("## Timeline");
    expect(markdown).not.toContain("sk-secret-value-123");
    expect(release).toHaveBeenCalledWith(expect.any(Date), 0.01 - 0.004);
    expect(appended).toHaveLength(1);
    const init = fetcher.mock.calls[1]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body.status).toBe("recovered");
  });

  test("a failing service leaves the postmortem pending without throwing", async () => {
    const { journal, finished, appended } = fakeJournal("recovered");
    const fetcher = vi.fn(async (url: string | Request | URL, _init?: RequestInit) =>
      String(url).endsWith("/ready") ? Response.json({}) : new Response("boom", { status: 500 }),
    );
    await createPostmortemWorker({
      journal,
      url: "http://127.0.0.1:9",
      secret,
      redact,
      reserve: async () => true,
      release: async () => undefined,
      fetcher,
    })();
    expect((finished[0] as unknown[])[2]).toBeUndefined();
    expect(appended).toHaveLength(0);
  });

  test("does nothing while the service is not ready, and skips open incidents", async () => {
    const a = fakeJournal("recovered");
    const down = vi.fn(async () => new Response(null, { status: 503 }));
    await createPostmortemWorker({
      journal: a.journal,
      url: "http://127.0.0.1:9",
      secret,
      redact,
      reserve: async () => true,
      release: async () => undefined,
      fetcher: down,
    })();
    expect(down).toHaveBeenCalledTimes(1);
    expect(a.finished).toHaveLength(0);
    const b = fakeJournal("investigating");
    const ok = vi.fn(async () => Response.json({}));
    await createPostmortemWorker({
      journal: b.journal,
      url: "http://127.0.0.1:9",
      secret,
      redact,
      reserve: async () => true,
      release: async () => undefined,
      fetcher: ok,
    })();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(b.finished).toHaveLength(0);
  });

  test("does not call the service when the weekly budget is exhausted", async () => {
    const { journal, finished } = fakeJournal("escalated");
    const fetcher = vi.fn(async () => Response.json({}));
    await createPostmortemWorker({
      journal,
      url: "http://127.0.0.1:9",
      secret,
      redact,
      reserve: async () => false,
      release: async () => undefined,
      fetcher,
    })();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(finished).toHaveLength(0);
  });
});

const url = process.env.IT_DATABASE_URL;
describe.skipIf(!url)("journal (Postgres)", () => {
  const schema = `ipj${randomBytes(4).toString("hex")}`;
  let admin: Pool;
  let pool: Pool;
  let journal: Journal;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url as string);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    pool = new Pool({ connectionString: scoped.href });
    journal = createJournal(pool);
    await journal.setup();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const at = (s: number) => new Date(Date.UTC(2026, 10, 21, 9, 0, s)).toISOString();

  test("streams events in order and creates exactly one postmortem row for a recovered incident", async () => {
    await journal.append({
      id: "inc-1",
      project: "kervan",
      events: [{ type: "node_start", at: at(0), data: { node: "intake" } }],
    });
    await journal.append({
      id: "inc-1",
      project: "kervan",
      events: [{ type: "recovery", at: at(9), data: { ok: true } }],
      snapshot: {
        state: state,
        status: "recovered",
      },
    });
    const events = await journal.events("inc-1");
    expect(events.map((e) => e.type)).toEqual(["node_start", "recovery"]);
    expect(await journal.events("inc-1", events[0]?.id)).toHaveLength(1);
    const row = await journal.get("inc-1");
    expect(row?.status).toBe("recovered");
    expect(row?.closed_at).not.toBeNull();
    expect(await journal.pending()).toEqual(["inc-1"]);
    expect(await journal.claimPostmortem("inc-1")).toBe(true);
    expect(await journal.claimPostmortem("inc-1")).toBe(false);
    expect(await journal.pending()).toEqual([]);
    await journal.finishPostmortem("inc-1", 4000, "# done");
    await journal.finishPostmortem("inc-1", 9999, "# overwritten");
    expect(await journal.postmortem("inc-1")).toEqual({ markdown: "# done", micro: 4000 });
    expect((await journal.get("inc-1"))?.cost).toBeCloseTo(0.01 + 0.004, 6);
  });

  test("a closed incident is not reopened by later snapshots, and chat is capped at 10 questions", async () => {
    await journal.append({
      id: "inc-1",
      project: "kervan",
      events: [],
      snapshot: { state: state, status: "investigating" },
    });
    expect((await journal.get("inc-1"))?.status).toBe("recovered");
    const taken = [];
    for (let i = 0; i < 12; i++) taken.push(await journal.takeQuestion("inc-1"));
    expect(taken.filter(Boolean)).toHaveLength(10);
  });

  test("an incident without state cannot be questioned", async () => {
    await journal.append({
      id: "inc-2",
      project: "kervan",
      events: [{ type: "node_start", at: at(1), data: {} }],
    });
    expect(await journal.takeQuestion("inc-2")).toBe(false);
    expect(await journal.pending()).toEqual([]);
  });
});
