import { randomUUID } from "node:crypto";
import { buildServer, createBullQueue, sign } from "@incidentpulse/intake";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, test, vi } from "vitest";
import { buildIncidentGraph } from "../src/graph.ts";
import { createLogger } from "../src/log.ts";
import { runIncident } from "../src/run.ts";
import { createIncidentWorker } from "../src/worker.ts";
import { job, makeMocks } from "./helpers.ts";

// Real services (docker compose up -d):
//   IT_DATABASE_URL=postgres://incidentpulse:incidentpulse_dev@127.0.0.1:5432/incidentpulse
//   IT_REDIS_URL=redis://:incidentpulse_dev@127.0.0.1:6379
const dbUrl = process.env.IT_DATABASE_URL;
const redisUrl = process.env.IT_REDIS_URL;

describe.skipIf(!dbUrl)("PostgresSaver checkpointer (real Postgres)", () => {
  test("a finished incident is persisted and a fresh graph instance sees it as already done", async () => {
    const saver = PostgresSaver.fromConnString(dbUrl as string);
    await saver.setup();
    const m = makeMocks();
    m.deps.checkpointer = saver;
    const id = `inc-it-${randomUUID()}`;

    const first = await runIncident(buildIncidentGraph(m.deps), job({ incidentId: id }));
    expect(first.mode).toBe("completed");

    // "Restart": brand-new graph object, same Postgres.
    const second = await runIncident(buildIncidentGraph(m.deps), job({ incidentId: id }));
    expect(second.mode).toBe("already_done");
    expect(second.state.costUsd).toBeCloseTo(first.state.costUsd, 9);
    expect(m.specialists.infra.calls).toBe(1);
    expect(m.notifier.sent).toHaveLength(1);
    await saver.end();
  });

  test("a crash mid-graph resumes from the Postgres checkpoint after a restart", async () => {
    const saver = PostgresSaver.fromConnString(dbUrl as string);
    await saver.setup();
    const m = makeMocks({ synth: { failTimes: 1 } });
    m.deps.checkpointer = saver;
    const id = `inc-it-${randomUUID()}`;

    await expect(
      runIncident(buildIncidentGraph(m.deps), job({ incidentId: id })),
    ).rejects.toThrow();
    const resumed = await runIncident(buildIncidentGraph(m.deps), job({ incidentId: id }));

    expect(resumed.mode).toBe("resumed");
    expect(m.specialists.infra.calls).toBe(1);
    expect(m.notifier.sent).toHaveLength(1);
    await saver.end();
  });
});

describe.skipIf(!dbUrl || !redisUrl)(
  "end to end: signed webhook → intake → BullMQ → worker → graph → Telegram (mocked LLM/Telegram)",
  () => {
    const queueName = `it-e2e-${randomUUID()}`;
    const secret = "e".repeat(64);
    const cleanup: Array<() => Promise<void>> = [];

    afterAll(async () => {
      for (const fn of cleanup.reverse()) await fn();
      const conn = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
      const q = new Queue(queueName, { connection: conn });
      await q.obliterate({ force: true });
      await q.close();
      conn.disconnect();
    });

    test("one signed Down signal produces exactly one Telegram report; a repeat is deduplicated", async () => {
      const saver = PostgresSaver.fromConnString(dbUrl as string);
      await saver.setup();
      cleanup.push(() => saver.end());

      const m = makeMocks();
      m.deps.checkpointer = saver;
      const lines: string[] = [];
      const worker = createIncidentWorker({
        redisUrl: redisUrl as string,
        graph: buildIncidentGraph(m.deps),
        notifier: m.notifier,
        redact: m.deps.redact,
        log: createLogger(
          (t) => t,
          (l) => lines.push(l),
        ),
        queueName,
      });
      cleanup.push(() => worker.close());

      const queue = createBullQueue({
        redisUrl: redisUrl as string,
        dedupTtlMs: 60_000,
        queueName,
      });
      cleanup.push(() => queue.close());
      const app = buildServer({ secret, queue });
      cleanup.push(() => app.close());

      const body = JSON.stringify({
        project: "kervan",
        check: "https",
        level: "down",
        summary: "HTTPS check failed",
        at: new Date().toISOString(),
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers = {
        "content-type": "application/json",
        "x-incidentpulse-timestamp": timestamp,
        "x-incidentpulse-signature": sign(secret, timestamp, body),
      };

      const first = await app.inject({
        method: "POST",
        url: "/webhook/monitor",
        headers,
        payload: body,
      });
      expect(first.statusCode).toBe(202);
      expect(first.json().status).toBe("queued");

      await vi.waitFor(() => expect(m.notifier.sent).toHaveLength(1), {
        timeout: 15_000,
        interval: 100,
      });
      expect(m.notifier.sent[0]).toContain(`incident #${first.json().incidentId}`);
      expect(m.notifier.sent[0]).toContain("Kervan");

      const second = await app.inject({
        method: "POST",
        url: "/webhook/monitor",
        headers,
        payload: body,
      });
      expect(second.json()).toEqual({ status: "duplicate", incidentId: first.json().incidentId });
      await new Promise((r) => setTimeout(r, 500));
      expect(m.notifier.sent).toHaveLength(1);
      expect(lines.some((l) => l.includes("incident finished"))).toBe(true);
    }, 30_000);
  },
);
