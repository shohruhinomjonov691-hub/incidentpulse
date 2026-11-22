import { createServer, request as httpRequest, type Server } from "node:http";
import { isAllowedContainer, isValidContainerName } from "../allowlist.ts";

/**
 * docker-read-adapter: the ONLY thing the orchestrator can reach for Docker data. It sits between the
 * orchestrator and docker-socket-proxy (two separate internal networks, so the orchestrator has no route to
 * the proxy) and exposes exactly two read operations:
 *
 *   GET /containers/json[?all=0|1]              names filtered by the project prefixes; name, image, state, status
 *                                               only (no Labels, Mounts, Env, ports, networks, ids)
 *   GET /containers/<name>/logs?tail=N[&stdout=1&stderr=1]
 *                                               logs of ONE allowlisted container, tail capped, plain text
 *
 * Everything else (inspect, archive, export, stats, top, changes, exec, any other path, any other method, any
 * other query parameter) answers 403. `GET /health` is the one non-Docker route (no data, no upstream call).
 *
 * The adapter itself may inspect a container upstream (to learn whether its log stream is multiplexed); that
 * answer never leaves this process.
 */

export const MAX_LOG_TAIL = 500;
const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;
const MAX_IN_FLIGHT = 2;

export interface UpstreamResponse {
  status: number;
  body: Buffer;
}
/** GET against docker-socket-proxy (or a fake in tests). Resolves with the status and the (capped) body. */
export type Upstream = (path: string) => Promise<UpstreamResponse>;

export function tcpUpstream(baseUrl: string, timeoutMs = 10_000): Upstream {
  const url = new URL(baseUrl);
  return (path) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: url.hostname,
          port: Number(url.port) || 80,
          path,
          method: "GET",
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_UPSTREAM_BYTES) {
              req.destroy(new Error("UPSTREAM_TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          res.once("error", reject);
        },
      );
      req.once("timeout", () => req.destroy(new Error("UPSTREAM_TIMEOUT")));
      req.once("error", reject);
      req.end();
    });
}

/** Splits Docker's multiplexed log stream (8-byte frame headers) into one text; a TTY stream is raw text. */
export function demuxLogs(buffer: Buffer, tty: boolean): string {
  if (tty) return buffer.toString("utf8");
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const kind = buffer[offset] ?? 0;
    const size = buffer.readUInt32BE(offset + 4);
    if (kind > 2 || buffer[offset + 1] !== 0 || offset + 8 + size > buffer.length) {
      throw new Error("BAD_LOG_FRAME");
    }
    parts.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  if (offset !== buffer.length) throw new Error("BAD_LOG_FRAME");
  return Buffer.concat(parts).toString("utf8");
}

interface ListedContainer {
  Id?: unknown;
  Names?: unknown;
  Image?: unknown;
  State?: unknown;
  Status?: unknown;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function createDockerReadAdapter(options: {
  /** Container name prefixes (the flattened PROJECT_CONTAINERS_JSON). Empty = nothing is visible. */
  allowedPrefixes: readonly string[];
  upstream: Upstream;
}): Server {
  const { allowedPrefixes, upstream } = options;
  let inFlight = 0;
  const allowedName = (name: string) => isAllowedContainer(name, allowedPrefixes);
  async function withSlot(work: () => Promise<void>, busy: () => void) {
    if (inFlight >= MAX_IN_FLIGHT) return busy();
    inFlight += 1;
    try {
      await work();
    } finally {
      inFlight -= 1;
    }
  }

  async function listAllowed(all: boolean) {
    if (allowedPrefixes.length === 0) return [];
    const response = await upstream(`/containers/json?all=${all ? 1 : 0}`);
    if (response.status !== 200) throw new Error("UPSTREAM_STATUS");
    const rows = JSON.parse(response.body.toString("utf8")) as ListedContainer[];
    return rows.flatMap((row) => {
      const names = strings(row.Names)
        .map((n) => n.replace(/^\//, ""))
        .filter(allowedName);
      return names.length === 0 ? [] : [{ row, names }];
    });
  }

  const server = createServer((req, res) => {
    const send = (status: number, body: string, type = "application/json") => {
      res.writeHead(status, {
        "content-type": `${type}; charset=utf-8`,
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
    };
    const forbidden = () => send(403, JSON.stringify({ message: "forbidden" }));
    const failed = () => send(502, JSON.stringify({ message: "docker is unavailable" }));
    const busy = () => send(503, JSON.stringify({ message: "docker adapter is busy" }));

    void (async () => {
      if (req.method !== "GET") return forbidden();
      const raw = req.url ?? "";
      const url = new URL(raw, "http://adapter");
      if (url.pathname !== raw.split("?", 1)[0]) return forbidden();
      const query = url.searchParams;
      const only = (...allowed: string[]) => [...query.keys()].every((k) => allowed.includes(k));

      if (url.pathname === "/health") return send(200, "ok", "text/plain");

      if (url.pathname === "/containers/json") {
        if (!only("all")) return forbidden();
        const all = query.get("all");
        if (all !== null && !["0", "1", "true", "false"].includes(all)) return forbidden();
        return withSlot(async () => {
          const listed = await listAllowed(all === "1" || all === "true");
          return send(
            200,
            JSON.stringify(
              listed.map(({ row, names }) => ({
                Names: names.map((n) => `/${n}`),
                Image: typeof row.Image === "string" ? row.Image : "",
                State: typeof row.State === "string" ? row.State : "",
                Status: typeof row.Status === "string" ? row.Status : "",
              })),
            ),
          );
        }, busy);
      }

      const logs = /^\/containers\/([^/]+)\/logs$/.exec(url.pathname);
      if (logs) {
        if (!only("tail", "stdout", "stderr")) return forbidden();
        const name = logs[1] ?? "";
        const tailText = query.get("tail") ?? "100";
        if (!isValidContainerName(name) || !allowedName(name) || !/^\d{1,4}$/.test(tailText)) {
          return forbidden();
        }
        const tail = Math.min(MAX_LOG_TAIL, Math.max(1, Number(tailText)));
        return withSlot(async () => {
          // Resolve the NAME to an id through the filtered list; never ask Docker to resolve a caller string.
          const match = (await listAllowed(true)).find(({ names }) => names.includes(name));
          const id = typeof match?.row.Id === "string" ? match.row.Id : "";
          if (!/^[a-f0-9]{12,64}$/.test(id)) return forbidden();
          const inspect = await upstream(`/containers/${id}/json`);
          if (inspect.status !== 200) throw new Error("UPSTREAM_STATUS");
          const tty =
            (JSON.parse(inspect.body.toString("utf8")) as { Config?: { Tty?: unknown } }).Config
              ?.Tty === true;
          const stream = await upstream(
            `/containers/${id}/logs?stdout=1&stderr=1&follow=0&timestamps=0&tail=${tail}`,
          );
          if (stream.status !== 200) throw new Error("UPSTREAM_STATUS");
          // The Docker tool redacts the complete text before truncating it.
          return send(200, demuxLogs(stream.body, tty), "text/plain");
        }, busy);
      }

      return forbidden();
    })().catch(failed);
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 15_000;
  return server;
}
