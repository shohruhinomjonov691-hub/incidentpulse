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
  DEBATE_MODE: z.enum(["auto", "always", "off"]).default("auto"),
  DEBATE_URL: z.url().default("http://127.0.0.1:8790"),
  DEBATE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(32_000),
  DEBATE_SHARED_SECRET: z.string().min(32).optional(),
  ACTION_EXEC_USER: z.string().min(1).optional(),
  ACTIONS_ENABLED: z.enum(["true", "false"]).default("false"),
  /**
   * Signs the execution token and the plan MAC. Held by the orchestrator and the host runner ONLY: the web UI
   * never receives it, so a compromised web process cannot mint execution tokens.
   */
  APPROVAL_HMAC_SECRET: z.string().min(32).optional(),
  /** Signs the Approve/Reject buttons (Telegram and web). Must differ from APPROVAL_HMAC_SECRET. */
  CALLBACK_HMAC_SECRET: z.string().min(32).optional(),
  PROJECT_ACTION_SCOPES_JSON: z.string().optional(),
  /** Unix socket of the host actions runner (production). Replaces ACTION_EXEC_USER/sudo from a container. */
  HOST_RUNNER_SOCKET: z
    .string()
    .regex(/^\/[A-Za-z0-9_./-]+$/, "must be an absolute socket path")
    .optional(),
  /** Read-only Docker API, e.g. tcp://docker-proxy:2375 (docker-socket-proxy: container GET only). */
  DOCKER_HOST: z
    .string()
    .regex(/^(tcp|unix):\/\/\S+$/, "must be tcp://... or unix://...")
    .optional(),
  /**
   * The docker-read-adapter (containers list + allowlisted logs only), e.g. http://docker-read-adapter:2376.
   * Preferred over DOCKER_HOST: the orchestrator never gets a path to the Docker socket proxy itself.
   */
  DOCKER_READ_ADAPTER_URL: z
    .string()
    .regex(/^http:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, "must be http://host[:port]")
    .optional(),
  /** "false" in production: tables come from the one-shot migrate service, the runtime role has no DDL rights. */
  DB_AUTO_MIGRATE: z.enum(["true", "false"]).default("true"),
  /** Project id -> pm2 apps on the host, e.g. {"kervan":["KERVAN","KERVAN-REACT"]}. */
  PROJECT_PM2_JSON: z.string().optional(),
  /** LLM-free health poller (every 15 minutes). Off by default. */
  HEALTH_POLL_ENABLED: z.enum(["true", "false"]).default("false"),
  /** Project id -> full URLs to poll; default: https://<domain>/ for each PROJECT_DOMAINS_JSON entry. */
  HEALTH_POLL_URLS_JSON: z.string().optional(),
  /**
   * LLM-free deep health: per project the API URLs to GET and the statuses that count as healthy, e.g.
   * {"kervan":{"api":["https://kervan.uz:8443/<endpoint>"],"expect":[200,401]}}. Empty = mixed-content check only.
   */
  HEALTH_DEEP_JSON: z.string().optional(),
  /** Minutes between deep checks (the plain poll stays at 15). 0 turns the deep check off. */
  HEALTH_DEEP_INTERVAL_MIN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(0).max(1440).default(60),
  ),
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

/** Pm2 apps per project; empty unless the operator lists them. */
export function resolveProjectPm2(json?: string): Partial<Record<ProjectId, string[]>> {
  if (!json) return {};
  const schema = z.partialRecord(
    ProjectIdSchema,
    z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,126}$/)),
  );
  const result = schema.safeParse(parseJson("PROJECT_PM2_JSON", json));
  if (!result.success) throw new ConfigError(["PROJECT_PM2_JSON: wrong shape"]);
  return result.data as Partial<Record<ProjectId, string[]>>;
}

const hostOf = (domain: string) => new URL(`https://${domain}`).hostname;

/**
 * URLs the health poller probes. Every URL must stay inside its project's domain allowlist (the
 * poller is an SSRF surface otherwise); the default is the root page of each configured domain.
 */
export function resolveHealthTargets(
  json: string | undefined,
  domains: Record<ProjectId, string[]>,
): Partial<Record<ProjectId, string[]>> {
  const targets: Partial<Record<ProjectId, string[]>> = {};
  if (!json) {
    for (const project of ProjectIdSchema.options) {
      if (domains[project].length > 0) {
        targets[project] = domains[project].map((d) => `https://${new URL(`https://${d}`).host}/`);
      }
    }
    return targets;
  }
  const parsed = z
    .partialRecord(ProjectIdSchema, z.array(z.string().min(1).max(2048)))
    .safeParse(parseJson("HEALTH_POLL_URLS_JSON", json));
  if (!parsed.success) throw new ConfigError(["HEALTH_POLL_URLS_JSON: wrong shape"]);
  for (const [project, urls] of Object.entries(parsed.data) as Array<[ProjectId, string[]]>) {
    const allowed = domains[project].map(hostOf);
    for (const raw of urls) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new ConfigError([`HEALTH_POLL_URLS_JSON: invalid URL for ${project}`]);
      }
      const inside = allowed.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || !inside) {
        throw new ConfigError([
          `HEALTH_POLL_URLS_JSON: ${project} URL is outside its domain allowlist`,
        ]);
      }
    }
    targets[project] = urls;
  }
  return targets;
}

export interface DeepApiTarget {
  api: string[];
  /** HTTP statuses that count as healthy. */
  expect: number[];
}

/**
 * HEALTH_DEEP_JSON. An API URL must stay inside its project's domains (host or subdomain, any port:
 * `kervan.uz:8443` is fine for `kervan.uz`), because the deep check is an SSRF surface otherwise.
 * An invalid entry stops the start; error messages name the project, never the URL.
 */
