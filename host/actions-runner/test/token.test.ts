import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalStore } from "@incidentpulse/mcp-actions/approvals";
import { describe, expect, test } from "vitest";
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
  tokenExpiresAt: 1_800_000_000_000 + TOKEN_LIFETIME_MS,
};

describe("approval token", () => {
  test("is byte-identical to the token the orchestrator's approval store issues", async () => {
    const decidedAt = new Date(1_800_000_000_000);
    const store = createApprovalStore(
      { query: async () => ({ rowCount: 1, rows: [] }) } as never,
      SECRET,
    );
    const issued = await store.issueToken({
      id: claims.approvalId,
      incidentId: claims.incidentId,
      project: "kervan",
      runbookId: "nginx_site_proxy",
      params: claims.params,
      status: "approved",
      decidedAt,
    } as never);
    expect(issued).toBe(signApproval(SECRET, claims));
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
});
