import type { loadOrchestratorConfig } from "@incidentpulse/config";
import {
  type ActionRunner,
  createApprovalStore,
  createSystemRunner,
  loadRunbookRegistry,
} from "@incidentpulse/mcp-actions";
import { describeError, type Redactor } from "@incidentpulse/redact";
import {
  createInvestigationBot,
  createTelegramNotifier,
  type Notifier,
} from "@incidentpulse/telegram-bot";
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
import { buildIncidentGraph } from "./graph.ts";
import { createInvestigationPolicy } from "./investigation-policy.ts";
import type { Logger } from "./log.ts";
import { createPrimaryProbe } from "./primary-evidence.ts";
import { createRecoveryCheck } from "./recovery.ts";
import { createRemediationProposer } from "./remediation-proposer.ts";
import { createRedisWeeklyBudget } from "./weekly-budget.ts";
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
}) {
  const { config, redact, log, prefix } = options;
  configureAgentsSdk(config.openaiApiKey);
  const redis = new Redis(config.redisUrl);
  const controls = createActionControls(redis, prefix);
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
    ...(options.strictBudget ? { strictBudget: true } : {}),
  });

  const agentOptions = {
    model,
    pricing: config.pricing,
    redact,
    injectionMode: config.injectionMode,
    reasoningEffort: "low",
    ...(options.childEnv ? { childEnv: options.childEnv } : {}),
    resources: {
      domains: config.projectDomains,
      containers: config.projectContainers,
      codetrail: config.codetrail,
    },
  } as const;
  const probe = createPrimaryProbe(agentOptions);
  const registry = config.actionsEnabled ? loadRunbookRegistry(config.actionScopes) : undefined;
  const pool = registry ? new Pool({ connectionString: config.databaseUrl }) : undefined;
  const approvals =
    pool && config.approvalSecret ? createApprovalStore(pool, config.approvalSecret) : undefined;
  await approvals?.setup();
  const flow =
    approvals && registry && config.approvalSecret
      ? await createActionFlow({
          approvals,
          registry,
          controls,
          run: options.actionRunner ?? createSystemRunner(config.actionExecUser ?? ""),
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
  const timer = setInterval(() => {
    void tick();
  }, 2500);
  void tick();

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
  });

  return {
    graph,
    weeklyBudget,
    approvals,
    async close() {
      clearInterval(timer);
      await ticking;
      await bot?.stop();
      await polling;
      await worker.close();
      await flow?.close();
      await pool?.end();
      await checkpointer.end();
      await provider.close();
      redis.disconnect();
    },
  };
}
