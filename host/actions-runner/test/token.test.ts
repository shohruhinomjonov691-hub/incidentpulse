import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson as orchestratorCanonicalJson,
  planDigest as orchestratorPlanDigest,
} from "@incidentpulse/mcp-actions";
import { signExecutionToken } from "@incidentpulse/mcp-actions/approvals";
import { describe, expect, test } from "vitest";
import { canonicalJson, planDigest } from "../src/plan.ts";
import {
  checkApprovalToken,
  createFileLedger,
  signApproval,
  TOKEN_LIFETIME_MS,
} from "../src/token.ts";
import { SECRET } from "./helpers.ts";

const claims = {
  approvalId: "AAAAAAAAAAAAAAAA",
  incidentId: "inc-1",
  project: "kervan",
  runbookId: "nginx_site_proxy",
  params: { upstream: "127.0.0.1:3000", domain: "kervan.uz" },
  planDigest: "a".repeat(64),
  tokenExpiresAt: 1_800_000_000_000 + TOKEN_LIFETIME_MS,
};

describe("approval token", () => {
  test("is byte-identical to the token the orchestrator signs (APPROVAL_HMAC_SECRET)", () => {
    expect(signExecutionToken(SECRET, claims)).toBe(signApproval(SECRET, claims));
  });

  test("the plan digest is computed identically by the orchestrator and the runner", () => {
    const input = {
      project: "kervan",
      runbookId: "nginx_site_proxy",
      params: { upstream: "127.0.0.1:3000", domain: "kervan.uz" },
      policyDigest: "b".repeat(64),
    };
    expect(orchestratorPlanDigest(input)).toBe(planDigest(input));
    // key order of the parameters never changes the digest
    expect(
      planDigest({ ...input, params: { domain: "kervan.uz", upstream: "127.0.0.1:3000" } }),
    ).toBe(planDigest(input));
    const sample = { b: [1, { z: 1, a: "x" }], a: null, c: undefined };
    expect(canonicalJson(sample)).toBe(orchestratorCanonicalJson(sample));
    expect(canonicalJson(sample)).toBe('{"a":null,"b":[1,{"a":"x","z":1}]}');
  });

  test("a different plan digest is a different token", () => {
    expect(signApproval(SECRET, { ...claims, planDigest: "c".repeat(64) })).not.toBe(
      signApproval(SECRET, claims),
    );
    const token = signApproval(SECRET, claims);
    expect(
      checkApprovalToken(
        SECRET,
        { ...claims, planDigest: "c".repeat(64) },
        token,
        claims.tokenExpiresAt - 60_000,
      ),
    ).toBe("Approval token is invalid");
  });

  test("accepts a valid unexpired token", () => {
    const token = signApproval(SECRET, claims);
    expect(
      checkApprovalToken(SECRET, claims, token, claims.tokenExpiresAt - 60_000),
    ).toBeUndefined();
  });

  test.each([
    ["a different runbook", { runbookId: "nginx_reload" }],
    ["different params", { params: { domain: "kervan.uz", upstream: "127.0.0.1:3001" } }],
    ["another project", { project: "codetrail" }],
    ["another incident", { incidentId: "inc-2" }],
    ["another approval", { approvalId: "BBBBBBBBBBBBBBBB" }],
    ["a forged expiry", { tokenExpiresAt: claims.tokenExpiresAt + 1 }],
  ])("refuses a token presented for %s", (_name, change) => {
    const token = signApproval(SECRET, claims);
    expect(
      checkApprovalToken(SECRET, { ...claims, ...change }, token, claims.tokenExpiresAt - 60_000),
    ).toBeDefined();
  });

  test("refuses a wrong key, an expired token and a far-future expiry", () => {
    const token = signApproval(SECRET, claims);
    expect(checkApprovalToken("x".repeat(40), claims, token, 0)).toBe("Approval token is invalid");
    expect(checkApprovalToken(SECRET, claims, token, claims.tokenExpiresAt + 1)).toBe(
      "Approval token has expired",
    );
    const far = { ...claims, tokenExpiresAt: claims.tokenExpiresAt + 3_600_000 };
    expect(checkApprovalToken(SECRET, far, signApproval(SECRET, far), claims.tokenExpiresAt)).toBe(
      "Approval token expiry is too far in the future",
    );
  });
});

describe("ledger", () => {
  test("an approval can be claimed once, also after a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ip-ledger-")), "consumed.jsonl");
    const first = createFileLedger(path);
    expect(first.claim("AAAAAAAAAAAAAAAA", 1)).toBe(true);
    expect(first.claim("AAAAAAAAAAAAAAAA", 2)).toBe(false);
    first.complete("AAAAAAAAAAAAAAAA", true, 3);
    const restarted = createFileLedger(path);
    expect(restarted.claim("AAAAAAAAAAAAAAAA", 4)).toBe(false);
    expect(restarted.claim("BBBBBBBBBBBBBBBB", 4)).toBe(true);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);
  });

  test("refusals and failed steps are written to the audit file without consuming the approval", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ip-ledger-")), "consumed.jsonl");
    const ledger = createFileLedger(path);
    ledger.refuse("AAAAAAAAAAAAAAAA", "expired_in_queue", 5);
    expect(createFileLedger(path).claim("AAAAAAAAAAAAAAAA", 6)).toBe(true);
    ledger.complete("BBBBBBBBBBBBBBBB", false, 7, 1);
    const rows = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toContainEqual({
      event: "refused",
      approvalId: "AAAAAAAAAAAAAAAA",
      reason: "expired_in_queue",
      at: 5,
    });
    expect(rows).toContainEqual({
      event: "completed",
      approvalId: "BBBBBBBBBBBBBBBB",
      ok: false,
      at: 7,
      failedStep: 1,
    });
  });
});
