import {
  type Evidence,
  type Hypothesis,
  PROJECT_DISPLAY_NAMES,
  type ProjectId,
} from "@incidentpulse/schemas";

/** Telegram messages (Uzbek, short, read-only, no buttons). Layout follows SPEC §6. */

export type OverBudget = "incident" | "daily" | null;
export type EscalationReason = "incident_budget" | "daily_budget" | "guardrail";

export interface ReportView {
  incidentId: string;
  project: ProjectId;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  costUsd: number;
  overBudget: OverBudget;
  budgetUsd: number;
  dailyBudgetUsd: number;
}

const MAX_EVIDENCE_LINES = 3;
const MAX_LINE = 240;

/** Cuts on a word boundary so a token like "issuer=..." is never sliced in half. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Small amounts (< $0.10) keep 4 decimals so they do not collapse to "$0.00"; larger ones use 2. */
export function usd(n: number): string {
  return `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
}

/** The same fact is often found twice (triage's quick look, then a specialist): show it once. */
function distinctByExcerpt(items: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return items.filter((e) => {
    if (seen.has(e.excerpt)) return false;
    seen.add(e.excerpt);
    return true;
  });
}

function evidenceLine(items: Evidence[]): string {
  const shown = distinctByExcerpt(items).slice(0, MAX_EVIDENCE_LINES);
  return `Dalil: ${shown.map((e) => clip(e.excerpt, MAX_LINE)).join(" · ")}`;
}

export function formatReport(view: ReportView): string {
  const name = PROJECT_DISPLAY_NAMES[view.project];
  const lines = [`🔴 ${name} — incident #${view.incidentId}`];

  const top = [...view.hypotheses].sort((a, b) => b.confidence - a.confidence)[0];
  if (top) {
    lines.push(`Sabab (ishonch ${top.confidence.toFixed(2)}): ${clip(top.cause, 240)}`);
    const cited = view.evidence.filter((e) => top.supportingEvidenceIds.includes(e.id));
    const shown = cited.length > 0 ? cited : view.evidence;
    if (shown.length > 0) lines.push(evidenceLine(shown));
  } else {
    lines.push("Sabab: aniqlanmadi (tahlil to'liq emas)");
    const shown = view.evidence;
    if (shown.length > 0) lines.push(evidenceLine(shown));
  }

  if (view.overBudget === "incident") {
    lines.push(
      `⚠️ Byudjet (${usd(view.budgetUsd)}) tugadi — tergov to'liq emas, inson ko'rigi kerak.`,
    );
  } else if (view.overBudget === "daily") {
    lines.push(
      `⚠️ Kunlik byudjet (${usd(view.dailyBudgetUsd)}) tugadi — yangi tergovlar to'xtatildi, inson ko'rigi kerak.`,
    );
  }
  lines.push("Taklif: yo'q — faqat tahlil, hech qanday amal bajarilmaydi");
  lines.push(`Xarajat: $${view.costUsd.toFixed(4)}`);
  return lines.join("\n");
}

export interface EscalationView {
  incidentId: string;
  project: ProjectId;
  reason: EscalationReason;
  evidence: Evidence[];
  costUsd: number;
  spentTodayUsd: number;
  budgetUsd: number;
  dailyBudgetUsd: number;
}

/** SPEC §3.2 `escalate`: short "needs a human" notice with whatever evidence exists. */
export function formatEscalation(view: EscalationView): string {
  const lines = [
    `🚨 ${PROJECT_DISPLAY_NAMES[view.project]} — incident #${view.incidentId}: inson ko'rigi kerak`,
  ];
  if (view.reason === "guardrail") {
    lines.push(
      "Sabab: tahlil natijasi guardrail tekshiruvidan o'tmadi (dalilga tayanmaydi) — avtomatik xulosa rad etildi.",
    );
  } else if (view.reason === "daily_budget") {
    lines.push(
      `Sabab: kunlik byudjet (${usd(view.dailyBudgetUsd)}) tugadi (bugun ${usd(view.spentTodayUsd)}) — avtomatik tergov to'xtatildi.`,
    );
  } else {
    lines.push(
      `Sabab: incident byudjeti (${usd(view.budgetUsd)}) tugadi (sarflandi ${usd(view.costUsd)}) — tergov to'xtatildi.`,
    );
  }
  if (view.evidence.length > 0) lines.push(evidenceLine(view.evidence));
  return lines.join("\n");
}

export function formatFailureNotice(project: ProjectId, incidentId: string): string {
  return [
    `⚠️ ${PROJECT_DISPLAY_NAMES[project]} — incident #${incidentId}`,
    "Tergov texnik xato tufayli bajarilmadi. Inson ko'rigi kerak.",
  ].join("\n");
}
