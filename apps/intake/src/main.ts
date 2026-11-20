import { loadIntakeConfig } from "@incidentpulse/config";
import { createBullQueue } from "./queue.ts";
import { buildServer } from "./server.ts";

const config = loadIntakeConfig(process.env);
const queue = createBullQueue({ redisUrl: config.redisUrl, dedupTtlMs: config.dedupTtlMs });
const app = buildServer({ secret: config.hmacSecret, queue, logger: true });

const shutdown = async () => {
  await app.close();
  await queue.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Bound to loopback by default; put a TLS-terminating proxy in front for CodeTrail (Phase 7).
await app.listen({ host: config.host, port: config.port });
