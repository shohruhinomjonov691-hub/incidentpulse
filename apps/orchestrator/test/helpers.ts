import { DEFAULT_PROJECT_DOMAINS } from "@incidentpulse/config";
import { createRedactor } from "@incidentpulse/redact";
import type { Evidence, IncidentJob } from "@incidentpulse/schemas";
import type { Notifier } from "@incidentpulse/telegram-bot";
import { MemorySaver } from "@langchain/langgraph";
import { buildIncidentGraph, type GraphDeps } from "../src/graph.ts";
import type { InfraSpecialist, Synthesizer } from "../src/types.ts";

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

export const tlsMismatchEvidence = (id = "e1"): Evidence => ({
  id,
  source: "mcp-infra",
  tool: "tls_inspect",
  excerpt:
    "tls_inspect(kervan.uz): chainValid=false hostnameMatch=false expired=false notAfter=2027-01-13 (53d) error=ERR_TLS_CERT_ALTNAME_INVALID subject=codetrail.gotrips.cloud",
  at: "2026-11-21T04:00:05.000Z",
  hash: "sha256:abc",
});

export interface Mocks {
  infra: InfraSpecialist & { calls: number };
  synth: Synthesizer & { calls: number };
  notifier: Notifier & { sent: string[] };
  deps: GraphDeps;
}

export function makeMocks(
  overrides: {
    infraCost?: number;
    synthCost?: number;
    budgetUsd?: number;
    synthFailures?: number;
    notifierFails?: boolean;
  } = {},
): Mocks {
  let synthFailures = overrides.synthFailures ?? 0;

  const infra = {
    calls: 0,
    async investigate({ evidenceOffset }: { evidenceOffset: number }) {
      infra.calls++;
      return {
        evidence: [tlsMismatchEvidence(`e${evidenceOffset + 1}`)],
        summary: "tls shows a certificate for another host",
        costUsd: overrides.infraCost ?? 0.004,
      };
    },
  };
  const synth = {
    calls: 0,
    async synthesize() {
      synth.calls++;
      if (synthFailures > 0) {
        synthFailures--;
        throw new Error("simulated LLM outage");
      }
      return {
        category: "tls" as const,
        hypotheses: [
          {
            id: "h1",
            cause: "kervan.uz boshqa domen (codetrail.gotrips.cloud) sertifikatini qaytaryapti.",
            supportingEvidenceIds: ["e1"],
            confidence: 0.9,
          },
        ],
        costUsd: overrides.synthCost ?? 0.002,
      };
    },
  };
  const notifier = {
    sent: [] as string[],
    async send(text: string) {
      if (overrides.notifierFails) throw new Error("telegram down");
      notifier.sent.push(text);
      return { messageId: notifier.sent.length };
    },
  };

  const deps: GraphDeps = {
    infraSpecialist: infra,
    synthesizer: synth,
    notifier,
    redact: createRedactor(),
    projectDomains: DEFAULT_PROJECT_DOMAINS,
    budgetUsd: overrides.budgetUsd ?? 0.5,
    checkpointer: new MemorySaver(),
    now: () => new Date("2026-11-21T04:00:10.000Z"),
  };
  return { infra, synth, notifier, deps };
}

export const graphFor = (m: Mocks) => buildIncidentGraph(m.deps);
