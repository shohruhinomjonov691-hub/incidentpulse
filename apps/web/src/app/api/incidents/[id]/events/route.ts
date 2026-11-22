import { setTimeout as delay } from "node:timers/promises";
import { validIncidentId } from "@incidentpulse/orchestrator/journal";
import type { NextRequest } from "next/server";
import { COOKIE, validSession } from "../../../../../server/session.ts";
import { journal } from "../../../../../server/store.ts";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = request.cookies.get(COOKIE)?.value;
  if (!(await validSession(token))) return new Response(null, { status: 401 });
  const { id } = await params;
  if (!validIncidentId(id) || !(await journal().get(id)))
    return new Response(null, { status: 404 });
  let cursor =
    request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("after") ?? "0";
  if (!/^\d{1,19}$/.test(cursor) || BigInt(cursor) > 9_223_372_036_854_775_807n)
    return new Response(null, { status: 400 });
  const encoder = new TextEncoder();
  let cancelled = false;
  const deadline = Date.now() + 55_000;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    async pull(controller) {
      try {
        while (
          !cancelled &&
          !request.signal.aborted &&
          Date.now() < deadline &&
          (await validSession(token))
        ) {
          const events = await journal().events(id, cursor);
          if (events.length) {
            if (!(await validSession(token)) || cancelled || request.signal.aborted) break;
            cursor = events.at(-1)?.id ?? cursor;
            controller.enqueue(
              encoder.encode(
                events
                  .map((event) => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
                  .join(""),
              ),
            );
            return;
          }
          await delay(700, undefined, { signal: request.signal });
        }
      } catch {
        if (!cancelled && !request.signal.aborted)
          controller.enqueue(encoder.encode(": reconnect\n\n"));
      }
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "private, no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
