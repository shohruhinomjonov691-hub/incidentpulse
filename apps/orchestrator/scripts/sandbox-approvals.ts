import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadOrchestratorConfig } from "@incidentpulse/config";
import type { ActionRunner } from "@incidentpulse/mcp-actions";
import { collectSecrets, createRedactor } from "@incidentpulse/redact";
import { INCIDENT_JOB_OPTIONS, type IncidentJob } from "@incidentpulse/schemas";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";
import type { GraphState } from "../src/graph.ts";
import { createLogger } from "../src/log.ts";
import { startRuntime } from "../src/runtime.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sandbox = join(root, "sandbox");
const certs = join(sandbox, "runtime/certs");
const sand = (...args: string[]) =>
  execFileSync(join(sandbox, "scripts/sandbox.sh"), args, { cwd: root });
const exec = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const name = `ipsb${randomBytes(5).toString("hex")}`;
const secret = randomBytes(32).toString("hex");
const base = loadOrchestratorConfig({ ...process.env, ACTIONS_ENABLED: "false" });
const database = new URL(base.databaseUrl);
if (
  ![database, new URL(base.redisUrl)].every(
    (url) => url.hostname === "127.0.0.1" || url.hostname === "localhost",
  )
) {
  throw new Error("Sandbox requires loopback Postgres and Redis");
}
if (!base.telegramAllowedUserIds.size)
  throw new Error("Sandbox requires a Telegram user allowlist");
const pool = new Pool({ connectionString: database.href });
await pool.query(`CREATE SCHEMA "${name}"`);
database.searchParams.set("options", `-csearch_path=${name}`);

