import { IncidentStateSchema } from "@incidentpulse/schemas";
import { describe, expect, test } from "vitest";
import { toIncidentState } from "../src/graph.ts";
import { runIncident } from "../src/run.ts";
import { graphFor, job, makeMocks, NOW } from "./helpers.ts";

describe("incident graph: intake → infra_specialist → synthesize → report", () => {
  test("happy path: one Telegram report, cost summed, state satisfies the SPEC §3.1 contract", async () => {
    const m = makeMocks();
    const { state, mode } = await runIncident(graphFor(m), job());

    expect(mode).toBe("completed");
    expect(m.infra.calls).toBe(1);
    expect(m.synth.calls).toBe(1);
    expect(m.notifier.sent).toHaveLength(1);
    expect(state.reportSent).toEqual({ sentAt: "2026-11-21T04:00:10.000Z", messageId: 1 });
    expect(state.costUsd).toBeCloseTo(0.006, 6);
    expect(state.category).toBe("tls");
    expect(IncidentStateSchema.safeParse(toIncidentState(state)).success).toBe(true);
  });

  test("the report is Uzbek, SPEC §6 shaped, and read-only (no buttons, no action offered)", async () => {
    const m = makeMocks();
    await runIncident(graphFor(m), job({ incidentId: "inc-42" }));
    const text = m.notifier.sent[0] ?? "";

    expect(text).toContain("🔴 Kervan — incident #inc-42");
    expect(text).toContain("Sabab (ishonch 0.90): kervan.uz boshqa domen");
    expect(text).toContain("Dalil: tls_inspect(kervan.uz): chainValid=false hostnameMatch=false");
    expect(text).toContain("Taklif: yo'q — faqat tahlil, hech qanday amal bajarilmaydi");
    expect(text).toContain("Xarajat: $0.0060");
    expect(text).not.toMatch(/Bajar|Rad et|\[✅|\[❌/);
  });

  test("evidence ids are assigned by the specialist and cited hypotheses reference them", async () => {
    const m = makeMocks();
    const { state } = await runIncident(graphFor(m), job());
    expect(state.evidence.map((e) => e.id)).toEqual(["e1"]);
    expect(state.hypotheses[0]?.supportingEvidenceIds).toEqual(["e1"]);
  });

  test("normalizes the untrusted signal text at intake", async () => {
    const m = makeMocks();
    const noisy = job({
      signal: {
        check: "https",
        level: " DOWN ",
        summary: "a\n\n  b\t c",
        at: "2026-11-21T04:00:00.000Z",
      },
    });
    const { state } = await runIncident(graphFor(m), noisy);
    expect(state.signal.level).toBe("down");
    expect(state.signal.summary).toBe("a b c");
  });
});

describe("per-incident budget ($0.50, SPEC §8)", () => {
  test("if the specialist alone spends the budget, synthesize is skipped and the incident escalates", async () => {
    const m = makeMocks({ infraCost: 0.6 });
    const { state } = await runIncident(graphFor(m), job());

    expect(m.synth.calls).toBe(0);
    expect(state.overBudget).toBe("incident");
    expect(state.reportSent).toBeUndefined();
    expect(state.escalation?.reason).toBe("incident_budget");
    expect(state.costUsd).toBeCloseTo(0.6, 6);
    expect(m.notifier.sent).toHaveLength(1);
    expect(m.notifier.sent[0]).toContain("🚨 Kervan — incident #inc-test-1: inson ko'rigi kerak");
    expect(m.notifier.sent[0]).toContain("Sabab: incident byudjeti ($0.50) tugadi");
    expect(m.notifier.sent[0]).toContain("Dalil: tls_inspect(kervan.uz)"); // evidence pack
  });

  test("spending exactly the budget counts as exceeded (hard stop)", async () => {
    const m = makeMocks({ infraCost: 0.5 });
    await runIncident(graphFor(m), job());
    expect(m.synth.calls).toBe(0);
  });

  test("synthesize pushing the total over budget still reports, with a budget warning", async () => {
    const m = makeMocks({ infraCost: 0.3, synthCost: 0.3 });
    const { state } = await runIncident(graphFor(m), job());
    expect(m.synth.calls).toBe(1);
    expect(state.overBudget).toBe("incident");
    expect(state.reportSent).toBeDefined();
    expect(m.notifier.sent[0]).toContain("⚠️ Byudjet ($0.50) tugadi");
  });

  test("a custom budget is honoured", async () => {
    const m = makeMocks({ infraCost: 0.02, budgetUsd: 0.01 });
    await runIncident(graphFor(m), job());
    expect(m.synth.calls).toBe(0);
    expect(m.notifier.sent[0]).toContain("incident byudjeti ($0.01)");
  });
});

describe("daily budget ($3 per UTC day, SPEC §8)", () => {
  test("every LLM call is added to the daily counter", async () => {
    const m = makeMocks();
    const { state } = await runIncident(graphFor(m), job());
    expect(state.dailySpentUsd).toBeCloseTo(0.006, 6);
    expect(await m.deps.dailyBudget.spentUsd(NOW)).toBeCloseTo(0.006, 6);
  });

  test("when today's budget is already spent: NO LLM call, escalate, one short Telegram warning", async () => {
    const m = makeMocks({ dailySpentUsd: 3.02 });
    const { state } = await runIncident(graphFor(m), job({ incidentId: "inc-77" }));

    expect(m.infra.calls).toBe(0);
    expect(m.synth.calls).toBe(0);
    expect(state.costUsd).toBe(0);
    expect(state.overBudget).toBe("daily");
    expect(state.escalation).toMatchObject({ reason: "daily_budget", messageId: 1 });
    expect(state.reportSent).toBeUndefined();
    expect(m.notifier.sent).toEqual([
      "🚨 Kervan — incident #inc-77: inson ko'rigi kerak\n" +
        "Sabab: kunlik byudjet ($3.00) tugadi (bugun $3.02) — avtomatik tergov to'xtatildi.",
    ]);
    // the escalated incident did not add anything to the counter
    expect(await m.deps.dailyBudget.spentUsd(NOW)).toBeCloseTo(3.02, 6);
  });

  test("exactly at the limit counts as spent (hard stop)", async () => {
    const m = makeMocks({ dailySpentUsd: 3 });
    await runIncident(graphFor(m), job());
    expect(m.infra.calls).toBe(0);
  });

  test("just under the limit still runs", async () => {
    const m = makeMocks({ dailySpentUsd: 2.99 });
    const { state } = await runIncident(graphFor(m), job());
    expect(m.infra.calls).toBe(1);
    expect(state.reportSent).toBeDefined();
  });

  test("the specialist pushing the day over the limit skips synthesize and escalates with the evidence", async () => {
    const m = makeMocks({ dailySpentUsd: 2.998, infraCost: 0.004 });
    const { state } = await runIncident(graphFor(m), job());

    expect(m.infra.calls).toBe(1);
    expect(m.synth.calls).toBe(0);
    expect(state.escalation?.reason).toBe("daily_budget");
    expect(m.notifier.sent[0]).toContain("kunlik byudjet ($3.00) tugadi (bugun $3.00)");
    expect(m.notifier.sent[0]).toContain("Dalil: tls_inspect(kervan.uz)");
  });

  test("spend accumulates across incidents until the limit, then escalation takes over", async () => {
    const m = makeMocks({ infraCost: 0.4, synthCost: 0.1, dailyBudgetUsd: 1.2, budgetUsd: 0.5 });
    const graph = graphFor(m);
    // each normal incident costs 0.5 -> hits the $0.50 incident cap exactly after synthesize (report + warning)
    await runIncident(graph, job({ incidentId: "inc-1" })); // today: 0.5
    await runIncident(graph, job({ incidentId: "inc-2" })); // today: 1.0
    expect(m.infra.calls).toBe(2);
    const third = await runIncident(graph, job({ incidentId: "inc-3" })); // infra 0.4 -> 1.4 >= 1.2
    expect(third.state.escalation?.reason).toBe("daily_budget");
    expect(m.synth.calls).toBe(2);
    const fourth = await runIncident(graph, job({ incidentId: "inc-4" })); // already over: no LLM
    expect(fourth.state.escalation?.reason).toBe("daily_budget");
    expect(m.infra.calls).toBe(3);
  });

  test("a new UTC day starts from zero", async () => {
    const m = makeMocks({ dailySpentUsd: 3.5 });
    const tomorrow = new Date("2026-11-22T00:00:01.000Z");
    m.deps.now = () => tomorrow;
    const { state } = await runIncident(graphFor(m), job());
    expect(m.infra.calls).toBe(1);
    expect(state.reportSent).toBeDefined();
  });

  test("an escalated incident is not escalated twice when its job is retried", async () => {
    const m = makeMocks({ dailySpentUsd: 5 });
    const graph = graphFor(m);
    await runIncident(graph, job());
    const again = await runIncident(graph, job());
    expect(again.mode).toBe("already_done");
    expect(m.notifier.sent).toHaveLength(1);
  });

  test("if the daily-budget warning cannot be delivered the job fails (so it is retried), not silently dropped", async () => {
    const m = makeMocks({ dailySpentUsd: 5, notifierFails: true });
    await expect(runIncident(graphFor(m), job())).rejects.toThrow("telegram down");
  });
});

describe("durability: checkpoints keyed by incidentId", () => {
  test("a finished incident is not re-run or re-sent when the job is retried", async () => {
    const m = makeMocks();
    const graph = graphFor(m);
    await runIncident(graph, job());
    const again = await runIncident(graph, job());

    expect(again.mode).toBe("already_done");
    expect(m.infra.calls).toBe(1);
    expect(m.notifier.sent).toHaveLength(1);
  });

  test("after a crash mid-graph the retry resumes at the failed node (no repeated LLM spend)", async () => {
    const m = makeMocks({ synthFailures: 1 });
    const graph = graphFor(m);

    await expect(runIncident(graph, job())).rejects.toThrow("simulated LLM outage");
    expect(m.infra.calls).toBe(1);
    expect(m.notifier.sent).toHaveLength(0);

    const retry = await runIncident(graph, job());
    expect(retry.mode).toBe("resumed");
    expect(m.infra.calls).toBe(1); // infra_specialist was checkpointed, not re-run
    expect(m.synth.calls).toBe(2);
    expect(m.notifier.sent).toHaveLength(1);
    expect(retry.state.costUsd).toBeCloseTo(0.006, 6); // the failed attempt cost nothing extra
  });

  test("different incidents do not share state", async () => {
    const m = makeMocks();
    const graph = graphFor(m);
    await runIncident(graph, job({ incidentId: "inc-a" }));
    await runIncident(graph, job({ incidentId: "inc-b" }));
    expect(m.infra.calls).toBe(2);
    expect(m.notifier.sent).toHaveLength(2);
  });
});

describe("failure handling", () => {
  test("a project without configured domains fails loudly instead of probing nothing", async () => {
    const m = makeMocks();
    await expect(runIncident(graphFor(m), job({ project: "gotrip" }))).rejects.toThrow(
      /No domains configured for project "gotrip"/,
    );
    expect(m.notifier.sent).toHaveLength(0);
  });

  test("a Telegram failure surfaces (so BullMQ retries) and does not mark the incident reported", async () => {
    const m = makeMocks({ notifierFails: true });
    await expect(runIncident(graphFor(m), job())).rejects.toThrow("telegram down");
  });
});
