import Link from "next/link";
import { requireAdmin } from "../../../server/session.ts";
import { journal } from "../../../server/store.ts";
import { duration, humanize, money, Status, utc } from "../../ui.tsx";

export default async function Incidents() {
  await requireAdmin();
  const incidents = await journal().list();
  const active = incidents.filter((incident) => !incident.closed_at).length;
  const waiting = incidents.filter((incident) => incident.status === "awaiting_approval").length;
  return (
    <>
      <p className="eyebrow">RESPONSE WORKSPACE</p>
      <h1>Incidents</h1>
      <p className="intro">Investigate signals, review evidence, and track recovery.</p>
      <div className="metrics">
        <div className="panel metric">
          <span>Recent incidents</span>
          <strong>{incidents.length}</strong>
        </div>
        <div className="panel metric">
          <span>Active</span>
          <strong>{active}</strong>
        </div>
        <div className="panel metric">
          <span>Awaiting approval</span>
          <strong>{waiting}</strong>
        </div>
      </div>
      <section className="panel table-panel">
        <div className="panel-title">
          <h2>Incident log</h2>
          <span className="muted">Newest first</span>
        </div>
        {incidents.length ? (
          <table>
            <thead>
              <tr>
                <th>Incident</th>
                <th>Project</th>
                <th>Category</th>
                <th>Status</th>
                <th>Duration</th>
                <th>AI cost</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link href={`/incidents/${item.id}`}>{item.id}</Link>
                    <small>{utc(item.started_at)}</small>
                  </td>
                  <td data-label="Project">{item.project}</td>
                  <td data-label="Category">{humanize(item.state?.category ?? "Unclassified")}</td>
                  <td data-label="Status">
                    <Status status={item.status} />
                  </td>
                  <td data-label="Duration">{duration(item.started_at, item.closed_at)}</td>
                  <td data-label="AI cost" className="mono">
                    {money(item.cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">No incidents yet. Investigations will appear here as they start.</p>
        )}
      </section>
    </>
  );
}