const port = await new Promise<number>((resolve, reject) => {
  const socket = createServer().on("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const address = socket.address();
    socket.close(() => typeof address === "object" && address && resolve(address.port));
  });
});
const debateUrl = `http://127.0.0.1:${port}`;
const debate = spawn(
  "uv",
  [
    "run",
    "--locked",
    "uvicorn",
    "debate_verifier.main:app",
    "--app-dir",
    "src",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: join(root, "services/debate-verifier"),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENAI_API_KEY: base.openaiApiKey,
      DEBATE_SHARED_SECRET: secret,
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);

const config = loadOrchestratorConfig({
  ...process.env,
  DATABASE_URL: database.href,
  OPENAI_MODEL: "gpt-5.4-mini",
  WEEKLY_BUDGET_USD: "0.15",
  INVESTIGATE_MODE: "on_change",
  DEBATE_MODE: "auto",
  DEBATE_URL: debateUrl,
  DEBATE_SHARED_SECRET: secret,
  ACTIONS_ENABLED: "true",
  APPROVAL_HMAC_SECRET: secret,
  PROJECT_DOMAINS_JSON: JSON.stringify({ gotrip: ["a.localhost:18443"], kervan: [] }),
  PROJECT_CONTAINERS_JSON: JSON.stringify({ gotrip: ["ipsb-a-"] }),
  PROJECT_ACTION_SCOPES_JSON: JSON.stringify({ gotrip: { containers: ["ipsb-a-app"] } }),
  CODETRAIL_BASE_URL: undefined,
  CODETRAIL_API_KEY: undefined,
  GITHUB_READONLY_TOKEN: undefined,
});
const redact = createRedactor({ secrets: [...collectSecrets(process.env), secret] });
const actions: ActionRunner = async ({ program, args }) => {
  const docker = async (...target: string[]) =>
    (await exec("docker", target, { timeout: 30_000, maxBuffer: 64 * 1024, shell: false })).stdout;
  if (
    program === "certbot" &&
    args[0] === "renew" &&
    args[1] === "--cert-name" &&
    args[2] === "a.localhost"
  ) {
    // a.localhost is private. Stage and deploy the existing local-CA leaf offline.
    const ca = new X509Certificate(await readFile(join(certs, "ca.pem")));
    const leaf = new X509Certificate(await readFile(join(certs, "a.crt")));
    if (
      !leaf.verify(ca.publicKey) ||
      !leaf.checkHost("a.localhost") ||
      Date.now() < leaf.validFromDate.getTime() ||
      Date.now() >= leaf.validToDate.getTime()
    ) {
      throw new Error("Sandbox CA candidate failed verification");
    }
    if (!args.includes("--dry-run")) {
      await copyFile(join(certs, "a.crt"), join(sandbox, "runtime/a/certs/server.crt"));
      await copyFile(join(certs, "a.key"), join(sandbox, "runtime/a/certs/server.key"));
    }
    return args.includes("--dry-run")
      ? "Sandbox CA candidate passed TLS verification"
      : "Sandbox CA leaf deployed";
  }
  if (program === "nginx" && args.join(" ") === "-t")
    return docker("exec", "ipsb-a-nginx", "nginx", "-t");
  if (program === "systemctl" && args.join(" ") === "reload nginx") {
    return docker("exec", "ipsb-a-nginx", "nginx", "-s", "reload");
  }
  if (program === "docker" && args[0] === "inspect" && args.at(-1) === "ipsb-a-app")
    return docker(...args);
  if (program === "docker" && args.join(" ") === "restart ipsb-a-app") return docker(...args);
  throw new Error("Command is outside the sandbox action allowlist");
};

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(name, { connection: redis });
let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
const results = [];
let stop = false;
process.on("SIGINT", () => {
  stop = true;
});
process.on("SIGTERM", () => {
  stop = true;
});

try {
  const serviceDeadline = Date.now() + 30_000;
  while (
    !(await fetch(`${debateUrl}/health`, { signal: AbortSignal.timeout(800) })
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    if (Date.now() > serviceDeadline) throw new Error("Sandbox debate service did not start");
    await sleep(250);
  }
  sand("up");
  runtime = await startRuntime({
    config,
    redact,
    log: createLogger(redact),
    prefix: name,
    actionRunner: actions,
    childEnv: { NODE_EXTRA_CA_CERTS: join(certs, "ca.pem") },
    strictBudget: true,
    noticePrefix: "[SANDBOX] ",
  });
  for (const scenario of [1, 3]) {
    if (stop) throw new Error("Sandbox stopped");
    sand("inject", String(scenario));
    const incidentId = `sandbox-${name}-${scenario}`;
    await sleep(3000);
    const at = new Date().toISOString();
    const signal: IncidentJob = {
      incidentId,
      project: "gotrip",
      signal: { check: "https", level: "down", summary: "HTTPS health check failed", at },
      dedupKey: "gotrip:https:unknown",
      receivedAt: at,
    };
    await queue.add("incident", signal, { ...INCIDENT_JOB_OPTIONS, jobId: incidentId });
    const deadline = Date.now() + 65 * 60_000;
    let ready = false;
    for (;;) {
      if (stop || Date.now() > deadline) throw new Error("Sandbox approval wait ended");
      const snap = await runtime.graph.getState({ configurable: { thread_id: incidentId } });
      const state = snap.values as GraphState;
      const approval = state.approvalId
        ? await runtime.approvals?.get(state.approvalId)
        : undefined;
      if (approval?.notifiedAt && !ready) {
        ready = true;
        console.log(
          `READY scenario=${scenario} incident=${incidentId} runbook=${approval.runbookId} cost=${state.costUsd.toFixed(6)}`,
        );
      }
      if (state.recovery?.ok && state.workflowStatus === "recovered") {
        const audit = await pool.query<{ event: string }>(
          `SELECT event FROM "${name}".incidentpulse_action_audit WHERE approval_id=$1 ORDER BY seq`,
          [approval?.id],
        );
        const row = {
          scenario,
          incidentId,
          got: state.category,
          runbook: state.remediation?.runbookId,
          approval: state.approval?.status,
          execution: state.execution?.ok,
          recovery: state.recovery,
          costUsd: state.costUsd,
          audit: audit.rows.map((event) => event.event),
          debate: state.trace.filter(
            (event) => event.node === "verify" || event.node === "reinvestigate",
          ),
        };
        if (
          state.remediation?.runbookId !== (scenario === 1 ? "certbot_renew" : "docker_restart") ||
          !state.execution?.ok ||
          !audit.rows.some((event) => event.event === "execution_finished")
        ) {
          throw new Error("Sandbox recovered without the expected approved execution");
        }
        results.push(row);
        console.log(`RECOVERED scenario=${scenario} cost=${state.costUsd.toFixed(6)}`);
        break;
      }
      if (state.reportSent || state.escalation || state.workflowStatus) {
        throw new Error(
          `Sandbox scenario ${scenario} ended: ${state.escalation?.reason ?? state.workflowStatus ?? "no proposal"}`,
        );
      }
      if ((await queue.getJobState(incidentId)) === "failed")
        throw new Error(`Sandbox job failed: ${scenario}`);
      await sleep(1000);
    }
  }
} finally {
  const totalCostUsd = await runtime?.weeklyBudget.spentUsd(new Date());
  await writeFile(
    join(sandbox, "results/phase3-4.json"),
    `${JSON.stringify(
      {
        model: config.model,
        debateModel: "gpt-5.4-nano",
        totalCostUsd,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`TOTAL $ ${totalCostUsd?.toFixed(6) ?? "0"}`);
  await runtime?.close();
  await queue.obliterate({ force: true });
  await queue.close();
  redis.disconnect();
  await pool.end();
  debate.kill();
  sand("down");
}
