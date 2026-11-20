import { type ProjectId, ProjectIdSchema } from "@incidentpulse/schemas";
import { z } from "zod";

/**
 * Typed configuration. Pure: it parses an env object and never reads files, so secrets come
 * only from the process environment (Node loads .env via --env-file). Errors name the
 * offending variables but never echo values.
 */

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const price = z.coerce.number().nonnegative();

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.4-mini"),
  /** USD per 1M tokens. Required when OPENAI_MODEL is not in KNOWN_PRICING. */
  MODEL_PRICE_INPUT_PER_M: price.optional(),
  MODEL_PRICE_CACHED_INPUT_PER_M: price.optional(),
  MODEL_PRICE_OUTPUT_PER_M: price.optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().regex(/^-?\d+$/, "must be a numeric chat id"),
  WEBHOOK_HMAC_SECRET: z.string().min(32),
  DATABASE_URL: z
    .string()
    .default("postgres://incidentpulse:incidentpulse_dev@127.0.0.1:5432/incidentpulse"),
  REDIS_URL: z.string().default("redis://:incidentpulse_dev@127.0.0.1:6379"),
  INTAKE_HOST: z.string().default("127.0.0.1"),
  INTAKE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Hard stop per incident (SPEC §8). */
  INCIDENT_BUDGET_USD: z.coerce.number().positive().default(0.5),
  WEEKLY_BUDGET_USD: z.coerce.number().positive().default(0.5),
  INVESTIGATE_MODE: z.enum(["on_change", "weekly"]).default("on_change"),
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .default("")
    .transform((raw, ctx) => {
      const ids = raw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
        ctx.addIssue({
          code: "custom",
          message: "must contain comma-separated positive Telegram user IDs",
        });
        return z.NEVER;
      }
      return new Set(ids.map(Number));
    }),
  /** Optional JSON overriding PROJECT_DOMAINS, e.g. {"gotrip":["gotrip.uz"]}. */
  PROJECT_DOMAINS_JSON: z.string().optional(),
  /** Container name prefixes docker_ps/docker_logs may see per project, e.g. {"gotrip":["ipsb-a-"]}. */
  PROJECT_CONTAINERS_JSON: z.string().optional(),
  /** CodeTrail HTTP API (search/explain). Unset = the code specialist's tools say "not_configured". */
  CODETRAIL_BASE_URL: z.string().url().optional(),
  CODETRAIL_API_KEY: z.string().min(1).optional(),
  /** Our project id -> CodeTrail project_id, e.g. {"kervan":"kervan"} (identity when absent). */
  CODETRAIL_PROJECT_IDS_JSON: z.string().optional(),
  /** Fine-grained, READ-ONLY GitHub token (Contents + Metadata: read) for git_recent_commits. */
  GITHUB_READONLY_TOKEN: z.string().min(1).optional(),
  /** Our project id -> "owner/repo", e.g. {"kervan":"acme/kervan"}. */
  PROJECT_REPOS_JSON: z.string().optional(),
  /** "strip" removes injection-looking lines from tool output; "mark" only flags them. */
  INJECTION_MODE: z.enum(["strip", "mark"]).default("strip"),
});

type Env = z.infer<typeof EnvSchema>;