export function resolveHealthDeep(
  json: string | undefined,
  domains: Record<ProjectId, string[]>,
): Partial<Record<ProjectId, DeepApiTarget>> {
  if (!json) return {};
  const parsed = z
    .partialRecord(
      ProjectIdSchema,
      z.strictObject({
        api: z.array(z.string().min(1).max(2048)).max(10),
        expect: z.array(z.number().int().min(100).max(599)).min(1).max(20).optional(),
      }),
    )
    .safeParse(parseJson("HEALTH_DEEP_JSON", json));
  if (!parsed.success) throw new ConfigError(["HEALTH_DEEP_JSON: wrong shape"]);
  const targets: Partial<Record<ProjectId, DeepApiTarget>> = {};
  for (const [project, entry] of Object.entries(parsed.data) as Array<
    [ProjectId, { api: string[]; expect?: number[] }]
  >) {
    const allowed = domains[project].map(hostOf);
    for (const raw of entry.api) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new ConfigError([`HEALTH_DEEP_JSON: invalid API URL for ${project}`]);
      }
      const inside = allowed.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || !inside) {
        throw new ConfigError([`HEALTH_DEEP_JSON: ${project} API URL is outside its domains`]);
      }
    }
    targets[project] = { api: entry.api, expect: entry.expect ?? [200] };
  }
  return targets;
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
    "DEBATE_MODE",
    "DEBATE_URL",
    "DEBATE_TIMEOUT_MS",
    "DEBATE_SHARED_SECRET",
    "ACTIONS_ENABLED",
    "ACTION_EXEC_USER",
    "APPROVAL_HMAC_SECRET",
    "CALLBACK_HMAC_SECRET",
    "PROJECT_ACTION_SCOPES_JSON",
    "HOST_RUNNER_SOCKET",
    "DOCKER_HOST",
    "DOCKER_READ_ADAPTER_URL",
    "DB_AUTO_MIGRATE",
    "PROJECT_PM2_JSON",
    "HEALTH_POLL_ENABLED",
    "HEALTH_POLL_URLS_JSON",
    "HEALTH_DEEP_JSON",
    "HEALTH_DEEP_INTERVAL_MIN",
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
  const actionsEnabled = c.ACTIONS_ENABLED === "true";
  if (
    actionsEnabled &&
    (!c.APPROVAL_HMAC_SECRET || !c.CALLBACK_HMAC_SECRET || !c.TELEGRAM_ALLOWED_USER_IDS.size)
  ) {
    throw new ConfigError([
      "ACTIONS_ENABLED requires APPROVAL_HMAC_SECRET, CALLBACK_HMAC_SECRET and TELEGRAM_ALLOWED_USER_IDS",
    ]);
  }
  if (c.APPROVAL_HMAC_SECRET && c.APPROVAL_HMAC_SECRET === c.CALLBACK_HMAC_SECRET) {
    throw new ConfigError(["CALLBACK_HMAC_SECRET must differ from APPROVAL_HMAC_SECRET"]);
  }
  const scope = z.strictObject({
    containers: z.array(z.string()).optional(),
    pm2: z.array(z.string()).optional(),
    compose: z.strictObject({ name: z.string(), file: z.string() }).optional(),
    nginx: z.boolean().optional(),
    webroot: z.string().optional(),
    /** Certificates and vhosts also cover www.<domain>. */
    www: z.boolean().optional(),
  });
  const projectDomains = resolveProjectDomains(c.PROJECT_DOMAINS_JSON);
  const parsedScopes = c.PROJECT_ACTION_SCOPES_JSON
    ? z
        .partialRecord(ProjectIdSchema, scope)
        .safeParse(parseJson("PROJECT_ACTION_SCOPES_JSON", c.PROJECT_ACTION_SCOPES_JSON))
    : undefined;
  if (parsedScopes && !parsedScopes.success)
    throw new ConfigError(["PROJECT_ACTION_SCOPES_JSON: wrong shape"]);
  return {
    debateMode: c.DEBATE_MODE,
    debateUrl: c.DEBATE_URL,
    debateTimeoutMs: c.DEBATE_TIMEOUT_MS,
    debateSecret: c.DEBATE_SHARED_SECRET,
    actionsEnabled,
    actionExecUser: c.ACTION_EXEC_USER,
    hostRunnerSocket: c.HOST_RUNNER_SOCKET,
    dockerHost: c.DOCKER_HOST,
    dockerReadAdapterUrl: c.DOCKER_READ_ADAPTER_URL,
    dbAutoMigrate: c.DB_AUTO_MIGRATE === "true",
    projectPm2: resolveProjectPm2(c.PROJECT_PM2_JSON),
    healthPoll: {
      enabled: c.HEALTH_POLL_ENABLED === "true",
      targets:
        c.HEALTH_POLL_ENABLED === "true"
          ? resolveHealthTargets(c.HEALTH_POLL_URLS_JSON, projectDomains)
          : {},
      deep: {
        intervalMinutes: c.HEALTH_DEEP_INTERVAL_MIN,
        apis:
          c.HEALTH_POLL_ENABLED === "true"
            ? resolveHealthDeep(c.HEALTH_DEEP_JSON, projectDomains)
            : {},
      },
    },
    approvalSecret: c.APPROVAL_HMAC_SECRET,
    callbackSecret: c.CALLBACK_HMAC_SECRET,
    actionScopes: Object.fromEntries(
      Object.entries(parsedScopes?.data ?? {}).map(([project, settings]) => [
        project,
        { ...settings, domains: projectDomains[project as ProjectId] },
      ]),
    ),
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
    projectDomains,
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
