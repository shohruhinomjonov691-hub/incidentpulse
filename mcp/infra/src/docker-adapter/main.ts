// docker-read-adapter entry point (compose.prod.yaml service `docker-read-adapter`).
import { z } from "zod";
import { isValidContainerName } from "../allowlist.ts";
import { createDockerReadAdapter, tcpUpstream } from "./server.ts";

const proxy = process.env.DOCKER_PROXY_URL ?? "http://docker-proxy:2375";
const host = process.env.ADAPTER_HOST ?? "0.0.0.0";
const port = Number(process.env.ADAPTER_PORT ?? 2376);

const parsed = z
  .record(z.string(), z.array(z.string()))
  .safeParse(JSON.parse(process.env.PROJECT_CONTAINERS_JSON || "{}"));
const prefixes = parsed.success ? [...new Set(Object.values(parsed.data).flat())] : [];
if (!parsed.success || prefixes.some((p) => !isValidContainerName(p))) {
  console.error(
    "docker-read-adapter: PROJECT_CONTAINERS_JSON must list valid container name prefixes; refusing to start",
  );
  process.exit(1);
}

const server = createDockerReadAdapter({
  allowedPrefixes: prefixes,
  upstream: tcpUpstream(proxy),
});
server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "listening", host, port, prefixes: prefixes.length }));
});
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
