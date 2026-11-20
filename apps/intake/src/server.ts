import { randomBytes } from "node:crypto";
import { dedupKey, type IncidentJob, MonitorWebhookSchema } from "@incidentpulse/schemas";
import Fastify, { type FastifyInstance } from "fastify";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "./signature.ts";

export interface IncidentQueue {
  enqueue(job: IncidentJob): Promise<{ incidentId: string; deduplicated: boolean }>;
}

export interface BuildServerOptions {
  secret: string;
  queue: IncidentQueue;
  now?: () => number;
  logger?: boolean;
  newIncidentId?: () => string;
}

export function defaultIncidentId(now: number = Date.now()): string {
  return `inc-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const now = options.now ?? Date.now;
  const newIncidentId = options.newIncidentId ?? (() => defaultIncidentId(now()));
  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger: options.logger
      ? { redact: ['req.headers["x-incidentpulse-signature"]', "req.headers.authorization"] }
      : false,
  });

  // Keep the exact bytes: the HMAC is computed over the raw body, before any JSON parsing.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/health", async () => ({ status: "ok", service: "intake" }));

  app.post("/webhook/monitor", async (req, reply) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    const verdict = verifySignature({
      secret: options.secret,
      timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined,
      signature: req.headers[SIGNATURE_HEADER] as string | undefined,
      rawBody,
      nowMs: now(),
    });
    if (!verdict.ok) {
      req.log.warn({ reason: verdict.reason }, "webhook rejected");
      return reply.code(401).send({ error: "unauthorized" });
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "invalid_json" });
    }
    const parsed = MonitorWebhookSchema.safeParse(json);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_payload",
        fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))],
      });
    }

    const { project, category, ...signal } = parsed.data;
    const level = signal.level.trim().toLowerCase();
    if (level !== "down" && level !== "ok") {
      return reply.code(202).send({ status: "ignored", reason: "level_not_down_or_ok" });
    }

    const queued = await options.queue.enqueue({
      incidentId: newIncidentId(),
      project,
      signal: { ...signal, level },
      ...(category ? { category } : {}),
      dedupKey: dedupKey(project, signal.check),
      receivedAt: new Date(now()).toISOString(),
    });
    return reply.code(202).send({
      status: queued.deduplicated ? "duplicate" : "queued",
      incidentId: queued.incidentId,
    });
  });

  return app;
}
