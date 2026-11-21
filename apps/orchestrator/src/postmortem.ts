import type { Redactor } from "@incidentpulse/redact";
import type { Journal } from "./journal.ts";

export const POSTMORTEM_CAP = 0.01;

export function postmortemLink(origin: string | undefined, id: string) {
  if (!origin || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return undefined;
  try {
    const url = new URL(origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return undefined;
    if (url.username || url.password || url.href !== `${url.origin}/`) return undefined;
    return `${url.origin}/postmortems/${id}`;
  } catch {
    return undefined;
  }
}

export function createPostmortemWorker(options: {
  journal: Journal;
  url: string;
  secret: string;
  redact: Redactor;
  reserve(at: Date, usd: number): Promise<boolean>;
  release(at: Date, usd: number): Promise<unknown>;
  fetcher?: typeof fetch;
}) {
  const { journal, secret, redact, reserve, release } = options;
  const fetcher = options.fetcher ?? fetch;
  const headers = { authorization: `Bearer ${secret}` };
  return async () => {
    const pending = await journal.pending();
    if (!pending.length) return;
    const ready = await fetcher(new URL("/ready", options.url), {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(1500),
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (!ready) return;
    for (const id of pending) {
      const row = await journal.get(id);
      if (!row?.state || !["recovered", "escalated"].includes(row.status)) continue;
      const { evidence, hypotheses, signal, ...outcome } = row.state;
      const events = await journal.events(id, "0", 160);
      const record = {
        status: row.status,
        ...outcome,
        signal: { at: signal.at, check: signal.check },
        timeline: events
          .filter((event) => !["node_start", "node_end", "tool_call"].includes(event.type))
          .slice(-20)
          .map(({ at, type }) => ({ at, type })),
        evidence: evidence
          .slice(0, 8)
          .map(({ id, tool, excerpt }) => ({ id, tool, excerpt: excerpt.slice(0, 230) })),
        hypotheses: hypotheses
          .slice(0, 4)
          .map(({ id, cause, confidence }) => ({ id, cause: cause.slice(0, 230), confidence })),
      };
      const body = JSON.stringify(record, (_key, value) =>
        typeof value === "string" ? value.slice(0, 350) : value,
      );
      if (Buffer.byteLength(body) > 6000) continue;
      const at = new Date();
      if (!(await reserve(at, POSTMORTEM_CAP))) return;
      let claimed = false;
      let micro = 0;
      let markdown: string | undefined;
      try {
        claimed = await journal.claimPostmortem(id);
        if (!claimed) continue;
        micro = 10_000;
        const response = await fetcher(new URL("/postmortem", options.url), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        });
        if (response.ok) {
          const result = await response.json();
          if (
            result &&
            typeof result === "object" &&
            "micro" in result &&
            typeof result.micro === "number" &&
            Number.isInteger(result.micro) &&
            result.micro >= 0 &&
            result.micro <= micro
          ) {
            micro = result.micro;
            if (
              "markdown" in result &&
              typeof result.markdown === "string" &&
              result.markdown.length <= 12_000
            )
              markdown = redact(result.markdown);
          }
        }
      } finally {
        await release(at, POSTMORTEM_CAP - micro / 1_000_000);
        if (claimed) {
          await journal.finishPostmortem(id, micro, markdown);
          if (markdown)
            await journal.append({
              id,
              project: row.project,
              events: [
                {
                  type: "postmortem_ready",
                  at: new Date().toISOString(),
                  data: { costUsd: micro / 1_000_000 },
                },
              ],
            });
        }
      }
    }
  };
}
