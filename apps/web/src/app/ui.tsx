import type { IncidentStatus } from "@incidentpulse/orchestrator/journal";

export const money = (cost: number) => `$${cost.toFixed(6)}`;
export const humanize = (value: string) => value.replaceAll("_", " ");
export const utc = (date: Date | string) =>
  new Date(date)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");

export function Status({ status }: { status: IncidentStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span aria-hidden="true">●</span> {humanize(status)}
    </span>
  );
}

export function duration(start: Date, end: Date | null) {
  const seconds = Math.max(
    0,
    Math.floor(((end?.getTime() ?? Date.now()) - start.getTime()) / 1000),
  );
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [hours && `${hours}h`, minutes && `${minutes}m`, `${seconds % 60}s`]
    .filter(Boolean)
    .join(" ");
}
