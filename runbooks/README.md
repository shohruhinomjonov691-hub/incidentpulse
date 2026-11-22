# Runbooks

Only these YAML files are offered to the proposal agent and resolved by the executor. The registry validates parameter names and their exact per-project values. It builds argument arrays for fixed executables. `PROJECT_ACTION_SCOPES_JSON` enables actions by project and supplies the exact Docker/PM2 names, an optional Compose project and trusted absolute file path, Nginx permission, and an optional ACME webroot. Certificate domains come from `PROJECT_DOMAINS_JSON`. With `"www": true` in a project's scope, `certbot_nginx_issue` and `nginx_site_proxy` also cover `www.<domain>` (`{domainArgs}` in the YAML).

In production the commands run in the host actions runner (`host/actions-runner`), which keeps its own copy of this table and its own policy; `host/actions-runner/test/parity.test.ts` fails if the two drift. `remote_only` books (`nginx_site_proxy`) have no local steps and are offered only when the runner is configured.

| Runbook | Dry run or check | Target |
|---|---|---|
| `certbot_renew` | `nginx -t` and a certificate-exists check. `certbot renew --dry-run` is the first step AFTER approval (it may edit the live nginx) | Configured domain with evidence of expiry |
| `certbot_nginx_issue` | Static only: vhost exists, DNS A points at this server, certificate missing or stale, `nginx -t`. The staging run `certonly --dry-run --nginx` (it edits and reloads the live nginx) is the first step AFTER approval; a failure stops the run | Configured domain with an existing vhost and a missing or stale certificate |
| `nginx_reload` | `nginx -t` | Host assigned to the project |
| `docker_restart` | Inspect the exact container | Allowlisted container name |
| `pm2_restart` | Describe the exact app | Allowlisted PM2 app name |
| `docker_compose_up` | Validate the trusted Compose file | Allowlisted stack name and Compose file |
| `nginx_site_proxy` | Host runner only: validates the upstream, the domain and `nginx -T`, changes nothing | Configured domain with no nginx server block; `upstream` is a `127.0.0.1:<port>` of one of the project's pm2 apps, discovered by the runner. Backs up `/etc/nginx`, writes the vhost, `nginx -t`, reload, verifies, rolls back automatically on any error. Risk: medium |

The sandbox substitutes a local-CA certificate deployment for ACME and only permits mutation of its toy app or Nginx container. The Docker restart and post-repair health probes run against the real sandbox services.
