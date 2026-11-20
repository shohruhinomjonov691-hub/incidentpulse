import { loadOrchestratorConfig } from "@incidentpulse/config";
import { collectSecrets, createRedactor, describeError } from "@incidentpulse/redact";
import { createInvestigationBot, createTelegramNotifier } from "@incidentpulse/telegram-bot";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { OpenAIProvider } from "@openai/agents";
import { Redis } from "ioredis";
import { configureAgentsSdk, limitModelSpend } from "./agents/sdk.ts";
import { createSpecialists } from "./agents/specialists.ts";
import { createSynthesizer } from "./agents/synthesizer.ts";
import { createTriage } from "./agents/triage.ts";
import { buildIncidentGraph } from "./graph.ts";
import { createInvestigationPolicy } from "./investigation-policy.ts";
import { createLogger } from "./log.ts";
import { createPrimaryProbe } from "./primary-evidence.ts";
import { createRedisWeeklyBudget } from "./weekly-budget.ts";
import { createIncidentWorker } from "./worker.ts";

const config = loadOrchestratorConfig(process.env);

// Every secret in the environment is masked in logs and outgoing messages.
const redact = createRedactor({ secrets: collectSecrets(process.env) });
const log = createLogger(redact);

configureAgentsSdk(config.openaiApiKey);

const checkpointer = PostgresSaver.fromConnString(config.databaseUrl);
await checkpointer.setup();

const notifier = createTelegramNotifier({
  token: config.telegramBotToken,
  chatId: config.telegramChatId,
  redact,
});

const redis = new Redis(config.redisUrl);
const weeklyBudget = createRedisWeeklyBudget(redis);
const provider = new OpenAIProvider();
const model = limitModelSpend(await provider.getModel(config.model), {
  budget: weeklyBudget,
  limitUsd: config.weeklyBudgetUsd,
  pricing: config.pricing,
});

const agentOptions = {
  model,
  pricing: config.pricing,
  redact,
  injectionMode: config.injectionMode,
  reasoningEffort: "low",
  resources: {
    domains: config.projectDomains,
    containers: config.projectContainers,
    codetrail: config.codetrail,
  },
} as const;

const graph = buildIncidentGraph({
  triage: createTriage(agentOptions),
  specialists: createSpecialists(agentOptions),
  synthesizer: createSynthesizer({
    model,
    pricing: config.pricing,
    redact,
    reasoningEffort: "low",
  }),
  notifier,
  redact,
  budgetUsd: config.budgetUsd,
  weeklyBudgetUsd: config.weeklyBudgetUsd,
  weeklyBudget,
  requestPricing: config.pricing,
  checkpointer,
});

const investigations = createInvestigationPolicy({
  redis,
  graph,
  notifier,
  redact,
  mode: config.investigateMode,
  probe: createPrimaryProbe(agentOptions),
});
const worker = await createIncidentWorker({
  redisUrl: config.redisUrl,
  investigations,
  investigateMode: config.investigateMode,
  notifier,
  redact,
  log,
});
log.info("orchestrator ready", {
  model: config.model,
  budgetUsd: config.budgetUsd,
  weeklyBudgetUsd: config.weeklyBudgetUsd,
  investigateMode: config.investigateMode,
  injectionMode: config.injectionMode,
  codetrail: config.codetrail.baseUrl ? "configured" : "not_configured",
  github: config.codetrail.githubToken ? "configured" : "not_configured",
});

const bot =
  config.telegramAllowedUserIds.size > 0
    ? createInvestigationBot({
        token: config.telegramBotToken,
        chatId: config.telegramChatId,
        allowedUsers: config.telegramAllowedUserIds,
        enqueue: worker.enqueueManual,
        redact,
        onError: (error) => log.error("Telegram command failed", { error }),
      })
    : undefined;
void bot
  ?.start({ allowed_updates: ["message"] })
  .catch((error) => log.error("Telegram polling failed", { error: describeError(error, redact) }));

const shutdown = async () => {
  await bot?.stop();
  await worker.close();
  await checkpointer.end();
  await provider.close();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
