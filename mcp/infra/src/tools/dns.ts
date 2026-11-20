import { promises as dnsPromises } from "node:dns";
import { type DnsLookupResult, DnsLookupResultSchema } from "../schemas.ts";

export interface DnsResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
}

export function createSystemResolver(timeoutMs: number): DnsResolver {
  const resolver = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 });
  return {
    resolve4: (h) => resolver.resolve4(h),
    resolve6: (h) => resolver.resolve6(h),
    resolveCname: (h) => resolver.resolveCname(h),
  };
}

const EMPTY_OK = new Set(["ENODATA", "ENOTFOUND"]);

/** Read-only A/AAAA/CNAME lookup. A failed record type is data, not an exception. */
export async function dnsLookup(
  host: string,
  options: { timeoutMs: number; resolver?: DnsResolver },
): Promise<DnsLookupResult> {
  const resolver = options.resolver ?? createSystemResolver(options.timeoutMs);
  const started = Date.now();
  const attempt = async (fn: () => Promise<string[]>) => {
    try {
      return { records: await fn(), code: undefined as string | undefined };
    } catch (e) {
      return { records: [] as string[], code: (e as NodeJS.ErrnoException).code ?? "DNS_ERROR" };
    }
  };
  const [a, aaaa, cname] = await Promise.all([
    attempt(() => resolver.resolve4(host)),
    attempt(() => resolver.resolve6(host)),
    attempt(() => resolver.resolveCname(host)),
  ]);

  const result: DnsLookupResult = {
    host,
    a: a.records,
    aaaa: aaaa.records,
    cname: cname.records,
    latencyMs: Date.now() - started,
  };
  const total = a.records.length + aaaa.records.length + cname.records.length;
  if (total === 0) {
    // Prefer a real failure (SERVFAIL/timeout) over "no data" so the cause is visible.
    const codes = [a.code, aaaa.code, cname.code].filter((c): c is string => !!c);
    result.error = codes.find((c) => !EMPTY_OK.has(c)) ?? codes[0] ?? "ENODATA";
  }
  return DnsLookupResultSchema.parse(result);
}
