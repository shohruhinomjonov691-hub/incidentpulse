import type { Redactor } from "@incidentpulse/redact";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** JSON lines on stdout; the whole line passes through the redactor, so no secret can be logged. */
export function createLogger(
  redact: Redactor,
  write: (line: string) => void = (l) => process.stdout.write(l),
): Logger {
  const emit = (level: string, msg: string, fields: Record<string, unknown> = {}) =>
    write(`${redact(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }))}\n`);
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
