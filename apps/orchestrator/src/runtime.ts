import { writeFile } from "node:fs/promises";
import type { loadOrchestratorConfig } from "@incidentpulse/config";
import {
  type ActionRunner,
  createApprovalStore,
  createRemoteExecutor,
  createSystemRunner,
  loadRunbookRegistry,
} from "@incidentpulse/mcp-actions";
import { describeError, type Redactor } from "@incidentpulse/redact";
import { createRunnerClient } from "@incidentpulse/runner-client";
import {
  createInvestigationBot,
  createTelegramNotifier,
  type Notifier,
} from "@incidentpulse/telegram-bot";
import { langfuseEnabled, startTelemetry } from "@incidentpulse/telemetry";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { OpenAIProvider } from "@openai/agents";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { createActionControls, createActionFlow } from "./action-flow.ts";
import { configureAgentsSdk, limitModelSpend } from "./agents/sdk.ts";
import { createSpecialists } from "./agents/specialists.ts";
import { createSynthesizer } from "./agents/synthesizer.ts";
import { createTriage } from "./agents/triage.ts";
import { createContinuations } from "./continuations.ts";
import { createDebateVerifier } from "./debate.ts";
import { createDeepChecker } from "./deep-health.ts";
import { buildIncidentGraph } from "./graph.ts";
import { createHealthPoller } from "./health-poller.ts";
import { createHostInventory } from "./host-inventory.ts";
import { createInvestigationPolicy } from "./investigation-policy.ts";
import { createJournal } from "./journal.ts";
import type { Logger } from "./log.ts";
import { setTelemetry } from "./observability.ts";
import { createPostmortemWorker, postmortemLink } from "./postmortem.ts";
import { createPrimaryProbe } from "./primary-evidence.ts";
import { createRecoveryCheck } from "./recovery.ts";
import { createRemediationProposer } from "./remediation-proposer.ts";
import { createRedisWeeklyBudget, reserveWeekly } from "./weekly-budget.ts";
import { createIncidentWorker } from "./worker.ts";

