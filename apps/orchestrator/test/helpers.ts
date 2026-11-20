import { createRedactor } from "@incidentpulse/redact";
import type { Category, Evidence, IncidentJob } from "@incidentpulse/schemas";
import type { Notifier } from "@incidentpulse/telegram-bot";
import { MemorySaver } from "@langchain/langgraph";
import { buildIncidentGraph, type GraphDeps } from "../src/graph.ts";
import {
  SPECIALISTS,
  type Specialist,
  type SpecialistName,
  type SpecialistResult,
  SynthesisRejectedError,
  type SynthesisResult,
  type Synthesizer,
  type Triage,
  type TriageDecision,
} from "../src/types.ts";
import { createMemoryWeeklyBudget } from "../src/weekly-budget.ts";

export const NOW = new Date("2026-11-21T04:00:10.000Z"); // 13:00 on Nov 21 in Seoul

export const job = (overrides: Partial<IncidentJob> = {}): IncidentJob => ({
  incidentId: "inc-test-1",
  project: "kervan",
  signal: {
    check: "https",
    level: "down",
    summary: "HTTPS health check failed",
    at: "2026-11-21T04:00:00.000Z",
  },
  dedupKey: "kervan:https:unknown",
  receivedAt: "2026-11-21T04:00:01.000Z",
  ...overrides,
});

const ev = (id: string, tool: string, excerpt: string, source = "mcp-infra"): Evidence => ({
  id,
  source,
  tool,
  excerpt,
  at: "2026-11-21T04:00:05.000Z",
  hash: `sha256:${id}`,
});

export const tlsMismatchEvidence = (id = "i1"): Evidence =>
  ev(
    id,
    "tls_inspect",
    "tls_inspect(kervan.uz): chainValid=false hostnameMatch=false expired=false notAfter=2027-01-13 (53d) error=ERR_TLS_CERT_ALTNAME_INVALID subject=codetrail.gotrips.cloud",
  );

export const dockerEvidence = (id = "l1"): Evidence =>
  ev(
    id,
    "docker_ps",
    "docker_ps: ipsb-a-app running (Up 2 minutes); ipsb-a-nginx running (Up 2 minutes)",
  );

export interface Tracker {
  active: number;
  maxActive: number;
}

export interface FakeSpecialist extends Specialist {
  calls: number;
}

export function fakeSpecialist(
  name: SpecialistName,
  options: {
    available?: boolean;
    costUsd?: number;
    delayMs?: number;
    evidence?: Evidence[];
    fail?: boolean;
    blockedCalls?: number;
    injectionFlags?: number;
    tracker?: Tracker;
  } = {},
): FakeSpecialist {
  const defaults: Record<SpecialistName, Evidence[]> = {
    infra: [tlsMismatchEvidence("i1")],
    logs: [dockerEvidence("l1")],
    code: [
      ev(
        "c1",
        "git_recent_commits",
        "git_recent_commits(kervan): 1 commits: 0123456 «Fix upstream port»",
        "mcp-codetrail",
      ),
    ],
  };
  const self: FakeSpecialist = {
    name,
    calls: 0,
    isAvailable: () => options.available ?? true,
    async investigate(): Promise<SpecialistResult> {
      self.calls++;
      const t = options.tracker;
      if (t) {
        t.active++;
        t.maxActive = Math.max(t.maxActive, t.active);
      }
      try {
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
        if (options.fail) throw new Error(`${name} specialist crashed`);
        const evidence = options.evidence ?? defaults[name];
        return {
          evidence,
          summary: `${name} summary`,
          costUsd: options.costUsd ?? 0.004,
          toolCalls: evidence.length,
          blockedCalls: options.blockedCalls ?? 0,
          injectionFlags: options.injectionFlags ?? 0,
        };
      } finally {
        if (t) t.active--;
      }
    },
  };
  return self;
}

export interface FakeTriage extends Triage {
  calls: number;
  lastAvailable: SpecialistName[];
}

