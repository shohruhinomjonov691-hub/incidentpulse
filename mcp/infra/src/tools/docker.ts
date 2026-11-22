import { execFile } from "node:child_process";
import type { Redactor } from "@incidentpulse/redact";
import { isAllowedContainer, isValidContainerName } from "../allowlist.ts";
import {
  type DockerLogsResult,
  DockerLogsResultSchema,
  type DockerPsResult,
  DockerPsResultSchema,
} from "../schemas.ts";

export const MAX_TAIL = 500;
const MAX_LINE_CHARS = 400;
const MAX_TOTAL_CHARS = 24_000;

export interface DockerRunResult {
  stdout: string;
  stderr: string;
}

/** Runs `docker <args>` with no shell. Replaceable in tests. */
export type DockerRunner = (
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<DockerRunResult>;

export const execDocker: DockerRunner = (args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    // execFile: arguments are never interpreted by a shell.
    execFile(
      "docker",
      [...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && !stdout && !stderr) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });

function errorCode(error: unknown): string {
  const e = error as NodeJS.ErrnoException & { killed?: boolean };
  if (e.killed) return "ETIMEDOUT";
  return typeof e.code === "string" ? e.code : "DOCKER_ERROR";
}

interface PsRow {
  Names?: string;
  Image?: string;
  State?: string;
  Status?: string;
}

/** Read-only `docker ps -a`, restricted to allowlisted containers. */
export async function dockerPs(options: {
  allowedContainers: readonly string[];
  timeoutMs: number;
  runner?: DockerRunner;
}): Promise<DockerPsResult> {
  const run = options.runner ?? execDocker;
  try {
    const { stdout } = await run(["ps", "-a", "--no-trunc", "--format", "{{json .}}"], {
      timeoutMs: options.timeoutMs,
    });
    const containers = stdout
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l) as PsRow)
      .filter((r) => r.Names && isAllowedContainer(r.Names, options.allowedContainers))
      .map((r) => ({
        name: r.Names as string,
        image: r.Image ?? "",
        state: r.State ?? "",
        status: r.Status ?? "",
      }));
    return DockerPsResultSchema.parse({ containers });
  } catch (error) {
    return DockerPsResultSchema.parse({ containers: [], error: errorCode(error) });
  }
}

/**
 * Read-only `docker logs --tail N`, for an allowlisted container only. Lines are cut to a safe
 * length and redacted (tokens, keys, emails, passwords) before they leave this process.
 */
export async function dockerLogs(
  container: string,
  options: {
    tail: number;
    allowedContainers: readonly string[];
    timeoutMs: number;
    redact: Redactor;
    runner?: DockerRunner;
  },
): Promise<DockerLogsResult> {
  const run = options.runner ?? execDocker;
  const tail = Math.min(MAX_TAIL, Math.max(1, Math.floor(options.tail)));
  if (
    !isValidContainerName(container) ||
    !isAllowedContainer(container, options.allowedContainers)
  ) {
    return DockerLogsResultSchema.parse({
      container,
      tail,
      lines: [],
      truncated: false,
      error: "NOT_ALLOWED",
    });
  }
  try {
    const { stdout, stderr } = await run(["logs", "--tail", String(tail), container], {
      timeoutMs: options.timeoutMs,
    });
    // `docker logs` replays stdout then stderr; both matter (nginx and Node log errors to stderr).
    // Redaction runs on the WHOLE text first: a long secret or a multi-line private key must match its full
    // pattern, and cutting a line afterwards can then never leave a fragment of one behind.
    const clean = options.redact(`${stdout}${stderr}`);
    const all = clean.split("\n").filter((l) => l.length > 0);
    let truncated = all.length > tail;
    let lines = all
      .slice(-tail)
      .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l));
    let total = 0;
    const kept: string[] = [];
    for (const line of [...lines].reverse()) {
      total += line.length;
      if (total > MAX_TOTAL_CHARS) {
        truncated = true;
        break;
      }
      kept.unshift(line);
    }
    lines = kept;
    return DockerLogsResultSchema.parse({ container, tail, lines, truncated });
  } catch (error) {
    return DockerLogsResultSchema.parse({
      container,
      tail,
      lines: [],
      truncated: false,
      error: errorCode(error),
    });
  }
}
