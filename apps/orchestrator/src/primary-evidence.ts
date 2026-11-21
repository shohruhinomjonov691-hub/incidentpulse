import { createHash } from "node:crypto";
import {
  DockerLogsResultSchema,
  DockerPsResultSchema,
  HttpProbeResultSchema,
  Pm2ListResultSchema,
  TlsInspectResultSchema,
} from "@incidentpulse/mcp-infra/schemas";
import type { Category, Evidence, IncidentJob } from "@incidentpulse/schemas";
import { createInfraMcp, type SpecialistFactoryOptions } from "./agents/specialists.ts";
import { buildEvidence, logSignatures } from "./evidence.ts";
import { scrubText } from "./guardrails.ts";

export interface PrimaryEvidence {
  category: Category;
  hash: string;
  quickEvidence: Evidence[];
  unsafeAttempts: number;
  injectionFlags: number;
  /** Fixed (non-LLM) probe calls made to build this evidence; for cost and tool-call accounting. */
  toolCalls?: number;
  health?: { endpoints: Array<{ url: string; ok: boolean }>; containers: Record<string, boolean> };
}

export function hashFacts(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type ProbeOptions = Pick<
  SpecialistFactoryOptions,
  "resources" | "redact" | "childEnv" | "infraBin"
>;

/** Fixed, allowlisted read-only probes, independent of the LLM and of untrusted target text. */
export function createPrimaryProbe(options: ProbeOptions) {
  return async (job: IncidentJob): Promise<PrimaryEvidence> => {
    const { project, signal } = job;
    const { domains, containers } = options.resources;
    const quickEvidence: Evidence[] = [];
    const facts: unknown[] = [];
    const health: NonNullable<PrimaryEvidence["health"]> = { endpoints: [], containers: {} };
    const categories = new Set<Category>();
    let injectionFlags = 0;
    let toolCalls = 0;

    if (domains[project].length || containers[project].length) {
      const server = createInfraMcp(
        project,
        options,
        ["http_probe", "tls_inspect", "docker_ps", "docker_logs", "pm2_list"],
        "quick_probes",
      );
      await server.connect();
      try {
        const call = async (tool: string, args: Record<string, unknown>, quick = false) => {
          await server.callTool(tool, args);
          const record = server.calls.at(-1);
          if (!record || record.blocked) throw new Error(`Primary probe failed: ${tool}`);
          if (quick) {
            quickEvidence.push(
              buildEvidence({
                id: `p${quickEvidence.length + 1}`,
                tool,
                output: record.scrubbedText,
                at: new Date(),
                redact: options.redact,
              }),
            );
          }
          return JSON.parse(record.scrubbedText) as unknown;
        };

        for (const domain of [...new Set(domains[project])].sort()) {
          const url = new URL(`https://${domain}/`);
          const http = HttpProbeResultSchema.parse(
            await call("http_probe", { url: url.href }, true),
          );
          facts.push({
            url: http.url,
            completed: http.completed,
            status: http.status,
            error: http.error,
            finalUrl: http.finalUrl,
            blockedRedirect: http.blockedRedirect,
            redirects: http.redirects,
          });
          health.endpoints.push({
            url: http.url,
            ok: http.completed && (http.status ?? 0) >= 200 && (http.status ?? 999) < 400,
          });
          if (http.certErrorCode) {
            categories.add("tls");
            const {
              latencyMs: _latency,
              daysRemaining: _days,
              ...tls
            } = TlsInspectResultSchema.parse(
              await call(
                "tls_inspect",
                { host: url.hostname, port: Number(url.port || 443) },
                true,
              ),
            );
            facts.push(tls);
          }
          if (http.status && http.status >= 500) categories.add("http_5xx");
          // 504 is a gateway timeout by definition: the proxy waited for a backend that was too slow.
          if (http.status === 504 || http.status === 408) categories.add("timeout");
          if (/^(ENOTFOUND|EAI_AGAIN)$/.test(http.error ?? "")) categories.add("dns");
          if (/TIMEOUT|TIMEDOUT/i.test(http.error ?? "")) categories.add("timeout");
        }

        if (containers[project].length && !categories.has("tls")) {
          const ps = DockerPsResultSchema.parse(await call("docker_ps", {}));
          const ordered = ps.containers.sort((a, b) => a.name.localeCompare(b.name));
          health.containers = Object.fromEntries(
            ordered.map((c) => [
              c.name,
              c.state === "running" && !/unhealthy|health: starting/.test(c.status),
            ]),
          );
          facts.push({
            error: ps.error,
            containers: ordered.map(({ name, image, state, status }) => ({
              name,
              image,
              state,
              exit: status.match(/^(?:Exited|Restarting) \((\d+)\)/)?.[1],
              health: status.match(/\((unhealthy|healthy|health: starting)\)/)?.[1],
            })),
          });
          if (ordered.some((c) => c.state === "exited" || c.state === "dead")) {
            categories.add("container_down");
          }
          for (const { name } of ordered) {
            const logs = DockerLogsResultSchema.parse(
              await call("docker_logs", { container: name, tail: 100 }),
            );
            const keyLines = logSignatures(logs.lines);
            if (keyLines.length || logs.error) facts.push({ name, keyLines, error: logs.error });
          }
        }

        // pm2 apps can be stopped while their container (or host) is up: ask pm2 directly.
        if (options.resources.pm2?.[project]?.apps.length && !categories.has("tls")) {
          const pm2 = Pm2ListResultSchema.parse(await call("pm2_list", {}, true));
          const apps = pm2.apps.sort((a, b) => a.name.localeCompare(b.name));
          for (const app of apps) health.containers[`pm2:${app.name}`] = app.status === "online";
          facts.push({
            pm2: apps.map(({ name, status, restarts }) => ({ name, status, restarts })),
            error: pm2.error,
          });
          if (apps.some((a) => a.status === "stopped" || a.status === "errored")) {
            categories.add("container_down");
          }
        }
      } finally {
        injectionFlags = server.calls.reduce((total, c) => total + c.flaggedCount, 0);
        toolCalls = server.calls.length;
        await server.close();
      }
    }

    const category =
      job.category ??
      (["tls", "dns", "container_down", "timeout", "http_5xx"] as const).find((c) =>
        categories.has(c),
      ) ??
      "unknown";
    const monitor =
      category === "unknown" || !categories.size
        ? [signal.check, options.redact(scrubText(signal.summary).text).replace(/\s+/g, " ").trim()]
        : undefined;
    return {
      category,
      hash: hashFacts([options.redact(JSON.stringify(facts)), monitor]),
      quickEvidence,
      unsafeAttempts: 0,
      injectionFlags,
      toolCalls,
      health,
    };
  };
}
