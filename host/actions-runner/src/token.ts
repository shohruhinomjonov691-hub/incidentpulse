import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";

/** Same lifetime as the orchestrator's approval token (mcp-actions TOKEN_MINUTES). */
export const TOKEN_LIFETIME_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 5_000;

export interface TokenClaims {
  approvalId: string;
  incidentId: string;
  project: string;
  runbookId: string;
  params: Record<string, string>;
  /** Epoch milliseconds; part of the signed payload. */
  tokenExpiresAt: number;
}

/**
 * Must stay byte-identical to `tokenFor` in mcp/actions/src/approvals.ts (a contract test in
 * test/token.test.ts compares them). The key is APPROVAL_HMAC_SECRET.
 */
export function signApproval(secret: string, c: TokenClaims): string {
  const payload = [
    "runbook",
    c.approvalId,
    c.incidentId,
    c.project,
    c.runbookId,
    Object.entries(c.params).sort(([a], [b]) => a.localeCompare(b)),
    c.tokenExpiresAt,
  ];
  return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("base64url");
}

/** Returns a reason when the token must be refused, else undefined. */
export function checkApprovalToken(
  secret: string,
  claims: TokenClaims,
  token: string,
  now: number,
): string | undefined {
  const want = Buffer.from(signApproval(secret, claims));
  const got = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return "Approval token is invalid";
  if (!Number.isSafeInteger(claims.tokenExpiresAt) || claims.tokenExpiresAt <= now) {
    return "Approval token has expired";
  }
  if (claims.tokenExpiresAt - now > TOKEN_LIFETIME_MS + CLOCK_SKEW_MS) {
    return "Approval token expiry is too far in the future";
  }
  return undefined;
}

export interface Ledger {
  /** Records the approval as consumed BEFORE anything runs. False when it was seen before. */
  claim(approvalId: string, at: number): boolean;
  complete(approvalId: string, ok: boolean, at: number): void;
}

/**
 * Single-use ledger on the host, independent of the orchestrator's Postgres: an append-only
 * JSON-lines file that is fsynced before a runbook starts. A crash after `claim` therefore
 * never allows a second execution of the same approval.
 */
export function createFileLedger(path: string): Ledger {
  const seen = new Set<string>();
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      try {
        const row = JSON.parse(line) as { approvalId?: unknown; event?: unknown };
        if (typeof row.approvalId === "string" && row.event === "claimed") seen.add(row.approvalId);
      } catch {
        // a torn last line is ignored; claims are written whole before execution
      }
    }
  }
  const write = (row: Record<string, unknown>) => {
    const fd = openSync(path, "a", 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(row)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  return {
    claim(approvalId, at) {
      if (seen.has(approvalId)) return false;
      write({ event: "claimed", approvalId, at });
      seen.add(approvalId);
      return true;
    },
    complete(approvalId, ok, at) {
      write({ event: "completed", approvalId, ok, at });
    },
  };
}
