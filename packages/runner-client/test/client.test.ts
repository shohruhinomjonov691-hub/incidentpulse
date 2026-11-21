import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createRunnerClient, RunnerError } from "../src/index.ts";

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(handler: (path: string, body: unknown) => { status?: number; body: unknown }) {
  const socketPath = join(mkdtempSync(join(tmpdir(), "ipc-")), "s.sock");
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const reply = handler(req.url ?? "", raw ? JSON.parse(raw) : undefined);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
  return createRunnerClient({ socketPath, timeoutMs: 500 });
}

describe("runner client", () => {
  test("read posts the op and returns the payload; ok:false becomes a RunnerError", async () => {
    const seen: unknown[] = [];
    const client = await serve((path, body) => {
      seen.push([path, body]);
      return (body as { op: string }).op === "pm2_ports"
        ? { body: { ok: true, apps: [] } }
        : { status: 403, body: { ok: false, error: "pm2 app is not in the policy" } };
    });
    expect(await client.read("pm2_ports", { apps: ["A"] })).toMatchObject({ apps: [] });
    expect(seen[0]).toEqual(["/v1/read", { op: "pm2_ports", args: { apps: ["A"] } }]);
    await expect(client.read("pm2_logs", { app: "X" })).rejects.toMatchObject({
      code: "pm2 app is not in the policy",
    });
  });

  test("dryRun and execute return {ok, output}, even for a refusal", async () => {
    const client = await serve((path) =>
      path.endsWith("dry-run")
        ? { body: { ok: true, output: "fine" } }
        : { status: 403, body: { ok: false, error: "Approval token is invalid" } },
    );
    expect(await client.dryRun({ project: "p", runbookId: "r", params: {} })).toEqual({
      ok: true,
      output: "fine",
    });
    expect(
      await client.execute({
        project: "p",
        runbookId: "r",
        params: {},
        approvalId: "a",
        incidentId: "i",
        approvalToken: "t",
        tokenExpiresAt: 1,
      }),
    ).toEqual({ ok: false, output: "Approval token is invalid" });
  });

  test("garbage responses and a missing socket are RunnerErrors, never crashes", async () => {
    const garbage = await serve(() => ({ body: "not json" }));
    await expect(garbage.read("cert_list")).rejects.toBeInstanceOf(RunnerError);
    const missing = createRunnerClient({ socketPath: "/nonexistent/x.sock" });
    await expect(missing.read("cert_list")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await missing.health()).toBe(false);
  });
});
