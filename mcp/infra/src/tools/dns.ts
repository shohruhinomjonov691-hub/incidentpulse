import { promises as dnsPromises } from "node:dns";
import { type DnsLookupResult, DnsLookupResultSchema } from "../schemas.ts";

export interface DnsResolver {
  /** getaddrinfo semantics: honours /etc/hosts and the OS resolver, like the apps do. */
  lookup(host: string): Promise<Array<{ address: string; family: number }>>;
  resolveCname(host: string): Promise<string[]>;
}

export function createSystemResolver(timeoutMs: number): DnsResolver {
  const resolver = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 });
  return {
    lookup: (h) => dnsPromises.lookup(h, { all: true }),
    resolveCname: (h) => resolver.resolveCname(h),
  };
}

const EMPTY_OK = new Set(["ENODATA", "ENOTFOUND"]);

/** Read-only A/AAAA/CNAME lookup. A failed lookup is data, not an exception. */
export async function dnsLookup(
  host: string,
  options: { timeoutMs: number; resolver?: DnsResolver },
): Promise<DnsLookupResult> {
  const resolver = options.resolver ?? createSystemResolver(options.timeoutMs);
  const started = Date.now();

  const withDeadline = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })),
          options.timeoutMs,
        ).unref(),
      ),
    ]);

  const [addresses, cnames] = await Promise.all([
    withDeadline(resolver.lookup(host)).then(
      (records) => ({ records, code: undefined as string | undefined }),
      (e: NodeJS.ErrnoException) => ({
        records: [] as Array<{ address: string; family: number }>,
        code: e.code ?? "DNS_ERROR",
      }),
    ),
    withDeadline(resolver.resolveCname(host)).then(
      (records) => ({ records, code: undefined as string | undefined }),
      (e: NodeJS.ErrnoException) => ({ records: [] as string[], code: e.code ?? "DNS_ERROR" }),
    ),
  ]);

  const result: DnsLookupResult = {
    host,
    a: addresses.records.filter((r) => r.family === 4).map((r) => r.address),
    aaaa: addresses.records.filter((r) => r.family === 6).map((r) => r.address),
    cname: cnames.records,
    latencyMs: Date.now() - started,
  };
  if (result.a.length + result.aaaa.length + result.cname.length === 0) {
    // Prefer a real failure (SERVFAIL/timeout) over "no data" so the cause is visible.
    const codes = [addresses.code, cnames.code].filter((c): c is string => !!c);
    result.error = codes.find((c) => !EMPTY_OK.has(c)) ?? codes[0] ?? "ENODATA";
  }
  return DnsLookupResultSchema.parse(result);
}
