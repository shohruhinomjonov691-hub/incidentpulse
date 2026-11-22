import { validIncidentId } from "@incidentpulse/orchestrator/journal";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "../../../../server/session.ts";
import { approvals, journal, redact } from "../../../../server/store.ts";
import { ApprovalButtons, IncidentChat, Timeline } from "../../../components.tsx";
import { duration, humanize, money, Status, utc } from "../../../ui.tsx";

export default async function Incident({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const row = validIncidentId(id) && (await journal().get(id));
  if (!row) notFound();
  const flow = row.status === "awaiting_approval" && row.approval_id ? approvals() : undefined;
  const approval = flow && row.approval_id ? await flow.store.get(row.approval_id) : undefined;
  const postmortem = await journal().postmortem(id);
  return (
    <>
      <Link className="back" href="/incidents">
        ← All incidents
      </Link>
      <p className="eyebrow">INCIDENT RECORD</p>
      <div className="incident-heading">
        <h1>{id}</h1>
        <Status status={row.status} />
      </div>
      <p className="intro">
        {row.project} · {humanize(row.state?.category ?? "Unclassified")} · {utc(row.started_at)}
      </p>
      <div className="metrics">
        <div className="panel metric">
          <span>Duration</span>
          <strong>{duration(row.started_at, row.closed_at)}</strong>
        </div>
        <div className="panel metric">
          <span>AI cost</span>
          <strong className="mono" data-testid="incident-cost">
            {money(row.cost)}
          </strong>
        </div>
        <div className="panel metric">
          <span>Evidence items</span>
          <strong>{row.state?.evidence.length ?? 0}</strong>
        </div>
      </div>
      <div className="detail-grid">
        <Timeline key={id} id={id} />
        <aside className="side">
          {approval &&
            flow &&
            approval.incidentId === id &&
            approval.status === "pending" &&
            approval.expiresAt.getTime() > Date.now() && (
              <section className="panel side-card">
                <p className="eyebrow">DECISION REQUIRED</p>
                <h2>Review remediation</h2>
                <p className="mono">{approval.runbookId}</p>
                <p className="muted">
                  {approval.risk} risk · Expires {utc(approval.expiresAt)}
                </p>
                <dl className="mono" data-testid="approval-target">
                  <dt>project</dt>
                  <dd>{approval.project}</dd>
                  {Object.entries(approval.params).map(([name, value]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>{redact(value)}</dd>
                    </div>
                  ))}
                </dl>
                {approval.planSummary && (
                  <details open>
                    <summary>
                      Exact plan · sha256 {approval.planDigest?.slice(0, 12) ?? "unavailable"}
                    </summary>
                    <pre>{redact(approval.planSummary)}</pre>
                  </details>
                )}
                <details>
                  <summary>Pre-approval checks</summary>
                  <pre>{redact(approval.dryRunOutput)}</pre>
                </details>
                <ApprovalButtons
                  id={id}
                  approve={flow.callbacks.encode(approval.id, "a")}
                  reject={flow.callbacks.encode(approval.id, "r")}
                />
              </section>
            )}
          {!!postmortem && (
            <section className="panel side-card">
              <h2>Postmortem</h2>
              <p className="muted">
                {postmortem.markdown
                  ? "The incident report is ready."
                  : "The incident is closed. Report generation is pending."}
              </p>
              <Link href={`/postmortems/${id}`}>Open postmortem →</Link>
            </section>
          )}
          <IncidentChat key={id} id={id} />
        </aside>
      </div>
    </>
  );
}
