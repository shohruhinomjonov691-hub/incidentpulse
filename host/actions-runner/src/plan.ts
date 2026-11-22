import { createHash } from "node:crypto";
import type { ResolvedRunbook } from "./commands.ts";
import { argvOf } from "./exec.ts";
import type { Policy } from "./policy.ts";

/**
 * The canonical plan an approval is bound to. The digest is
 *   sha256(canonical JSON of [project, runbookId, normalized params, host policy digest])
 * and must stay byte-identical to `planDigest` in mcp/actions/src/plan.ts (test/token.test.ts compares them).
 * The orchestrator stores it with the approval at proposal time, the human sees the target and the
 * parameters next to it, it is part of the signed execution token, and the runner recomputes it from its OWN
 * policy before executing. A changed parameter or a changed host policy therefore needs a new approval.
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

/** Everything in the policy that decides which commands run for a project (and nothing else). */
function policyDigest(policy: Policy, projectId: string, book: ResolvedRunbook): string {
  return sha256(
    canonicalJson({
      bins: policy.bins,
      installDir: policy.installDir,
      upstreamPortMin: policy.upstreamPortMin,
      publicIps: policy.publicIps ?? [],
      project: policy.projects[projectId] ?? null,
      // Fixed host commands are policy too. A runner upgrade can change them without changing the JSON file.
      steps: book.run,
      firstMutationStep: book.firstMutationStep ?? 0,
    }),
  );
}

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

export interface Plan {
  planDigest: string;
  policyDigest: string;
  /** Human-readable target, parameters and exact commands; shown on the Telegram and web approval cards. */
  summary: string[];
}

/** The plan for a resolved runbook, computed from this host's policy. */
export function buildPlan(
  policy: Policy,
  projectId: string,
  book: ResolvedRunbook,
  params: Record<string, string>,
): Plan {
  const policyHash = policyDigest(policy, projectId, book);
  const commands = book.run.map((step) => {
    const { file, args } = argvOf(policy, { ...step, sudo: false });
    return `$ ${[file, ...args].join(" ")}`;
  });
  return {
    planDigest: planDigest({
      project: projectId,
      runbookId: book.runbookId,
      params,
      policyDigest: policyHash,
    }),
    policyDigest: policyHash,
    summary: [
      `project: ${projectId}`,
      `runbook: ${book.runbookId}`,
      ...Object.entries(normalizeParams(params)).map(([k, v]) => `${k}: ${v}`),
      "commands:",
      ...commands,
    ],
  };
}