export function fakeTriage(
  options: {
    specialists?: SpecialistName[];
    category?: Category;
    costUsd?: number;
    fallback?: boolean;
    evidence?: Evidence[];
  } = {},
): FakeTriage {
  const self: FakeTriage = {
    calls: 0,
    lastAvailable: [],
    async triage({ available }) {
      self.calls++;
      self.lastAvailable = available;
      const specialists = options.specialists ?? ["infra", "logs"];
      const decision: TriageDecision = {
        category: options.category ?? "tls",
        specialists: options.fallback
          ? [...available]
          : specialists.filter((s) => available.includes(s)),
        reason: options.fallback
          ? "triage did not hand off"
          : "certificate looks wrong; containers may matter",
        handoffs: options.fallback
          ? []
          : [{ to: `${specialists[0]}_specialist`, reason: "certificate looks wrong" }],
        fallback: options.fallback ?? false,
        evidence: options.evidence ?? [],
        costUsd: options.costUsd ?? 0.001,
        blockedCalls: 0,
        injectionFlags: 0,
      };
      return decision;
    },
  };
  return self;
}

export interface FakeSynth extends Synthesizer {
  calls: number;
}

export function fakeSynth(
  options: {
    costUsd?: number;
    rejectAlways?: boolean;
    failTimes?: number;
    category?: Category;
  } = {},
): FakeSynth {
  let failures = options.failTimes ?? 0;
  const self: FakeSynth = {
    calls: 0,
    async synthesize({ evidence }): Promise<SynthesisResult> {
      self.calls++;
      if (options.rejectAlways) {
        throw new SynthesisRejectedError(
          ["hypothesis 1 cites evidence that does not exist: x9"],
          0.002,
        );
      }
      if (failures > 0) {
        failures--;
        throw new Error("simulated LLM outage");
      }
      return {
        category: options.category ?? "tls",
        hypotheses: [
          {
            id: "h1",
            cause: "kervan.uz boshqa domen (codetrail.gotrips.cloud) sertifikatini qaytaryapti.",
            supportingEvidenceIds: evidence.slice(0, 2).map((e) => e.id),
            confidence: 0.9,
          },
        ],
        costUsd: options.costUsd ?? 0.002,
        guardrailRetries: 0,
      };
    },
  };
  return self;
}

export interface Mocks {
  triage: FakeTriage;
  specialists: Record<SpecialistName, FakeSpecialist>;
  synth: FakeSynth;
  notifier: Notifier & { sent: string[] };
  tracker: Tracker;
  deps: GraphDeps;
}

export function makeMocks(
  overrides: {
    triage?: Parameters<typeof fakeTriage>[0];
    specialists?: Partial<Record<SpecialistName, Parameters<typeof fakeSpecialist>[1]>>;
    synth?: Parameters<typeof fakeSynth>[0];
    budgetUsd?: number;
    weeklyBudgetUsd?: number;
    weeklySpentUsd?: number;
    notifierFails?: boolean;
  } = {},
): Mocks {
  const tracker: Tracker = { active: 0, maxActive: 0 };
  const specialists = Object.fromEntries(
    SPECIALISTS.map((n) => [
      n,
      fakeSpecialist(n, { tracker, delayMs: 30, ...(overrides.specialists?.[n] ?? {}) }),
    ]),
  ) as Record<SpecialistName, FakeSpecialist>;
  const triage = fakeTriage(overrides.triage);
  const synth = fakeSynth(overrides.synth);
  const notifier = {
    sent: [] as string[],
    async send(text: string) {
      if (overrides.notifierFails) throw new Error("telegram down");
      notifier.sent.push(text);
      return { messageId: notifier.sent.length };
    },
  };
  const deps: GraphDeps = {
    triage,
    specialists,
    synthesizer: synth,
    notifier,
    redact: createRedactor(),
    budgetUsd: overrides.budgetUsd ?? 0.5,
    weeklyBudgetUsd: overrides.weeklyBudgetUsd ?? 0.5,
    weeklyBudget: createMemoryWeeklyBudget(overrides.weeklySpentUsd ?? 0, NOW),
    checkpointer: new MemorySaver(),
    now: () => NOW,
  };
  return { triage, specialists, synth, notifier, tracker, deps };
}

export const graphFor = (m: Mocks) => buildIncidentGraph(m.deps);
