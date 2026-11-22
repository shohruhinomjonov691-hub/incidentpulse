import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { mkdtempSync, readFileSync } from "node:fs";
import { type AddressInfo, BlockList, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/** Permit only the local fixture socket, without adding an exception to production probes. */
export function allowLoopbackFixture() {
  const check = BlockList.prototype.check;
  vi.spyOn(BlockList.prototype, "check").mockImplementation(function (this: BlockList, ip, family) {
    return ip !== "127.0.0.1" && check.call(this, ip, family);
  });
}

export function mockProbeDns(resolve: (host: string) => dns.LookupAddress[]) {
  return vi
    .spyOn(dns, "lookup")
    .mockImplementation(((
      hostname: string,
      _options: dns.LookupAllOptions,
      callback: (error: null, addresses: dns.LookupAddress[]) => void,
    ) => queueMicrotask(() => callback(null, resolve(hostname)))) as typeof dns.lookup);
}

/** Self-signed cert for localhost / 127.0.0.1 generated with the system openssl. */
export function makeSelfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "infra-test-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

/** A localhost port nobody listens on (port 1 etc. are on fetch's blocked "bad ports" list). */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
