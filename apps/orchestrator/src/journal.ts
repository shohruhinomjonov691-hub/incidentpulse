import type { IncidentState, ProjectId } from "@incidentpulse/schemas";
import type { Pool } from "pg";

export type IncidentStatus =
  | "investigating"
  | "awaiting_approval"
  | "reported"
  | "waiting_human"
  | "rejected"
  | "recovered"
  | "transient"
  | "escalated";

export type TimelineItem = { type: string; at: string; data: unknown };
export type StoredEvent = TimelineItem & { id: string };
export type IncidentRow = {
  id: string;
  project: ProjectId;
  status: IncidentStatus;
  started_at: Date;
  closed_at: Date | null;
  state: IncidentState | null;
  approval_id: string | null;
  cost: number;
};

export const validIncidentId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export function createJournal(pool: Pool) {
  const projection = `i.*, COALESCE((i.state->>'costUsd')::float8,0) + i.chat_micro / 1000000.0::float8
    + COALESCE(p.micro,0) / 1000000.0::float8 AS cost`;
  return {
    async setup() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS incidentpulse_incidents (
          id text PRIMARY KEY, project text NOT NULL, status text NOT NULL DEFAULT 'investigating',
          started_at timestamptz NOT NULL, closed_at timestamptz, state jsonb, approval_id text,
          questions integer NOT NULL DEFAULT 0, chat_micro integer NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS incidentpulse_events (
          seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          incident_id text NOT NULL REFERENCES incidentpulse_incidents(id),
          kind text NOT NULL, at timestamptz NOT NULL, data jsonb NOT NULL
        );
        CREATE INDEX IF NOT EXISTS incidentpulse_events_cursor ON incidentpulse_events (incident_id, seq);
        CREATE TABLE IF NOT EXISTS incidentpulse_postmortems (
          incident_id text PRIMARY KEY REFERENCES incidentpulse_incidents(id),
          created_at timestamptz NOT NULL DEFAULT now(), attempted_at timestamptz,
          markdown text, micro integer NOT NULL DEFAULT 0
        );
      `);
    },
    async append(input: {
      id: string;
      project: ProjectId;
      events: TimelineItem[];
      snapshot?: { state: IncidentState; status: IncidentStatus; approvalId?: string };
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO incidentpulse_incidents(id, project, started_at)
           VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [input.id, input.project, input.events[0]?.at ?? new Date()],
        );
        const current = await client.query<{ closed_at: Date | null }>(
          "SELECT closed_at FROM incidentpulse_incidents WHERE id=$1 FOR UPDATE",
          [input.id],
        );
        if (input.snapshot && !current.rows[0]?.closed_at) {
          const { state, status, approvalId } = input.snapshot;
          const closed = ["recovered", "escalated", "rejected", "reported", "transient"].includes(
            status,
          );
          await client.query(
            `UPDATE incidentpulse_incidents SET state=$2,status=$3,approval_id=$4,
             closed_at=CASE WHEN $5 THEN $6::timestamptz ELSE NULL END WHERE id=$1`,
            [input.id, state, status, approvalId ?? null, closed, input.events.at(-1)?.at],
          );
          if (status === "recovered" || status === "escalated") {
            await client.query(
              `INSERT INTO incidentpulse_postmortems(incident_id) VALUES($1) ON CONFLICT DO NOTHING`,
              [input.id],
            );
          }
        }
        if (input.events.length) {
          await client.query(
            `INSERT INTO incidentpulse_events(incident_id,kind,at,data)
             SELECT $1,type,at,data FROM jsonb_to_recordset($2) AS e(type text,at timestamptz,data jsonb)`,
            [input.id, JSON.stringify(input.events)],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async list() {
      return (
        await pool.query<IncidentRow>(`SELECT ${projection} FROM incidentpulse_incidents i
        LEFT JOIN incidentpulse_postmortems p ON p.incident_id=i.id
        ORDER BY i.started_at DESC, i.id LIMIT 200`)
      ).rows;
    },
    async get(id: string) {
      return (
        await pool.query<IncidentRow>(
          `SELECT ${projection} FROM incidentpulse_incidents i
        LEFT JOIN incidentpulse_postmortems p ON p.incident_id=i.id WHERE i.id=$1`,
          [id],
        )
      ).rows[0];
    },
    async events(id: string, cursor = "0", limit = 100): Promise<StoredEvent[]> {
      const { rows } = await pool.query<{ id: string; type: string; at: Date; data: unknown }>(
        `SELECT seq::text AS id,kind AS type,at,data FROM incidentpulse_events
         WHERE incident_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`,
        [id, cursor, limit],
      );
      return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
    },
    async postmortem(id: string) {
      return (
        await pool.query<{ markdown: string | null; micro: number }>(
          "SELECT markdown,micro FROM incidentpulse_postmortems WHERE incident_id=$1",
          [id],
        )
      ).rows[0];
    },
    async pending() {
      return (
        await pool.query<{ incident_id: string }>(`SELECT incident_id FROM incidentpulse_postmortems
        WHERE attempted_at IS NULL ORDER BY created_at LIMIT 20`)
      ).rows.map((row) => row.incident_id);
    },
    async claimPostmortem(id: string) {
      const result = await pool.query(
        `UPDATE incidentpulse_postmortems SET attempted_at=now()
        WHERE incident_id=$1 AND attempted_at IS NULL`,
        [id],
      );
      return result.rowCount === 1;
    },
    async finishPostmortem(id: string, micro: number, markdown?: string) {
      await pool.query(
        `UPDATE incidentpulse_postmortems SET micro=$2,markdown=$3
        WHERE incident_id=$1 AND attempted_at IS NOT NULL AND markdown IS NULL`,
        [id, micro, markdown ?? null],
      );
    },
    async takeQuestion(id: string) {
      const result = await pool.query(
        `UPDATE incidentpulse_incidents SET questions=questions+1
        WHERE id=$1 AND questions<10 AND state IS NOT NULL`,
        [id],
      );
      return result.rowCount === 1;
    },
    async chargeQuestion(id: string, micro: number) {
      await pool.query("UPDATE incidentpulse_incidents SET chat_micro=chat_micro+$2 WHERE id=$1", [
        id,
        micro,
      ]);
    },
  };
}

export type Journal = ReturnType<typeof createJournal>;
