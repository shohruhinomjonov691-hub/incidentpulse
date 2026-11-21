import { execFile } from "node:child_process";
import { type Pm2ListResult, Pm2ListResultSchema } from "../schemas.ts";
import { type DockerRunner, execDocker } from "./docker.ts";

const APP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,126}$/;

export function isValidPm2App(name: string): boolean {
  return APP_NAME.test(name);
}

export interface Pm2Runner {
  /** Returns the stdout of `pm2 jlist`. Fixed argv, no shell. */
  jlist(options: { timeoutMs: number }): Promise<string>;
}

/** `pm2 jlist` on this host (a VPS where pm2 runs next to the process). */
export const localPm2: Pm2Runner = {
  jlist: ({ timeoutMs }) =>
    new Promise((resolve, reject) => {
      execFile(
        "pm2",
        ["jlist"],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
        (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout)),
      );
    }),
};

/** `docker exec <container> pm2 jlist` for pm2 inside an allowlisted container (the sandbox). */
export function containerPm2(container: string, run: DockerRunner = execDocker): Pm2Runner {
  return {
    async jlist({ timeoutMs }) {
      const { stdout } = await run(["exec", container, "pm2", "jlist"], { timeoutMs });
      return stdout;
    },
  };
}

interface Pm2Row {
  name?: string;
  pm2_env?: { status?: string; restart_time?: number; pm_uptime?: number };
}

function errorCode(error: unknown): string {
  const e = error as NodeJS.ErrnoException & { killed?: boolean };
  if (e.killed) return "ETIMEDOUT";
  return typeof e.code === "string" ? e.code : "PM2_ERROR";
}

/** Read-only `pm2 jlist`, reduced to the allowlisted apps' name, status, restarts and uptime. */
export async function pm2List(options: {
  allowedApps: readonly string[];
  timeoutMs: number;
  runner?: Pm2Runner;
  now?: () => number;
}): Promise<Pm2ListResult> {
  const runner = options.runner ?? localPm2;
  const now = options.now ?? Date.now;
  try {
    const stdout = await runner.jlist({ timeoutMs: options.timeoutMs });
    // pm2 may print a banner (itself starting with "[PM2]") before the JSON array.
    const start = stdout.search(/^\[\s*(?:\{|\])/m);
    if (start < 0) return Pm2ListResultSchema.parse({ apps: [], error: "BAD_OUTPUT" });
    const rows = JSON.parse(stdout.slice(start)) as Pm2Row[];
    const apps = rows
      .filter((r) => r.name && options.allowedApps.includes(r.name) && isValidPm2App(r.name))
      .map((r) => {
        const status = r.pm2_env?.status ?? "unknown";
        const since = r.pm2_env?.pm_uptime;
        return {
          name: r.name as string,
          status,
          restarts: Math.max(0, Math.floor(r.pm2_env?.restart_time ?? 0)),
          ...(status === "online" && since
            ? { uptimeSeconds: Math.max(0, Math.round((now() - since) / 1000)) }
            : {}),
        };
      });
    return Pm2ListResultSchema.parse({ apps });
  } catch (error) {
    return Pm2ListResultSchema.parse({
      apps: [],
      error: error instanceof SyntaxError ? "BAD_OUTPUT" : errorCode(error),
    });
  }
}
