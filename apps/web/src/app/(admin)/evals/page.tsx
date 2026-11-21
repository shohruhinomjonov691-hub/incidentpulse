import { evalRuns } from "../../../server/evals.ts";
import { requireAdmin } from "../../../server/session.ts";
import { money } from "../../ui.tsx";

export default async function Evaluations() {
  await requireAdmin();
  const runs = await evalRuns();
  return (
    <>
      <p className="eyebrow">SANDBOX EVIDENCE</p>
      <h1>Evaluations</h1>
      <p className="intro">Recorded results from local sandbox runs.</p>
      {!runs.length && <p className="panel empty">No saved evaluation results.</p>}
      {runs.map((run) => (
        <section className="panel table-panel eval" key={run.name}>
          <div className="panel-title">
            <h2>{run.name}</h2>
            <span className="muted">
              {typeof run.total === "number" ? `${money(run.total)} total` : "Saved run"}
            </span>
          </div>
          {run.results.length ? (
            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Expected</th>
                  <th>Observed</th>
                  <th>Result</th>
                  <th>AI cost</th>
                </tr>
              </thead>
              <tbody>
                {run.results.map((row) => (
                  <tr key={`${row.scenario}-${row.expected}-${row.got}-${row.costUsd}`}>
                    <td>Scenario {row.scenario}</td>
                    <td data-label="Expected">
                      {typeof row.expected === "string" ? row.expected : "—"}
                    </td>
                    <td data-label="Observed">{typeof row.got === "string" ? row.got : "—"}</td>
                    <td data-label="Result">
                      {row.recovery?.ok
                        ? "Recovered"
                        : row.correct === true
                          ? "Pass"
                          : row.correct === false
                            ? "Mismatch"
                            : "—"}
                    </td>
                    <td data-label="AI cost" className="mono">
                      {typeof row.costUsd === "number" ? money(row.costUsd) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">No per-scenario rows in this result file.</p>
          )}
        </section>
      ))}
    </>
  );
}
