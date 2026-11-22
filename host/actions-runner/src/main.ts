import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { execFileExec } from "./exec.ts";
import { parsePolicy } from "./policy.ts";
import { createHttpServer, createRunner, filePause, probeLocalPort } from "./server.ts";
import { createFileLedger } from "./token.ts";

const policyPath = process.env.ACTIONS_RUNNER_POLICY ?? "/etc/incidentpulse/actions-policy.json";
const socketPath = process.env.ACTIONS_RUNNER_SOCKET ?? "/run/incidentpulse/actions.sock";
const stateDir = process.env.ACTIONS_RUNNER_STATE_DIR ?? "/var/lib/incidentpulse-actions";
const secret = process.env.APPROVAL_HMAC_SECRET ?? "";

if (Buffer.byteLength(secret) < 32) {
  console.error("APPROVAL_HMAC_SECRET (at least 32 bytes) is required");
  process.exit(1);
}
if (typeof process.getuid === "function" && process.getuid() === 0) {
  console.error("The actions runner must not run as root; use the incidentpulse-actions user");
  process.exit(1);
}

const policy = parsePolicy(JSON.parse(readFileSync(policyPath, "utf8")));
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o750 });
if (existsSync(socketPath)) unlinkSync(socketPath);

const log = (event: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

const runner = createRunner({
  policy,
  exec: execFileExec,
  secret,
  ledger: createFileLedger(`${stateDir}/consumed.jsonl`),
  pause: filePause(`${stateDir}/paused`),
  now: () => Date.now(),
  probeLocal: probeLocalPort,
  log,
});
const server = createHttpServer(runner);

// Created 0660: only the owner and the shared incidentpulse-ipc group can connect.
const previousUmask = process.umask(0o117);
server.listen(socketPath, () => {
  process.umask(previousUmask);
  chmodSync(socketPath, 0o660);
  log({ event: "listening", socketPath, projects: Object.keys(policy.projects) });
});

const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
