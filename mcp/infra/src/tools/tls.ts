import { isIP } from "node:net";
import tls, { type PeerCertificate } from "node:tls";
import { normalizeHost } from "../allowlist.ts";
import { assertProbeHost, probeLookup } from "../probe-network.ts";
import { type TlsInspectResult, TlsInspectResultSchema } from "../schemas.ts";

const DAY_MS = 86_400_000;

function formatName(
  name: { CN?: string | string[]; O?: string | string[] } | undefined,
): string | undefined {
  if (!name) return undefined;
  const parts = [name.O, name.CN].flat().filter((v): v is string => typeof v === "string");
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

function parseSans(subjectaltname: string | undefined): string[] | undefined {
  if (!subjectaltname) return undefined;
  return subjectaltname
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^DNS:/, "").replace(/^IP Address:/, ""));
}

/** Pure: turns Node's peer certificate + socket verdict into the tool result. */
export function summarizeCertificate(input: {
  host: string;
  port: number;
  cert: PeerCertificate;
  authorized: boolean;
  authorizationError: string | undefined;
  protocol: string | null;
  now: Date;
  latencyMs: number;
}): TlsInspectResult {
  const { host, port, cert, now } = input;
  const notBefore = new Date(cert.valid_from);
  const notAfter = new Date(cert.valid_to);
  const datesKnown = !Number.isNaN(notBefore.getTime()) && !Number.isNaN(notAfter.getTime());
  const expired = datesKnown ? notAfter.getTime() < now.getTime() : undefined;
  const notYetValid = datesKnown ? notBefore.getTime() > now.getTime() : undefined;
  const hostnameMatch = tls.checkServerIdentity(normalizeHost(host), cert) === undefined;

  const result: TlsInspectResult = {
    host,
    port,
    connected: true,
    chainValid: input.authorized,
    hostnameMatch,
    latencyMs: input.latencyMs,
  };
  if (input.authorizationError) result.validationError = String(input.authorizationError);
  const issuer = formatName(cert.issuer);
  if (issuer) result.issuer = issuer;
  const subject = formatName(cert.subject);
  if (subject) result.subject = subject;
  const sans = parseSans(cert.subjectaltname);
  if (sans) result.sans = sans;
  if (datesKnown) {
    result.notBefore = notBefore.toISOString();
    result.notAfter = notAfter.toISOString();
    result.daysRemaining = Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS);
    result.expired = expired as boolean;
    result.notYetValid = notYetValid as boolean;
  }
  if (input.protocol) result.protocol = input.protocol;
  if (cert.fingerprint256) result.fingerprint256 = cert.fingerprint256;
  return TlsInspectResultSchema.parse(result);
}

export interface TlsInspectOptions {
  timeoutMs: number;
  port?: number;
  now?: () => Date;
}

/**
 * Read-only handshake. `rejectUnauthorized: false` is deliberate: we need the certificate of a
 * *broken* endpoint to explain why it is broken. No application data is ever sent.
 */
export function tlsInspect(host: string, options: TlsInspectOptions): Promise<TlsInspectResult> {
  const port = options.port ?? 443;
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const hostname = normalizeHost(host);

  return new Promise((resolve) => {
    let settled = false;
    let socket: tls.TLSSocket | undefined;
    // Hard deadline for the whole handshake (an idle timeout alone misses slow-loris servers).
    const deadline = setTimeout(() => fail("ETIMEDOUT"), options.timeoutMs);
    const finish = (result: TlsInspectResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket?.destroy();
      resolve(TlsInspectResultSchema.parse(result));
    };
    const fail = (error: string) =>
      finish({ host, port, connected: false, error, latencyMs: Date.now() - started });

    try {
      assertProbeHost(hostname);
      const connectOptions = {
        host: hostname,
        port,
        ...(isIP(hostname) ? {} : { servername: hostname }),
        autoSelectFamily: true,
        lookup: probeLookup,
        rejectUnauthorized: false,
      };
      socket = tls.connect(connectOptions);
    } catch (error) {
      return fail((error as NodeJS.ErrnoException).code ?? "TLS_CONNECT_ERROR");
    }
    const connectedSocket = socket;
    connectedSocket.once("secureConnect", () => {
      const cert = connectedSocket.getPeerCertificate(false);
      if (!cert || Object.keys(cert).length === 0) return fail("NO_CERTIFICATE");
      try {
        finish(
          summarizeCertificate({
            host,
            port,
            cert,
            authorized: connectedSocket.authorized,
            authorizationError: connectedSocket.authorizationError
              ? String(connectedSocket.authorizationError)
              : undefined,
            protocol: connectedSocket.getProtocol(),
            now: now(),
            latencyMs: Date.now() - started,
          }),
        );
      } catch {
        fail("CERT_PARSE_ERROR");
      }
    });
    connectedSocket.on("error", (e: NodeJS.ErrnoException) => fail(e.code ?? e.name));
  });
}
