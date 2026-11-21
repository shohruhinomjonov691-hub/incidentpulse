import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { connect } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadOrchestratorConfig } from "@incidentpulse/config";
import type { ActionRunner } from "@incidentpulse/mcp-actions";
import { createApprovalCallbacks } from "@incidentpulse/mcp-actions/approvals";
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

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const socket = createServer().on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => typeof address === "object" && address && resolve(address.port));
    });
  });
const uv = (cwd: string, module: string, port: number, env: Record<string, string | undefined>) =>
  spawn(
    "uv",
    [
      "run",
      "--locked",
      "uvicorn",
      module,
      "--app-dir",
      "src",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: join(root, cwd),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENAI_API_KEY: base.openaiApiKey,
        ...env,
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
const port = await freePort();
const debateUrl = `http://127.0.0.1:${port}`;
const debate = uv("services/debate-verifier", "debate_verifier.main:app", port, {
  DEBATE_SHARED_SECRET: secret,
});
const postmortemPort = await freePort();
const postmortemUrl = `http://127.0.0.1:${postmortemPort}`;
const postmortemSecret = randomBytes(32).toString("hex");
const postmortem = uv("services/postmortem-crew", "postmortem_crew.main:app", postmortemPort, {
  POSTMORTEM_SHARED_SECRET: postmortemSecret,
});
const webPort = Number(process.env.SANDBOX_WEB_PORT ?? 3210);
if (
  await fetch(`http://127.0.0.1:${webPort}/login`, { signal: AbortSignal.timeout(500) }).then(
    () => true,
    () => false,
  )
)
  throw new Error(`Port ${webPort} is already in use`);
const webOrigin = `http://127.0.0.1:${webPort}`;
const adminPassword = process.env.WEB_ADMIN_PASSWORD ?? randomBytes(12).toString("hex");
// Run the next binary directly: killing a pnpm wrapper would leave the server running.
const web = spawn(
  join(root, "apps/web/node_modules/.bin/next"),
  ["start", "--hostname", "127.0.0.1", "--port", String(webPort)],
  {
    cwd: join(root, "apps/web"),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: database.href,
      REDIS_URL: base.redisUrl,
      OPENAI_API_KEY: base.openaiApiKey,
      APPROVAL_HMAC_SECRET: secret,
      WEB_ADMIN_PASSWORD: adminPassword,
      WEB_ORIGIN: webOrigin,
      WEB_RUNTIME_PREFIX: name,
      WEEKLY_BUDGET_USD: "0.15",
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
let stop = false;
process.on("SIGINT", () => {
  stop = true;
});
process.on("SIGTERM", () => {
  stop = true;
});

const ready = async (url: string, headers?: Record<string, string>) => {
  const deadline = Date.now() + 90_000;
  while (
    !(await fetch(url, { headers, signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    if (Date.now() > deadline)
      throw new Error(`Sandbox service did not start: ${new URL(url).port}`);
    await sleep(300);
  }
};
const notify = (text: string) =>
  process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
    ? fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        body: new URLSearchParams({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
      }).catch(() => undefined)
    : undefined;

// Scenario 1 only. With --auto the script presses Approve through the web API itself (same
// endpoint and token as the browser button); otherwise it waits for a person to press it.
const auto = process.argv.includes("--auto");
const scenario = 1;
const incidentId = `sandbox-${name}-${scenario}`;
let row: Record<string, unknown> = {};

try {
  await Promise.all([
    ready(`${debateUrl}/health`),
    ready(`${postmortemUrl}/ready`, { authorization: `Bearer ${postmortemSecret}` }),
    ready(`${webOrigin}/login`),
  ]);
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
    webOrigin,
    postmortem: { url: postmortemUrl, secret: postmortemSecret },
  });
  console.log(`WEB ${webOrigin}/incidents/${incidentId}`);
  console.log(`WEB_PASSWORD ${adminPassword}`);
  // The fault must really be live before any LLM is called: wait until the served leaf has expired.
  const servedCertExpired = () =>
    new Promise<boolean>((resolve) => {
      const socket = connect(
        { host: "127.0.0.1", port: 18443, servername: "a.localhost", rejectUnauthorized: false },
        () => {
          const validTo = socket.getPeerCertificate().valid_to;
          socket.destroy();
          resolve(!!validTo && new Date(validTo).getTime() < Date.now());
        },
      );
      socket.setTimeout(2000, () => socket.destroy());
      socket.on("error", () => resolve(false));
    });
  for (let attempt = 0; ; attempt++) {
    sand("inject", String(scenario));
    await sleep(3000);
    if (await servedCertExpired()) break;
    if (attempt >= 2) throw new Error("Scenario 1 fault was not live (no LLM was called)");
    console.log("INJECT retry: certificate still valid");
  }
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
  let announced = false;
  let postmortemMarkdown: string | undefined;
  for (;;) {
    if (stop || Date.now() > deadline) throw new Error("Sandbox wait ended");
    const snap = await runtime.graph.getState({ configurable: { thread_id: incidentId } });
    const state = snap.values as GraphState;
    const approval = state.approvalId ? await runtime.approvals?.get(state.approvalId) : undefined;
    if (approval?.notifiedAt && approval.status === "pending" && !announced) {
      announced = true;
      console.log(
        `READY incident=${incidentId} runbook=${approval.runbookId} cost=${state.costUsd.toFixed(6)}`,
      );
      if (auto) {
        const login = await fetch(`${webOrigin}/api/session`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: webOrigin },
          body: JSON.stringify({ password: adminPassword }),
        });
        const cookie = login.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
        const callbacks = createApprovalCallbacks(secret);
        const decision = await fetch(`${webOrigin}/api/incidents/${incidentId}/approval`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: webOrigin, cookie },
          body: JSON.stringify({ token: callbacks.encode(approval.id, "a") }),
        });
        console.log(`WEB_APPROVE status=${decision.status}`);
      } else {
        console.log("WAITING for Approve in the web UI");
        await notify(
          `[SANDBOX] IncidentPulse: Approve tayyor. ${webOrigin}/incidents/${incidentId} (parol: ${adminPassword})`,
        );
      }
    }
    if (state.recovery?.ok && state.workflowStatus === "recovered") {
      const pm = await runtime.journal.postmortem(incidentId);
      if (pm?.markdown) {
        postmortemMarkdown = pm.markdown;
        break;
      }
      if (pm && pm.micro > 0 && !pm.markdown) throw new Error("Postmortem generation failed");
    }
    if (state.reportSent || state.escalation || (state.workflowStatus && !state.recovery?.ok)) {
      throw new Error(
        `Sandbox ended: ${state.escalation?.reason ?? state.workflowStatus ?? "no proposal"}`,
      );
    }
    if ((await queue.getJobState(incidentId)) === "failed") throw new Error("Sandbox job failed");
    await sleep(1000);
  }

  // One "Ask this incident" question through the web API (streamText, evidence only).
  const login = await fetch(`${webOrigin}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: webOrigin },
    body: JSON.stringify({ password: adminPassword }),
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const answer = await fetch(`${webOrigin}/api/incidents/${incidentId}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: webOrigin, cookie },
    body: JSON.stringify({ question: "Which evidence shows the root cause?" }),
  });
  const chat = { status: answer.status, answer: (await answer.text()).slice(0, 400) };
  await sleep(2500);

  const snap = await runtime.graph.getState({ configurable: { thread_id: incidentId } });
  const state = snap.values as GraphState;
  const stored = await runtime.journal.get(incidentId);
  const events = await runtime.journal.events(incidentId, "0", 500);
  const approval = state.approvalId ? await runtime.approvals?.get(state.approvalId) : undefined;
  const audit = await pool.query<{ event: string }>(
    `SELECT event FROM "${name}".incidentpulse_action_audit WHERE approval_id=$1 ORDER BY seq`,
    [approval?.id],
  );
  if (
    state.remediation?.runbookId !== "certbot_renew" ||
    !state.execution?.ok ||
    !audit.rows.some((event) => event.event === "execution_finished")
  ) {
    throw new Error("Sandbox recovered without the expected approved execution");
  }
  row = {
    scenario,
    incidentId,
    got: state.category,
    runbook: state.remediation?.runbookId,
    approval: state.approval?.status,
    approvedBy: approval?.decidedBy,
    execution: state.execution?.ok,
    recovery: state.recovery,
    investigationCostUsd: state.costUsd,
    incidentCostUsd: stored?.cost,
    audit: audit.rows.map((event) => event.event),
    eventKinds: [...new Set(events.map((event) => event.type))],
    postmortemChars: postmortemMarkdown?.length,
    postmortemMarkdown,
    chat,
  };
  console.log(`RECOVERED cost=${stored?.cost.toFixed(6)} approvedBy=${approval?.decidedBy}`);
} finally {
  const totalCostUsd = await runtime?.weeklyBudget.spentUsd(new Date());
  await writeFile(
    join(sandbox, "results/phase5.json"),
    `${JSON.stringify(
      {
        model: config.model,
        debateModel: "gpt-5.4-nano",
        postmortemModel: "gpt-5.4-nano",
        totalCostUsd,
        results: [row],
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
  postmortem.kill();
  web.kill();
  sand("down");
}
