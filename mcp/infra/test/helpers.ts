import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
