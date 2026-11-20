import { createRedactor } from "@incidentpulse/redact";
import { describe, expect, test } from "vitest";
import { type DockerRunner, dockerLogs, dockerPs } from "../src/tools/docker.ts";

const psRow = (name: string, state: string, status: string) =>
  JSON.stringify({ Names: name, Image: "nginx:alpine", State: state, Status: status });

function runner(stdout: string, stderr = ""): DockerRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn: DockerRunner = async (args) => {
    calls.push([...args]);
    return { stdout, stderr };
  };
  return Object.assign(fn, { calls });
}

describe("dockerPs", () => {
  test("lists only allowlisted containers, with state and status", async () => {
    const run = runner(
      [
        psRow("ipsb-a-app", "restarting", "Restarting (1) 4 seconds ago"),
        psRow("ipsb-a-nginx", "running", "Up 2 minutes"),
        psRow("incidentpulse-postgres-1", "running", "Up 1 hour"),
        "not json",
      ].join("\n"),
    );
    const r = await dockerPs({ allowedContainers: ["ipsb-a-"], timeoutMs: 1000, runner: run });
    expect(r.containers.map((c) => [c.name, c.state])).toEqual([
      ["ipsb-a-app", "restarting"],
      ["ipsb-a-nginx", "running"],
    ]);
    expect(run.calls[0]).toEqual(["ps", "-a", "--no-trunc", "--format", "{{json .}}"]);
  });

  test("a docker failure is data", async () => {
    const run: DockerRunner = async () => {
      throw Object.assign(new Error("daemon down"), { code: "ENOENT" });
    };
    const r = await dockerPs({ allowedContainers: ["x"], timeoutMs: 1000, runner: run });
    expect(r).toEqual({ containers: [], error: "ENOENT" });
  });
});

describe("dockerLogs", () => {
  const base = { allowedContainers: ["ipsb-a-"], timeoutMs: 1000, redact: createRedactor() };

  test("returns the tail of stdout+stderr as lines, and passes a fixed argv (no shell)", async () => {
    const run = runner("one\ntwo\n", "three\n");
    const r = await dockerLogs("ipsb-a-app", { ...base, tail: 50, runner: run });
    expect(r.lines).toEqual(["one", "two", "three"]);
    expect(run.calls[0]).toEqual(["logs", "--tail", "50", "ipsb-a-app"]);
  });

  test("tail is clamped to 1..500", async () => {
    const run = runner("x");
    await dockerLogs("ipsb-a-app", { ...base, tail: 99999, runner: run });
    await dockerLogs("ipsb-a-app", { ...base, tail: 0, runner: run });
    expect(run.calls.map((c) => c[2])).toEqual(["500", "1"]);
  });

  test("only the last `tail` lines are kept and truncation is flagged", async () => {
    const run = runner(Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"));
    const r = await dockerLogs("ipsb-a-app", { ...base, tail: 3, runner: run });
    expect(r.lines).toEqual(["line7", "line8", "line9"]);
    expect(r.truncated).toBe(true);
  });

  test("lines are redacted before leaving the process", async () => {
    const secret = "super-secret-value-123";
    const run = runner(
      `DATABASE_URL=postgres://u:hunter2pass@db/x\nkey ${secret}\nmail me@example.com`,
    );
    const r = await dockerLogs("ipsb-a-app", {
      ...base,
      tail: 10,
      redact: createRedactor({ secrets: [secret] }),
      runner: run,
    });
    const text = r.lines.join("\n");
    expect(text).not.toContain("hunter2pass");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("me@example.com");
  });

  test("very long lines are cut", async () => {
    const run = runner("x".repeat(5000));
    const r = await dockerLogs("ipsb-a-app", { ...base, tail: 10, runner: run });
    expect(r.lines[0]?.length).toBeLessThanOrEqual(401);
  });

  test.each(["incidentpulse-postgres-1", "--all", "ipsb-b-app", "a b", ""])(
    "refuses %j and never invokes docker",
    async (name) => {
      const run = runner("secret");
      const r = await dockerLogs(name, { ...base, tail: 10, runner: run });
      expect(r.error).toBe("NOT_ALLOWED");
      expect(r.lines).toEqual([]);
      expect(run.calls).toHaveLength(0);
    },
  );
});
