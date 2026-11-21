// Builds sandbox/results/phase6-final.json from the saved Phase 6 runs: the full 14-scenario run, with
// the rows of any later re-run replacing the same scenario. Nothing is re-scored or edited by hand; the
// summary is recomputed from the merged rows, and the original files stay untouched.
//   node sandbox/scripts/merge-eval.mjs full.json rerun-13.json [...] > phase6-final.json
import { readFileSync } from "node:fs";

const [fullPath, ...rerunPaths] = process.argv.slice(2);
const full = JSON.parse(readFileSync(fullPath, "utf8"));
const reruns = rerunPaths.map((p) => JSON.parse(readFileSync(p, "utf8")));
const replaced = new Set(reruns.flatMap((r) => r.results.map((row) => row.scenario)));
const results = [
  ...full.results.filter((row) => !replaced.has(row.scenario)),
  ...reruns.flatMap((r) => r.results),
].sort((a, b) => a.scenario - b.scenario);

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (n, d = 6) => Number(n.toFixed(d));
const percentile = (xs, p) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const done = results.filter((r) => !r.skipped && !r.error);
const scored = done.filter((r) => r.categoryOk !== null);
const spentTotal = round(full.totalCostUsd + sum(reruns.map((r) => r.totalCostUsd)));

console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      model: full.model,
      sources: [fullPath, ...rerunPaths].map((p) => p.split("/").pop()),
      injectionMode: full.injectionMode,
      // What the final table's incidents cost, and what was actually spent including superseded rows.
      totalCostUsd: round(sum(results.map((r) => r.costUsd))),
      totalSpentIncludingReruns: spentTotal,
      summary: {
        incidents: done.length,
        scenariosRun: new Set(done.map((r) => r.scenario)).size,
        scenariosPassed: new Set(
          done
            .filter((r) => r.correct)
            .map((r) => r.scenario)
            .filter((id) => done.filter((r) => r.scenario === id).every((r) => r.correct)),
        ).size,
        categoryCorrect: scored.filter((r) => r.categoryOk).length,
        categoryScored: scored.length,
        timeToRcaSeconds: {
          p50: percentile(
            done.map((r) => r.seconds),
            50,
          ),
          p95: percentile(
            done.map((r) => r.seconds),
            95,
          ),
        },
        costPerIncidentUsd: round(sum(done.map((r) => r.costUsd)) / done.length),
        costMaxIncidentUsd: Math.max(...done.map((r) => r.costUsd)),
        toolCallsPerIncident: round(sum(done.map((r) => r.toolCalls)) / done.length, 1),
        unsafeAttempts:
          sum(done.map((r) => r.unsafeAttempts)) + done.filter((r) => r.canaryLeaked).length,
        proposals: done.filter((r) => r.runbookProposed).length,
        falseRemediations: done.filter((r) => r.falseRemediation).length,
      },
      results,
    },
    null,
    2,
  ),
);
