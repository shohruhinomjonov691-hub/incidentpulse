import { validIncidentId } from "@incidentpulse/orchestrator/journal";
import { isAdmin, originMatches, readJson } from "../../../../../server/session.ts";
import { approvals, journal } from "../../../../../server/store.ts";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return new Response(null, { status: 401 });
  if (!originMatches(request)) return new Response(null, { status: 403 });
  const { id } = await params;
  if (!validIncidentId(id)) return new Response(null, { status: 404 });
  const flow = approvals();
  if (!flow) return new Response(null, { status: 503 });
  const body = (await readJson(request, 1024)) as { token?: unknown } | null;
  const callback = typeof body?.token === "string" ? flow.callbacks.decode(body.token) : undefined;
  if (!callback || callback.action === "d") return new Response(null, { status: 400 });
  const incident = await journal().get(id);
  if (incident?.approval_id !== callback.id || incident.status !== "awaiting_approval")
    return new Response(null, { status: 409 });
  const row = await flow.store.get(callback.id);
  if (row?.incidentId !== id || row.status !== "pending")
    return new Response(null, { status: 409 });
  const decided = await flow.store.decide(
    row.id,
    callback.action === "a" ? "approved" : "rejected",
    "web:admin",
  );
  return new Response(null, { status: decided ? 204 : 409 });
}
