import {
  type Evidence,
  type Hypothesis,
  PROJECT_DISPLAY_NAMES,
  type ProjectId,
} from "@incidentpulse/schemas";

/** Telegram message (Uzbek, short, read-only, no buttons). Layout follows SPEC §6. */

export interface ReportView {
  incidentId: string;
  project: ProjectId;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  costUsd: number;
  budgetExceeded: boolean;
  budgetUsd: number;
}

const MAX_EVIDENCE_LINES = 3;
const MAX_LINE = 200;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatReport(view: ReportView): string {
  const name = PROJECT_DISPLAY_NAMES[view.project];
  const lines = [`🔴 ${name} — incident #${view.incidentId}`];

  const top = [...view.hypotheses].sort((a, b) => b.confidence - a.confidence)[0];
  const evidenceLine = (items: Evidence[]) =>
    `Dalil: ${items.map((e) => clip(e.excerpt, MAX_LINE)).join(" · ")}`;

  if (top) {
    lines.push(`Sabab (ishonch ${top.confidence.toFixed(2)}): ${clip(top.cause, 240)}`);
    const cited = view.evidence.filter((e) => top.supportingEvidenceIds.includes(e.id));
    const shown = (cited.length > 0 ? cited : view.evidence).slice(0, MAX_EVIDENCE_LINES);
    if (shown.length > 0) lines.push(evidenceLine(shown));
  } else {
    lines.push("Sabab: aniqlanmadi (tahlil to'liq emas)");
    const shown = view.evidence.slice(0, MAX_EVIDENCE_LINES);
    if (shown.length > 0) lines.push(evidenceLine(shown));
  }

  if (view.budgetExceeded) {
    lines.push(
      `⚠️ Byudjet ($${view.budgetUsd.toFixed(2)}) tugadi — tergov to'liq emas, inson ko'rigi kerak.`,
    );
  }
  lines.push("Taklif: yo'q — faqat tahlil, hech qanday amal bajarilmaydi");
  lines.push(`Xarajat: $${view.costUsd.toFixed(4)}`);
  return lines.join("\n");
}

export function formatFailureNotice(project: ProjectId, incidentId: string): string {
  return [
    `⚠️ ${PROJECT_DISPLAY_NAMES[project]} — incident #${incidentId}`,
    "Tergov texnik xato tufayli bajarilmadi. Inson ko'rigi kerak.",
  ].join("\n");
}
