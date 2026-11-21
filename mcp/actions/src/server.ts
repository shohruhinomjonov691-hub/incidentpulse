import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describeError, type Redactor } from "@incidentpulse/redact";
import { ProjectIdSchema } from "@incidentpulse/schemas";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApprovalStore, ExecutionResult } from "./approvals.ts";
import type { ActionProgram, ActionStep, ResolvedRunbook, RunbookRegistry } from "./registry.ts";
import { RunbookChoiceSchema } from "./registry.ts";
import type { RemoteExecutor } from "./remote.ts";

const exec = promisify(execFile);
const BINARIES: Record<ActionProgram, string> = {
  certbot: "/usr/bin/certbot",
  docker: "/usr/bin/docker",
  nginx: "/usr/sbin/nginx",
  pm2: "/usr/bin/pm2",
  systemctl: "/usr/bin/systemctl",
};

export type ActionRunner = (step: ActionStep) => Promise<string>;

export function createSystemRunner(user: string): ActionRunner {
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(user) || user === "root") {
    throw new Error("A dedicated non-root Unix action user is required");
  }
  return async ({ program, args }) => {
    const { stdout, stderr } = await exec(
      "/usr/bin/sudo",
      ["-n", "-H", "-u", user, "--", BINARIES[program], ...args],
      {
        shell: false,
        timeout: 120_000,
        maxBuffer: 256 * 1024,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      },
    );
    return [stdout, stderr].filter(Boolean).join("\n");
  };
}

export async function dryRun(
  book: ResolvedRunbook,
  run: ActionRunner,
  redact: Redactor,
): Promise<ExecutionResult> {
  try {
    if (book.prerequisite === "missing_certificate_or_vhost") await confirmPrerequisite(book, run);
    const output = [];
    for (const step of book.dryRun) output.push(await run(step));
    return { ok: true, output: redact(output.join("\n")).trim().slice(0, 2000) || "OK" };
  } catch (error) {
    return { ok: false, output: describeError(error, redact).slice(0, 2000) };
  }
}

async function confirmPrerequisite(book: ResolvedRunbook, run: ActionRunner) {
  const domain = book.params.domain;
  if (!domain) throw new Error("Issuance requires a domain");
  const [certificates, config] = await Promise.all([
    run({ program: "certbot", args: ["certificates"] }),
    run({ program: "nginx", args: ["-T"] }),
  ]);
  const names = (text: string, pattern: RegExp) =>
    [...text.matchAll(pattern)].flatMap((match) => (match[1] ?? "").trim().split(/\s+/));
  const certified = names(certificates, /^\s*Domains:\s*([^\r\n]+)/gm).includes(domain);
  const vhost = names(config.replace(/^\s*#.*$/gm, ""), /\bserver_name\s+([^;]+);/g).includes(
    domain,
  );
  if (certified && vhost) throw new Error("Certificate and virtual host already exist");
}

export const ExecutionRequestSchema = RunbookChoiceSchema.extend({
  approvalId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  incidentId: z.string().min(1).max(150),
  project: ProjectIdSchema,
  approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** Epoch ms the token expires; required to execute through the host runner, which re-verifies it. */
  tokenExpiresAt: z.number().int().positive().optional(),
});
export const ExecutionResultSchema = z.strictObject({
  ok: z.boolean(),
  output: z.string().max(4000),
});

export function createActionsServer(options: {
  registry: RunbookRegistry;
  approvals: ApprovalStore;
  /** Local step runner (sandbox, tests). Not used when `remote` is set. */
  run?: ActionRunner;
  /** Production: the host actions runner executes the runbook after re-verifying the token. */
  remote?: RemoteExecutor;
  redact: Redactor;
  isStopped(): Promise<boolean>;
}) {
  const { registry, approvals, remote, redact, isStopped } = options;
  const run: ActionRunner =
    options.run ??
    (async () => {
      throw new Error("No local action runner is configured");
    });
  const server = new McpServer({ name: "mcp-actions", version: "1.0.0" });
  server.registerTool(
    "execute_runbook",
    {
      description:
        "Execute a project-allowlisted runbook with its unexpired, single-use approval token.",
      inputSchema: ExecutionRequestSchema,
      outputSchema: ExecutionResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (request) => {
      const reply = (result: ExecutionResult) => ({
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: { ...result },
      });
      let book: ResolvedRunbook;
      try {
        // The approved upstream is bound by the token and the approval row; the host runner re-verifies it.
        const approvedUpstream = request.params.upstream;
        book = registry.resolve(
          request.project,
          { runbookId: request.runbookId, params: request.params },
          approvedUpstream ? { upstreams: [approvedUpstream] } : undefined,
        );
      } catch {
        return reply({ ok: false, output: "Runbook or parameters denied" });
      }
      if (await isStopped()) return reply({ ok: false, output: "Actions are paused" });
      if (book.remoteOnly && !remote) {
        return reply({ ok: false, output: "This runbook needs the host actions runner" });
      }
      if (remote && !request.tokenExpiresAt) {
        return reply({ ok: false, output: "Token expiry is required for the host runner" });
      }
      if (!(await approvals.claim(request))) {
        return reply({ ok: false, output: "Approval token is invalid, expired or already used" });
      }

      const output: string[] = [];
      let result: ExecutionResult;
      if (remote) {
        try {
          const outcome = await remote.execute(request, book);
          result = { ok: outcome.ok, output: redact(outcome.output).trim().slice(0, 4000) || "OK" };
        } catch (error) {
          result = { ok: false, output: describeError(error, redact).slice(0, 4000) };
        }
        await approvals.complete(request.approvalId, result);
        return reply(result);
      }
      try {
        if (book.prerequisite) await confirmPrerequisite(book, run);
        for (const step of book.run) {
          if (await isStopped()) throw new Error("Actions were paused");
          output.push(await run(step));
        }
        result = { ok: true, output: redact(output.join("\n")).trim().slice(0, 4000) || "OK" };
      } catch (error) {
        output.push(describeError(error, redact));
        result = { ok: false, output: redact(output.join("\n")).slice(0, 4000) };
      }
      await approvals.complete(request.approvalId, result);
      return reply(result);
    },
  );
  return server;
}
