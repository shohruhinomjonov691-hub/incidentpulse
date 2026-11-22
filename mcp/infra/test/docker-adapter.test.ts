import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDockerAdapterRunner } from "../src/docker-adapter/client.ts";
import { createDockerReadAdapter, MAX_LOG_TAIL } from "../src/docker-adapter/server.ts";

const id = "a".repeat(64);
const privateId = "b".repeat(64);
const inventory = [
  {
    Id: id,
    Names: ["/demo-web", "/private-alias"],
    Image: "demo",
    State: "running",
    Status: "Up 10s",
    Labels: { internal: "private" },
    Mounts: [{ Source: "/private" }],
  },
  { Id: privateId, Names: ["/internal-db"], Image: "private" },
];
function frame(kind: number, text: string) {
  const bytes = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = kind;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of close.splice(0)) await f();
});

async function fixture(tty = false) {
  const upstream = vi.fn(async (path: string) => {
    const body = path.startsWith("/containers/json?")
      ? Buffer.from(JSON.stringify(inventory))
      : path.endsWith("/json")
        ? Buffer.from(JSON.stringify({ Config: { Tty: tty, Env: ["PRIVATE=value"] } }))
        : tty
          ? Buffer.from("one\ntwo\n")
          : Buffer.concat([frame(1, "one\n"), frame(2, "two\n")]);
    return { status: 200, body };
  });
  const server = createDockerReadAdapter({ allowedPrefixes: ["demo-"], upstream });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    upstream,
    request: (path: string, method = "GET") => fetch(base + path, { method }),
  };
}

describe("Docker read adapter", () => {
  test("projects the list to matched names and public fields", async () => {
    const { request, upstream } = await fixture();
    const result = await request("/containers/json?all=1");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual([
      { Names: ["/demo-web"], Image: "demo", State: "running", Status: "Up 10s" },
    ]);
    expect(upstream).toHaveBeenCalledExactlyOnceWith("/containers/json?all=1");
  });

  test.each([false, true])("logs clamp tail and handle TTY=%s", async (tty) => {
    const { request, upstream, base } = await fixture(tty);
    const response = await request("/containers/demo-web/logs?tail=9999");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("one\ntwo\n");
    expect(upstream.mock.calls.flat()).toContain(
      `/containers/${id}/logs?stdout=1&stderr=1&follow=0&timestamps=0&tail=${MAX_LOG_TAIL}`,
    );
    const runner = createDockerAdapterRunner(base);
    expect(await runner(["logs", "--tail", "10", "demo-web"], { timeoutMs: 1000 })).toEqual({
      stdout: "one\ntwo\n",
      stderr: "",
    });
  });

  test("denies all other Docker operations and unrelated log targets", async () => {
    const { request, upstream } = await fixture();
    for (const path of [
      "/containers/demo-web/json",
      "/containers/demo-web/archive",
      "/containers/demo-web/export",
      "/containers/demo-web/stats",
      "/containers/demo-web/exec",
      "/images/json",
      "/containers/demo-web/logs?follow=1",
      "/containers/internal-db/logs",
      "/containers/%/logs",
    ]) {
      expect((await request(path)).status).toBe(403);
    }
    expect((await request("/containers/json", "POST")).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect((await request("/containers/demo-absent/logs")).status).toBe(403);
    expect(upstream).toHaveBeenCalledExactlyOnceWith("/containers/json?all=1");
  });
});
