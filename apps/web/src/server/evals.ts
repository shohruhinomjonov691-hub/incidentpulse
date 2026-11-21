import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Result = {
  scenario?: number;
  got?: string;
  expected?: string;
  correct?: boolean;
  recovery?: { ok?: boolean };
  costUsd?: number;
};
type Run = { results?: Result[]; totalCostUsd?: number };

export async function evalRuns() {
  const directory =
    process.env.SANDBOX_RESULTS_DIR ?? resolve(process.cwd(), "../../sandbox/results");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .sort((left, right) => right.name.localeCompare(left.name))
        .slice(0, 40)
        .map(async (entry) => {
          try {
            const parsed = JSON.parse(await readFile(resolve(directory, entry.name), "utf8")) as
              | Run
              | Result[];
            const results = Array.isArray(parsed) ? parsed : parsed.results;
            return {
              name: entry.name,
              results: Array.isArray(results)
                ? results.slice(0, 100).filter((row) => row && typeof row.scenario === "number")
                : [],
              total: Array.isArray(parsed) ? undefined : parsed.totalCostUsd,
            };
          } catch {
            return undefined;
          }
        }),
    )
  ).filter((run) => run !== undefined);
}
