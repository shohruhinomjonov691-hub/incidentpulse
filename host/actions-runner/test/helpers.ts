import type { Exec, ExecResult } from "../src/exec.ts";
import { type Policy, parsePolicy } from "../src/policy.ts";

export const SECRET = "s".repeat(40);

export const policy: Policy = parsePolicy({
  projects: {
    kervan: {
      domains: ["kervan.uz"],
      www: true,
      pm2: ["KERVAN", "KERVAN-REACT"],
      nginx: true,
      webroot: "/var/www/acme",
    },
    codetrail: {
      domains: ["codetrail.example.com"],
      containers: ["codetrail-app"],
      compose: { name: "codetrail", file: "/srv/codetrail/compose.yaml" },
    },
  },
});

const SUDO = "/usr/bin/sudo -n -H -- ";

/** Fake host: answers by command line; unknown commands fail loudly. */
export function fakeExec(
  answers: Record<string, Partial<ExecResult> | ((args: string) => Partial<ExecResult>)>,
): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const line = `${file} ${args.join(" ")}`.replace(SUDO, "sudo ");
    calls.push(line);
    const answer = answers[line];
    if (answer === undefined)
      return { code: 127, stdout: "", stderr: `unexpected command: ${line}` };
    const value = typeof answer === "function" ? answer(line) : answer;
    return { code: 0, stdout: "", stderr: "", ...value };
  };
  return { exec, calls };
}

export const PM2_JLIST = JSON.stringify([
  {
    name: "KERVAN",
    pid: 100,
    pm2_env: { status: "online", restart_time: 2, pm_uptime: 1_700_000_000_000 },
  },
  {
    name: "KERVAN-REACT",
    pid: 200,
    pm2_env: { status: "online", restart_time: 0, pm_uptime: 1_700_000_000_000 },
  },
  { name: "SOMETHING-ELSE", pid: 300, pm2_env: { status: "online", restart_time: 0 } },
]);

export const SS_OUTPUT = [
  'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=101,fd=20))',
  'LISTEN 0 511 127.0.0.1:3001 0.0.0.0:* users:(("node",pid=200,fd=19))',
  'LISTEN 0 511 127.0.0.1:9999 0.0.0.0:* users:(("other",pid=300,fd=19))',
  'LISTEN 0 4096 [::1]:5432 [::]:* users:(("postgres",pid=900,fd=5))',
].join("\n");

// pid 101 is a child of KERVAN (pid 100): `npm start` style supervision.
export const PS_OUTPUT = [
  "    1     0",
  "  100     1",
  "  101   100",
  "  200     1",
  "  300     1",
].join("\n");

export const NGINX_DUMP = `nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
# configuration file /etc/nginx/nginx.conf:
events {}
http {
  # server_name commented.example;
  server { listen 80 default_server; server_name _; location / { return 404; } }
  server {
    listen 443 ssl;
    server_name other.example www.other.example;
    ssl_certificate /etc/letsencrypt/live/other/fullchain.pem;
    location / { proxy_pass http://127.0.0.1:4000; }
  }
}`;

export const CERTS = `Found the following certs:
  Certificate Name: other.example
    Serial Number: abc
    Key Type: ECDSA
    Domains: other.example www.other.example
    Expiry Date: 2027-01-05 10:11:12+00:00 (VALID: 59 days)
    Certificate Path: /etc/letsencrypt/live/other.example/fullchain.pem
    Private Key Path: /etc/letsencrypt/live/other.example/privkey.pem
`;

/**
 * The real server: Kervan's vhost lives in /etc/nginx/conf.d/kervan.conf (not in sites-enabled), listens on
 * 80 only (no 443 block, no certificate) and proxies to localhost:3000. `nginx -T` prints every included file.
 */
export const NGINX_DUMP_CONF_D = `nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
# configuration file /etc/nginx/nginx.conf:
events {}
http {
  include /etc/nginx/mime.types;
  include /etc/nginx/conf.d/*.conf;
  include /etc/nginx/sites-enabled/*;
}
# configuration file /etc/nginx/conf.d/kervan.conf:
server {
  listen 80;
  server_name kervan.uz;
  location / {
    proxy_pass http://localhost:3000/;
  }
}
# configuration file /etc/nginx/sites-enabled/default:
server { listen 80 default_server; server_name _; location / { return 404; } }
`;

/** Same as `policy`, but Kervan without www (the first production rollout). */
export const policyNoWww: Policy = parsePolicy({
  projects: {
    kervan: {
      domains: ["kervan.uz"],
      www: false,
      pm2: ["KERVAN", "KERVAN-REACT"],
      nginx: true,
      webroot: "/var/www/acme",
    },
  },
});
