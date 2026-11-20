import { loadOrchestratorConfig } from "@incidentpulse/config";
import { collectSecrets, createRedactor } from "@incidentpulse/redact";
import { createTelegramNotifier } from "@incidentpulse/telegram-bot";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Redis } from "ioredis";
import { createInfraSpecialist } from "./agents/infra-specialist.ts";
import { configureAgentsSdk } from "./agents/sdk.ts";
import { createSynthesizer } from "./agents/synthesizer.ts";
import { createRedisDailyBudget } from "./daily-budget.ts";
import { buildIncidentGraph } from "./graph.ts";
import { createLogger } from "./log.ts";
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

const budgetRedis = new Redis(config.redisUrl);

const graph = buildIncidentGraph({
  infraSpecialist: createInfraSpecialist({
    model: config.model,
    pricing: config.pricing,
    redact,
    reasoningEffort: "low",
  }),
  synthesizer: createSynthesizer({
    model: config.model,
    pricing: config.pricing,
    redact,
    reasoningEffort: "low",
  }),
  notifier,
  redact,
  projectDomains: config.projectDomains,
  budgetUsd: config.budgetUsd,
  dailyBudgetUsd: config.dailyBudgetUsd,
  dailyBudget: createRedisDailyBudget(budgetRedis),
  checkpointer,
});

const worker = createIncidentWorker({
  redisUrl: config.redisUrl,
  graph,
  notifier,
  redact,
  log,
});
log.info("orchestrator ready", {
  model: config.model,
  budgetUsd: config.budgetUsd,
  dailyBudgetUsd: config.dailyBudgetUsd,
});

const shutdown = async () => {
  await worker.close();
  await checkpointer.end();
  budgetRedis.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
