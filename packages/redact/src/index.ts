/**
 * Redaction layer (SPEC §10): applied to every tool result, log line and outgoing message
 * before an LLM, a log or Telegram can see it.
 */

export const REDACTED = "[REDACTED]";

export type Redactor = (text: string) => string;

const MIN_SECRET_LENGTH = 8;

// Pattern-based rules. Order matters: more specific first.
const RULES: ReadonlyArray<readonly [RegExp, string | ((...m: string[]) => string)]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED:private-key]",
  ],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED:api-key]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED:github-token]"],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED:telegram-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED:jwt]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme = "") => `${scheme} ${REDACTED}`],
  // scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, (_m, prefix = "") => `${prefix}${REDACTED}@`],
  // name=value / "name": "value" for secret-looking names
  [
    /\b((?:[A-Za-z0-9_-]*?)(?:api[_-]?key|secret|token|passwd|password|authorization|private[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"',;&]+)/gi,
    (_m, name = "") => `${name}${REDACTED}`,
  ],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED:email]"],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a redactor. `secrets` are exact values (e.g. from .env) that must never appear,
 * in addition to the generic pattern rules.
 */
export function createRedactor(options: { secrets?: readonly string[] } = {}): Redactor {
  const secrets = [...new Set(options.secrets ?? [])]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  const exact = secrets.length > 0 ? new RegExp(secrets.map(escapeRegExp).join("|"), "g") : null;

  return (text: string): string => {
    let out = exact ? text.replace(exact, REDACTED) : text;
    for (const [pattern, replacement] of RULES) {
      out = out.replace(pattern, replacement as string);
    }
    return out;
  };
}

/** Redacts every string inside a JSON-like value (object keys are left alone). */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact);
    return out as T;
  }
  return value;
}

/** Picks the values of env entries that look like secrets, plus passwords embedded in URLs. */
export function collectSecrets(env: Record<string, string | undefined>): string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i.test(name)) secrets.push(value);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try {
        const password = new URL(value).password;
        if (password) secrets.push(decodeURIComponent(password));
      } catch {
        // not a URL
      }
    }
  }
  return secrets;
}

/** Safe one-line description of an unknown error: class + redacted message, never a stack. */
export function describeError(error: unknown, redact: Redactor): string {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  return redact(String(error));
}
