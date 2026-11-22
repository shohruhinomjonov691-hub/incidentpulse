import { request } from "node:http";

/**
 * Client for the host actions runner (host/actions-runner). It talks HTTP over a unix socket;
 * access is controlled by the socket's file permissions, and every state-changing call is
 * additionally gated by an approval token that the runner verifies itself.
 */

export const PACKAGE_NAME = "@incidentpulse/runner-client";

export class RunnerError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
  }
}

export interface Pm2JlistRead {
  apps: Array<{ name: string; pid?: number; status: string; restarts: number; since?: number }>;
}
export interface Pm2LogsRead {
  app: string;
  lines: string[];
}
export interface Pm2PortsRead {
  apps: Array<{ app: string; pid?: number; ports: number[] }>;
}
export interface NginxConfigRead {
  servers: Array<{ names: string[]; listens: string[]; ssl: boolean; proxyPass: string[] }>;
}
export interface CertListRead {
  certificates: Array<{
    name: string;
    domains: string[];
    expiresAt?: string;
    daysRemaining?: number;
    valid: boolean;
  }>;
}

export interface ReadOps {
  pm2_jlist: Pm2JlistRead;
  pm2_logs: Pm2LogsRead;
  pm2_ports: Pm2PortsRead;
  nginx_config: NginxConfigRead;
  cert_list: CertListRead;
}

export interface RunbookRequest {
  project: string;
  runbookId: string;
  params: Record<string, string>;
}
export interface ExecuteRequest extends RunbookRequest {
  approvalId: string;
  incidentId: string;
  approvalToken: string;
  /** sha256 of the canonical plan; part of the signed token. The runner recomputes it from its own policy. */
  planDigest: string;
  /** Epoch ms; part of the signed approval token. */
  tokenExpiresAt: number;
}
export interface RunbookOutcome {
  ok: boolean;
  output: string;
}
export interface RunbookPlan {
  planDigest: string;
  policyDigest: string;
  /** Target, parameters and exact commands, one per line. */
  summary: string[];
}
export interface RunnerJob {
  kind: "dry-run" | "execute";
  project: string;
  runbookId: string;
  approvalId?: string;
  sinceMs: number;
}
export interface RunnerStatus {
  paused: boolean;
  running: RunnerJob[];
  queued: RunnerJob[];
}

export interface RunnerClient {
  read<K extends keyof ReadOps>(
    op: K,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ReadOps[K]>;
  /** The canonical plan (digest, policy digest, summary) the runner computes from its own policy. */
  plan(body: RunbookRequest): Promise<RunbookPlan>;
  /** Static pre-approval checks. Nothing here touches the live nginx. */
  dryRun(body: RunbookRequest): Promise<RunbookOutcome>;
  execute(body: ExecuteRequest): Promise<RunbookOutcome>;
  /** The runner's own kill switch, independent of the orchestrator's Redis flag. */
  pause(): Promise<RunnerStatus>;
  resume(): Promise<RunnerStatus>;
  status(): Promise<RunnerStatus>;
  health(): Promise<boolean>;
}

const MAX_RESPONSE = 1024 * 1024;

export function createRunnerClient(options: {
  socketPath: string;
  timeoutMs?: number;
}): RunnerClient {
  const call = (
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath: options.socketPath,
          path,
          method,
          timeout: timeoutMs,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE) {
              req.destroy(new RunnerError("RESPONSE_TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
              if (json === null || typeof json !== "object" || Array.isArray(json)) {
                throw new Error("not an object");
              }
              resolve({ status: res.statusCode ?? 0, json: json as Record<string, unknown> });
            } catch {
              reject(new RunnerError("BAD_RESPONSE"));
            }
          });
        },
      );
      req.once("timeout", () => req.destroy(new RunnerError("ETIMEDOUT")));
      req.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        reject(
          error instanceof RunnerError ? error : new RunnerError(code ?? "RUNNER_UNREACHABLE"),
        );
      });
      if (payload) req.write(payload);
      req.end();
    });

  const outcome = (json: Record<string, unknown>): RunbookOutcome => ({
    ok: json.ok === true,
    output: typeof json.output === "string" ? json.output : String(json.error ?? "No output"),
  });

  const runnerStatus = (json: Record<string, unknown>): RunnerStatus => {
    if (json.ok !== true || typeof json.paused !== "boolean") {
      throw new RunnerError(String(json.error ?? "RUNNER_ERROR"));
    }
    const jobs = (value: unknown): RunnerJob[] =>
      Array.isArray(value) ? (value as RunnerJob[]) : [];
    return { paused: json.paused, running: jobs(json.running), queued: jobs(json.queued) };
  };

  return {
    async read(op, args = {}, timeoutMs = options.timeoutMs ?? 15_000) {
      const { json } = await call("POST", "/v1/read", { op, args }, timeoutMs);
      if (json.ok !== true) throw new RunnerError(String(json.error ?? "RUNNER_ERROR"));
      return json as unknown as ReadOps[typeof op];
    },
    async plan(body) {
      const { json } = await call("POST", "/v1/runbooks/plan", body, 15_000);
      if (
        json.ok !== true ||
        typeof json.planDigest !== "string" ||
        typeof json.policyDigest !== "string" ||
        !Array.isArray(json.summary)
      ) {
        throw new RunnerError(String(json.error ?? "RUNNER_ERROR"));
      }
      return {
        planDigest: json.planDigest,
        policyDigest: json.policyDigest,
        summary: json.summary.filter((line): line is string => typeof line === "string"),
      };
    },
    async dryRun(body) {
      const { json } = await call("POST", "/v1/runbooks/dry-run", body, 300_000);
      return outcome(json);
    },
    async execute(body) {
      const { json } = await call("POST", "/v1/runbooks/execute", body, 600_000);
      return outcome(json);
    },
    async pause() {
      return runnerStatus((await call("POST", "/v1/pause", {}, 5000)).json);
    },
    async resume() {
      return runnerStatus((await call("POST", "/v1/resume", {}, 5000)).json);
    },
    async status() {
      return runnerStatus((await call("GET", "/v1/status", undefined, 5000)).json);
    },
    async health() {
      try {
        return (await call("GET", "/v1/health", undefined, 3000)).json.ok === true;
      } catch {
        return false;
      }
    },
  };
}