function parse<K extends keyof Env>(source: NodeJS.ProcessEnv, keys: readonly K[]): Pick<Env, K> {
  const shape = Object.fromEntries(keys.map((k) => [k, EnvSchema.shape[k]])) as Pick<
    typeof EnvSchema.shape,
    K
  >;
  const result = z.object(shape).safeParse(source);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`.replace(/\s+/g, " ")),
    );
  }
  return result.data as Pick<Env, K>;
}

// ---------------------------------------------------------------- projects

/** Domains each project serves. Only Kervan is known (SPEC §6, §13); override via env. */
export const DEFAULT_PROJECT_DOMAINS: Record<ProjectId, string[]> = {
  gotrip: [],
  kervan: ["kervan.uz"],
  "camera-studio": [],
  codetrail: [],
  findit: [],
  "food-lens": [],
};

function parseJson(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError([`${name}: not valid JSON`]);
  }
}

export function resolveProjectDomains(overrideJson?: string): Record<ProjectId, string[]> {
  if (!overrideJson) return structuredClone(DEFAULT_PROJECT_DOMAINS);
  const schema = z.partialRecord(ProjectIdSchema, z.array(z.string().min(1)));
  const result = schema.safeParse(parseJson("PROJECT_DOMAINS_JSON", overrideJson));
  if (!result.success) throw new ConfigError(["PROJECT_DOMAINS_JSON: wrong shape"]);
  return { ...structuredClone(DEFAULT_PROJECT_DOMAINS), ...result.data } as Record<
    ProjectId,
    string[]
  >;
}

/** Container name prefixes per project. Nothing is inspectable unless the operator lists it. */
export function resolveProjectContainers(json?: string): Record<ProjectId, string[]> {
  const empty = Object.fromEntries(
    ProjectIdSchema.options.map((p) => [p, [] as string[]]),
  ) as Record<ProjectId, string[]>;
  if (!json) return empty;
  const schema = z.partialRecord(ProjectIdSchema, z.array(z.string().min(1)));
  const result = schema.safeParse(parseJson("PROJECT_CONTAINERS_JSON", json));
  if (!result.success) throw new ConfigError(["PROJECT_CONTAINERS_JSON: wrong shape"]);
  return { ...empty, ...result.data } as Record<ProjectId, string[]>;
}

/** A JSON object of string -> string (project id -> CodeTrail id / "owner/repo"). */
export function resolveStringMap(name: string, json?: string): Record<string, string> | undefined {
  if (!json) return undefined;
  const result = z.record(z.string(), z.string()).safeParse(parseJson(name, json));
  if (!result.success) throw new ConfigError([`${name}: wrong shape`]);
  return result.data;
}

// ----------------------------------------------------------------- pricing

export interface ModelPricing {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

/** Standard API pricing, USD per 1M tokens, checked 2026-11-21 (developers.openai.com/api/docs/pricing). */
export const KNOWN_PRICING: Record<string, ModelPricing> = {
  "gpt-5.4-mini": { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 },
  "gpt-5.4-nano": { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.25 },
};

/** Fails closed: an unknown model without explicit prices would make the budget meaningless. */
export function resolvePricing(
  model: string,
  overrides: { input?: number; cachedInput?: number; output?: number } = {},
): ModelPricing {
  const known = KNOWN_PRICING[model];
  const inputPerM = overrides.input ?? known?.inputPerM;
  const outputPerM = overrides.output ?? known?.outputPerM;
  if (inputPerM === undefined || outputPerM === undefined) {
    throw new ConfigError([
      `OPENAI_MODEL "${model}" has no known price; set MODEL_PRICE_INPUT_PER_M and MODEL_PRICE_OUTPUT_PER_M`,
    ]);
  }
  return {
    inputPerM,
    outputPerM,
    cachedInputPerM: overrides.cachedInput ?? known?.cachedInputPerM ?? inputPerM,
  };
}

// ------------------------------------------------------------- app configs

export function loadIntakeConfig(source: NodeJS.ProcessEnv = process.env) {
  const c = parse(source, [
    "WEBHOOK_HMAC_SECRET",
    "REDIS_URL",
    "INTAKE_HOST",
    "INTAKE_PORT",
  ] as const);
  return {
    hmacSecret: c.WEBHOOK_HMAC_SECRET,
    redisUrl: c.REDIS_URL,
    host: c.INTAKE_HOST,
    port: c.INTAKE_PORT,
  };
}

export function loadSimulateConfig(source: NodeJS.ProcessEnv = process.env) {
  const c = parse(source, ["WEBHOOK_HMAC_SECRET", "INTAKE_HOST", "INTAKE_PORT"] as const);
  return { hmacSecret: c.WEBHOOK_HMAC_SECRET, host: c.INTAKE_HOST, port: c.INTAKE_PORT };
}

export function loadOrchestratorConfig(source: NodeJS.ProcessEnv = process.env) {
  const c = parse(source, [
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "MODEL_PRICE_INPUT_PER_M",
    "MODEL_PRICE_CACHED_INPUT_PER_M",
    "MODEL_PRICE_OUTPUT_PER_M",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "DATABASE_URL",
    "REDIS_URL",
    "INCIDENT_BUDGET_USD",
    "WEEKLY_BUDGET_USD",
    "INVESTIGATE_MODE",
    "TELEGRAM_ALLOWED_USER_IDS",
    "PROJECT_DOMAINS_JSON",
    "PROJECT_CONTAINERS_JSON",
    "CODETRAIL_BASE_URL",
    "CODETRAIL_API_KEY",
    "CODETRAIL_PROJECT_IDS_JSON",
    "GITHUB_READONLY_TOKEN",
    "PROJECT_REPOS_JSON",
    "INJECTION_MODE",
  ] as const);
  const overrides: { input?: number; cachedInput?: number; output?: number } = {};
  if (c.MODEL_PRICE_INPUT_PER_M !== undefined) overrides.input = c.MODEL_PRICE_INPUT_PER_M;
  if (c.MODEL_PRICE_CACHED_INPUT_PER_M !== undefined) {
    overrides.cachedInput = c.MODEL_PRICE_CACHED_INPUT_PER_M;
  }
  if (c.MODEL_PRICE_OUTPUT_PER_M !== undefined) overrides.output = c.MODEL_PRICE_OUTPUT_PER_M;
  return {
    openaiApiKey: c.OPENAI_API_KEY,
    model: c.OPENAI_MODEL,
    pricing: resolvePricing(c.OPENAI_MODEL, overrides),
    telegramBotToken: c.TELEGRAM_BOT_TOKEN,
    telegramChatId: c.TELEGRAM_CHAT_ID,
    databaseUrl: c.DATABASE_URL,
    redisUrl: c.REDIS_URL,
    budgetUsd: c.INCIDENT_BUDGET_USD,
    weeklyBudgetUsd: c.WEEKLY_BUDGET_USD,
    investigateMode: c.INVESTIGATE_MODE,
    telegramAllowedUserIds: c.TELEGRAM_ALLOWED_USER_IDS,
    projectDomains: resolveProjectDomains(c.PROJECT_DOMAINS_JSON),
    projectContainers: resolveProjectContainers(c.PROJECT_CONTAINERS_JSON),
    codetrail: {
      baseUrl: c.CODETRAIL_BASE_URL,
      apiKey: c.CODETRAIL_API_KEY,
      projectIds: resolveStringMap("CODETRAIL_PROJECT_IDS_JSON", c.CODETRAIL_PROJECT_IDS_JSON),
      githubToken: c.GITHUB_READONLY_TOKEN,
      repos: resolveStringMap("PROJECT_REPOS_JSON", c.PROJECT_REPOS_JSON),
    },
    injectionMode: c.INJECTION_MODE,
  };
}

export type IntakeConfig = ReturnType<typeof loadIntakeConfig>;
export type OrchestratorConfig = ReturnType<typeof loadOrchestratorConfig>;
