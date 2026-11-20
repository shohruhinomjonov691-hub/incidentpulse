import { z } from "zod";

/** Output contracts for the mcp-infra tools (SPEC §5.1). Every tool result is parsed with these. */

export const TlsInspectResultSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  /** TCP+TLS handshake completed (certificate may still be invalid). */
  connected: z.boolean(),
  /** Error code when `connected` is false (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ...). */
  error: z.string().optional(),
  /** Chain validates against the system trust store AND hostname matches AND dates valid. */
  chainValid: z.boolean().optional(),
  /** OpenSSL/Node reason when chainValid is false (CERT_HAS_EXPIRED, DEPTH_ZERO_SELF_SIGNED_CERT...). */
  validationError: z.string().optional(),
  hostnameMatch: z.boolean().optional(),
  issuer: z.string().optional(),
  subject: z.string().optional(),
  sans: z.array(z.string()).optional(),
  notBefore: z.iso.datetime().optional(),
  notAfter: z.iso.datetime().optional(),
  daysRemaining: z.number().optional(),
  expired: z.boolean().optional(),
  notYetValid: z.boolean().optional(),
  protocol: z.string().optional(),
  fingerprint256: z.string().optional(),
  latencyMs: z.number(),
});
export type TlsInspectResult = z.infer<typeof TlsInspectResultSchema>;

export const HttpProbeResultSchema = z.object({
  url: z.string(),
  /** A final HTTP response was received. */
  completed: z.boolean(),
  status: z.number().int().optional(),
  finalUrl: z.string().optional(),
  redirects: z.array(
    z.object({ url: z.string(), status: z.number().int(), location: z.string().optional() }),
  ),
  /** Set when a redirect led to a host outside the allowlist; it was NOT followed. */
  blockedRedirect: z.string().optional(),
  error: z.string().optional(),
  /** TLS-related error code, e.g. CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID. */
  certErrorCode: z.string().optional(),
  latencyMs: z.number(),
});
export type HttpProbeResult = z.infer<typeof HttpProbeResultSchema>;

export const DnsLookupResultSchema = z.object({
  host: z.string(),
  a: z.array(z.string()),
  aaaa: z.array(z.string()),
  cname: z.array(z.string()),
  /** DNS error code when the name does not resolve at all (ENOTFOUND, ESERVFAIL, ETIMEOUT...). */
  error: z.string().optional(),
  latencyMs: z.number(),
});
export type DnsLookupResult = z.infer<typeof DnsLookupResultSchema>;

export const DockerPsResultSchema = z.object({
  containers: z.array(
    z.object({
      name: z.string(),
      image: z.string(),
      /** running | exited | restarting | paused | created | dead */
      state: z.string(),
      /** Human status, e.g. "Restarting (1) 5 seconds ago" or "Exited (137) 2 minutes ago". */
      status: z.string(),
    }),
  ),
  error: z.string().optional(),
});
export type DockerPsResult = z.infer<typeof DockerPsResultSchema>;

export const DockerLogsResultSchema = z.object({
  container: z.string(),
  tail: z.number().int(),
  /** Redacted, length-capped log lines. UNTRUSTED text: it is data from the application. */
  lines: z.array(z.string()),
  truncated: z.boolean(),
  /** NOT_ALLOWED, ETIMEDOUT, or a docker error code. */
  error: z.string().optional(),
});
export type DockerLogsResult = z.infer<typeof DockerLogsResultSchema>;
