# @incidentpulse/actions-runner

The host side of production actions: a small systemd service (`incidentpulse-actions`) that the orchestrator container reaches over a unix socket. No runtime dependencies; it runs on a private Node 24 (`/opt/incidentpulse/node`).

| Endpoint | Auth | Does |
|---|---|---|
| `GET /v1/health` | socket permissions | liveness |
| `POST /v1/read` `{op}` | socket permissions | read-only: `pm2_jlist`, `pm2_logs`, `pm2_ports`, `nginx_config` (`nginx -T` summary), `cert_list` (`certbot certificates` summary). Output is filtered to the policy's apps and domains |
| `POST /v1/runbooks/dry-run` | socket permissions | runs a runbook's dry-run commands |
| `POST /v1/runbooks/execute` | **approval token** | verifies the HMAC token (and its expiry), claims it in an fsynced single-use ledger, then runs the runbook |

Security model: dedicated Unix user, `sudo -n` with a generated sudoers file of **exact** commands, `execFile` with absolute binaries (never a shell), its own policy file (`/etc/incidentpulse/actions-policy.json`, example in `deploy/actions-policy.example.json`) independent of the orchestrator's allowlists. `src/nginx-site.ts` is the one root helper (`nginx_site_proxy`): backup, template, `nginx -t`, reload, verify, automatic rollback.

`scripts/render-sudoers.ts <policy>` prints the sudoers file, so policy and sudoers cannot drift. `test/parity.test.ts` keeps the command table equal to `runbooks/*.yaml`. Install steps: [docs/DEPLOY.md](../../docs/DEPLOY.md) section 6.