export async function startRuntime(options: {
  config: ReturnType<typeof loadOrchestratorConfig>;
  redact: Redactor;
  log: Logger;
  prefix?: string;
  actionRunner?: ActionRunner;
  childEnv?: Record<string, string>;
  strictBudget?: boolean;
  noticePrefix?: string;
  webOrigin?: string;
  postmortem?: { url: string; secret: string };
}) {
  const { config, redact, log, prefix } = options;
  configureAgentsSdk(config.openaiApiKey);
  // Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both set.
  const tracing = await startTelemetry(process.env, {
    redact,
    environment: prefix ? "sandbox" : "production",
  });
  setTelemetry(tracing);
  if (tracing.enabled) log.info("langfuse tracing enabled");
  else if (langfuseEnabled(process.env)) {
    log.error("langfuse keys are set but tracing is OFF (plain-HTTP base URL or startup failure)");
  }
  const redis = new Redis(config.redisUrl);
  const controls = createActionControls(redis, prefix);
  const budgetPrefix = prefix ? `${prefix}:budget:weekly` : undefined;
  const reserve = (at: Date, usd: number) =>
    reserveWeekly(redis, at, usd, config.weeklyBudgetUsd, budgetPrefix);
  const weeklyBudget = createRedisWeeklyBudget(
    redis,
    prefix ? { keyPrefix: `${prefix}:budget:weekly` } : {},
  );
  const checkpointer = PostgresSaver.fromConnString(config.databaseUrl);
  await checkpointer.setup();
  const telegram = createTelegramNotifier({
    token: config.telegramBotToken,
    chatId: config.telegramChatId,
    redact,
  });
  const notifier: Notifier = {
    send: (text, buttons) => telegram.send(`${options.noticePrefix ?? ""}${text}`, buttons),
  };
  const provider = new OpenAIProvider();
  const model = limitModelSpend(await provider.getModel(config.model), {
    budget: weeklyBudget,
    limitUsd: config.weeklyBudgetUsd,
    pricing: config.pricing,
    reserve,
    modelName: config.model,
  });

  // Production: read-only Docker through the socket proxy, host facts and runbooks through the host runner.
  const runnerClient = config.hostRunnerSocket
    ? createRunnerClient({ socketPath: config.hostRunnerSocket })
    : undefined;
  const remote = runnerClient ? createRemoteExecutor(runnerClient) : undefined;
  const childEnv = {
    ...(config.dockerHost ? { DOCKER_HOST: config.dockerHost } : {}),
    ...(config.hostRunnerSocket ? { INFRA_HOST_RUNNER_SOCKET: config.hostRunnerSocket } : {}),
    ...options.childEnv,
  };
  const agentOptions = {
    model,
    pricing: config.pricing,
    redact,
    injectionMode: config.injectionMode,
    reasoningEffort: "low",
    ...(Object.keys(childEnv).length ? { childEnv } : {}),
    resources: {
      domains: config.projectDomains,
      containers: config.projectContainers,
      pm2: Object.fromEntries(
        Object.entries(config.projectPm2).map(([project, apps]) => [project, { apps }]),
      ),
      ...(runnerClient ? { hostRunner: true } : {}),
      codetrail: config.codetrail,
    },
  } as const;
  const probe = createPrimaryProbe(agentOptions);
  const registry = config.actionsEnabled
    ? loadRunbookRegistry(config.actionScopes, undefined, { remote: Boolean(remote) })
    : undefined;
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 2000,
    query_timeout: 3000,
  });
  const journal = createJournal(pool);
  await journal.setup();
  const approvals =
    registry && config.approvalSecret
      ? createApprovalStore(pool, config.approvalSecret)
      : undefined;
  await approvals?.setup();
  const flow =
    approvals && registry && config.approvalSecret
      ? await createActionFlow({
          approvals,
          registry,
          controls,
          ...(remote
            ? { remote }
            : { run: options.actionRunner ?? createSystemRunner(config.actionExecUser ?? "") }),
          redact,
          notifier,
          callbackSecret: config.approvalSecret,
        })
      : undefined;

  const graph = buildIncidentGraph({
    triage: createTriage(agentOptions),
    specialists: createSpecialists(agentOptions),
    synthesizer: createSynthesizer(agentOptions),
    notifier,
    redact,
    budgetUsd: config.budgetUsd,
    weeklyBudgetUsd: config.weeklyBudgetUsd,
    weeklyBudget,
    reserveWeekly: reserve,
    journal,
    postmortemUrl: (id) => postmortemLink(options.webOrigin ?? process.env.WEB_ORIGIN, id),
    onJournalError: (error) =>
      log.error("incident journal failed", { error: describeError(error, redact) }),
    requestPricing: config.pricing,
    checkpointer,
    controls,
    debate: {
      mode: config.debateMode,
      ...(config.debateSecret
        ? {
            client: createDebateVerifier(
              config.debateUrl,
              config.debateSecret,
              config.debateTimeoutMs,
            ),
          }
        : {}),
    },
    ...(flow && registry
      ? {
          actions: {
            flow,
            propose: createRemediationProposer({
              registry,
              model,
              pricing: config.pricing,
              redact,
              ...(runnerClient
                ? { inventory: createHostInventory(runnerClient, config.actionScopes) }
                : {}),
            }),
            recover: createRecoveryCheck(probe),
          },
        }
      : {}),
  });

  const investigations = createInvestigationPolicy({
    redis,
    graph,
    notifier,
    redact,
    mode: config.investigateMode,
    probe,
    ...(prefix ? { prefix: `${prefix}:investigation` } : {}),
    ...(approvals ? { closeApproval: approvals.closeForRecovery } : {}),
  });
  const healthPoller = config.healthPoll.enabled
    ? createHealthPoller({
        redis,
        targets: config.healthPoll.targets,
        allowedHosts: config.projectDomains,
        notifier,
        redact,
        log,
        monitor: investigations.monitor,
        ...(config.healthPoll.deep.intervalMinutes > 0
          ? {
              deep: createDeepChecker({
                allowedHosts: config.projectDomains,
                apis: config.healthPoll.deep.apis,
              }),
            }
          : {}),
        ...(prefix ? { prefix: `${prefix}:health` } : {}),
      })
    : undefined;
  const continuations = createContinuations({
    graph,
    controls,
    ...(flow ? { flow } : {}),
    policy: investigations,
  });
  const worker = await createIncidentWorker({
    redisUrl: config.redisUrl,
    investigations,
    investigateMode: config.investigateMode,
    notifier,
    redact,
    log,
    onResume: continuations.resume,
    ...(healthPoller ? { healthPoller } : {}),
    healthDeepEveryMinutes: config.healthPoll.deep.intervalMinutes,
    ...(prefix ? { queueName: prefix } : {}),
  });

  let ticking: Promise<void> | undefined;
  const tick = () => {
    ticking ??= continuations
      .tick(worker.enqueueResume)
      .catch((error) =>
        log.error("approval reconciliation failed", { error: describeError(error, redact) }),
      )
      .finally(() => {
        ticking = undefined;
      });
    return ticking;
  };
  // Liveness for the container healthcheck: touched at most every 30 s while the event loop is alive.
  const heartbeatFile = process.env.HEARTBEAT_FILE;
  let lastBeat = 0;
  const beat = () => {
    if (!heartbeatFile || Date.now() - lastBeat < 30_000) return;
    lastBeat = Date.now();
    void writeFile(heartbeatFile, `${lastBeat}\n`).catch(() => undefined);
  };
  const timer = setInterval(() => {
    beat();
    void tick();
  }, 2500);
  beat();
  void tick();

  const postmortemConfig = options.postmortem ?? {
    url: process.env.POSTMORTEM_URL,
    secret: process.env.POSTMORTEM_SHARED_SECRET,
  };
  const generate =
    postmortemConfig.url && (postmortemConfig.secret?.length ?? 0) >= 32
      ? createPostmortemWorker({
          journal,
          redact,
          reserve,
          release: (at, usd) => weeklyBudget.releaseUsd(usd, at),
          url: postmortemConfig.url,
          secret: postmortemConfig.secret as string,
        })
      : undefined;
  let generating: Promise<void> | undefined;
  const postmortemTimer =
    generate &&
    setInterval(() => {
      generating ??= generate()
        .catch((error) =>
          log.error("postmortem generation failed", { error: describeError(error, redact) }),
        )
        .finally(() => {
          generating = undefined;
        });
    }, 2500);

  const bot = config.telegramAllowedUserIds.size
    ? createInvestigationBot({
        token: config.telegramBotToken,
        chatId: config.telegramChatId,
        allowedUsers: config.telegramAllowedUserIds,
        enqueue: worker.enqueueManual,
        redact,
        onError: (error) => log.error("Telegram update failed", { error }),
        controls: {
          setStopped: controls.setStopped,
          async status() {
            const stopped = await controls.isStopped();
            const paused = (await controls.pausedIncidents()).length;
            const spent = await weeklyBudget.spentUsd(new Date());
            return (
              `Tergovlar: ${stopped ? "to‘xtatilgan" : "faol"} · pauzada ${paused}\n` +
              `Haftalik xarajat: $${spent.toFixed(4)} / $${config.weeklyBudgetUsd.toFixed(2)}`
            );
          },
          callback: flow?.callback ?? (async () => ({ answer: "Tuzatish amallari o‘chiq." })),
        },
      })
    : undefined;
  const polling = bot
    ?.start({ allowed_updates: ["message", "callback_query"] })
    .catch((error) =>
      log.error("Telegram polling failed", { error: describeError(error, redact) }),
    );

  log.info("orchestrator ready", {
    model: config.model,
    weeklyBudgetUsd: config.weeklyBudgetUsd,
    investigateMode: config.investigateMode,
    debateMode: config.debateMode,
    actionsEnabled: config.actionsEnabled,
    hostRunner: Boolean(runnerClient),
    healthPoll: config.healthPoll.enabled,
    healthDeepEveryMinutes: config.healthPoll.enabled ? config.healthPoll.deep.intervalMinutes : 0,
    healthDeepApis: Object.values(config.healthPoll.deep.apis).reduce(
      (n, t) => n + t.api.length,
      0,
    ),
  });

  return {
    graph,
    weeklyBudget,
    approvals,
    journal,
    async close() {
      clearInterval(timer);
      if (postmortemTimer) clearInterval(postmortemTimer);
      await ticking;
      await generating;
      await bot?.stop();
      await polling;
      await worker.close();
      await flow?.close();
      await pool.end();
      await checkpointer.end();
      await provider.close();
      redis.disconnect();
      await tracing.shutdown();
    },
  };
}
