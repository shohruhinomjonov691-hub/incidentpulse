import type { DockerRunner } from "../tools/docker.ts";

/**
 * A `DockerRunner` backed by the docker-read-adapter instead of the docker CLI. It understands exactly the two
 * commands the tools issue (`ps` and `logs --tail N <name>`); anything else is refused locally, so even a bug
 * in a tool cannot ask the adapter for something it does not serve.
 */
export function createDockerAdapterRunner(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): DockerRunner {
  const base = baseUrl.replace(/\/+$/, "");
  const get = async (path: string, timeoutMs: number) => {
    const response = await fetchImpl(`${base}${path}`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw Object.assign(new Error("ADAPTER_REFUSED"), { code: `HTTP_${response.status}` });
    return response;
  };
  return async (args, { timeoutMs }) => {
    if (args[0] === "ps") {
      const rows = (await (await get("/containers/json?all=1", timeoutMs)).json()) as Array<{
        Names?: string[];
        Image?: string;
        State?: string;
        Status?: string;
      }>;
      const stdout = rows
        .map((row) =>
          JSON.stringify({
            Names: (row.Names ?? []).map((n) => n.replace(/^\//, "")).join(","),
            Image: row.Image ?? "",
            State: row.State ?? "",
            Status: row.Status ?? "",
          }),
        )
        .join("\n");
      return { stdout, stderr: "" };
    }
    const tail = args[2];
    const name = args[3];
    if (args[0] === "logs" && args[1] === "--tail" && tail && name && args.length === 4) {
      const query = new URLSearchParams({ tail, stdout: "1", stderr: "1" });
      const response = await get(
        `/containers/${encodeURIComponent(name)}/logs?${query}`,
        timeoutMs,
      );
      return { stdout: await response.text(), stderr: "" };
    }
    throw Object.assign(new Error("DOCKER_UNSUPPORTED"), { code: "DOCKER_UNSUPPORTED" });
  };
}
