import { createHash } from "node:crypto";

/**
 * The canonical plan an approval is bound to: sha256 of the canonical JSON of
 * [project, runbookId, normalized params, host policy digest].
 *
 * Must stay byte-identical to host/actions-runner/src/plan.ts (a contract test in
 * host/actions-runner/test/token.test.ts compares them): the runner recomputes the digest from its own
 * policy and refuses an execution whose digest differs.
 */

/** JSON with sorted object keys at every level: the same value always serializes to the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export const normalizeParams = (params: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function planDigest(input: {
  project: string;
  runbookId: string;
  params: Record<string, string>;
  policyDigest: string;
}): string {
  return sha256(
    canonicalJson([
      "plan",
      input.project,
      input.runbookId,
      normalizeParams(input.params),
      input.policyDigest,
    ]),
  );
}

export interface PlanInfo {
  planDigest: string;
  policyDigest: string;
  /** Target, parameters and exact commands, as shown on the Telegram and web approval cards. */
  summary: string;
}

/**
 * Plan for the local executor (sandbox, tests), where no host runner owns a policy: the "policy" is the
 * command set the registry resolved, so a change to the YAML or the scope changes the digest too.
 */
export function localPlan(
  project: string,
  book: {
    runbookId: string;
    params: Record<string, string>;
    run: Array<{ program: string; args: string[] }>;
    dryRun: Array<{ program: string; args: string[] }>;
  },
): PlanInfo {
  const policyDigest = sha256(canonicalJson({ dryRun: book.dryRun, run: book.run }));
  return {
    planDigest: planDigest({
      project,
      runbookId: book.runbookId,
      params: book.params,
      policyDigest,
    }),
    policyDigest,
    summary: [
      `project: ${project}`,
      `runbook: ${book.runbookId}`,
      ...Object.entries(normalizeParams(book.params)).map(([k, v]) => `${k}: ${v}`),
      "commands:",
      ...book.run.map((step) => `$ ${[step.program, ...step.args].join(" ")}`),
    ].join("\n"),
  };
}
