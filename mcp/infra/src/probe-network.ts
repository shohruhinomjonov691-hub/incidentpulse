import dns from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch, type RequestInit } from "undici";
import { normalizeHost } from "./allowlist.ts";

const blocked = new BlockList();
blocked.addSubnet("0.0.0.0", 8);
blocked.addSubnet("10.0.0.0", 8);
blocked.addSubnet("100.64.0.0", 10); // Shared address space, including Alibaba Cloud metadata.
blocked.addSubnet("127.0.0.0", 8);
blocked.addAddress("168.63.129.16"); // Azure platform endpoint.
blocked.addSubnet("169.254.0.0", 16);
blocked.addSubnet("172.16.0.0", 12);
blocked.addSubnet("192.168.0.0", 16);
blocked.addSubnet("::", 96, "ipv6"); // Unspecified, loopback and deprecated IPv4-compatible addresses.
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");

function ipNotAllowed() {
  return Object.assign(new Error("Probe target IP is not allowed"), { code: "IP_NOT_ALLOWED" });
}

function isBlockedIp(address: string, family: number): boolean {
  // BlockList also matches IPv4-mapped IPv6 against the IPv4 rules.
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** Literal addresses bypass the socket's lookup callback. Check them before dialing. */
export function assertProbeHost(host: string) {
  const address = normalizeHost(host);
  const family = isIP(address);
  if (family && isBlockedIp(address, family)) throw ipNotAllowed();
}

/** Resolve once per connection. Node dials only the addresses returned by this callback. */
export const probeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (addresses.some(({ address, family }) => isBlockedIp(address, family))) {
      return callback(ipNotAllowed(), []);
    }
    const available = addresses.filter(
      ({ family }) => !options.family || family === options.family,
    );
    const first = available[0];
    if (!first)
      return callback(Object.assign(new Error("No probe address"), { code: "ENOTFOUND" }), []);
    if (options.all) return callback(null, available);
    callback(null, first.address, first.family);
  });
};

/** One dispatcher per hop so redirects never reuse a connection or an earlier DNS decision. */
export async function fetchProbeResponse(
  url: URL,
  options: Pick<RequestInit, "method" | "headers" | "redirect" | "signal">,
) {
  assertProbeHost(url.hostname);
  const dispatcher = new Agent({ autoSelectFamily: true, connect: { lookup: probeLookup } });
  try {
    // Keep the original URL so HTTP Host, TLS SNI and certificate verification use its hostname.
    const response = await fetch(url, { ...options, redirect: "manual", dispatcher });
    // Graceful close waits for the caller to consume or cancel the response body.
    void dispatcher.close().catch(() => undefined);
    return response;
  } catch (error) {
    await dispatcher.destroy();
    throw error;
  }
}
