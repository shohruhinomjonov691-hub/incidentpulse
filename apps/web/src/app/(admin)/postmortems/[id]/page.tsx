import { validIncidentId } from "@incidentpulse/orchestrator/journal";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { requireAdmin } from "../../../../server/session.ts";
import { journal } from "../../../../server/store.ts";

export default async function Postmortem({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const report = validIncidentId(id) && (await journal().postmortem(id));
  if (!report) notFound();
  return (
    <>
      <Link className="back" href={`/incidents/${id}`}>
        ← Incident record
      </Link>
      <p className="eyebrow">INCIDENT REVIEW</p>
      {report.markdown ? (
        <article className="panel prose">
          <Markdown
            skipHtml
            disallowedElements={["img"]}
            components={{ a: ({ children }) => <span>{children}</span> }}
          >
            {report.markdown}
          </Markdown>
        </article>
      ) : (
        <>
          <h1>Postmortem pending</h1>
          <p className="intro">The incident is closed. The report is not available yet.</p>
        </>
      )}
    </>
  );
}
