# Runbooks

Only these YAML files are offered to the proposal agent and resolved by the executor. The registry validates parameter names and their exact per-project values. It builds argument arrays for fixed executables. `PROJECT_ACTION_SCOPES_JSON` enables actions by project and supplies the exact Docker/PM2 names, an optional Compose project and trusted absolute file path, Nginx permission, and an optional ACME webroot. Certificate domains come from `PROJECT_DOMAINS_JSON`.

| Runbook | Dry run or check | Target |
|---|---|---|
| `certbot_renew` | Certbot staging renewal | Configured domain with evidence of expiry |
| `certbot_nginx_issue` | Inventory check and Certbot staging issuance via the configured webroot | Configured domain missing a certificate or Nginx vhost |
| `nginx_reload` | `nginx -t` | Host assigned to the project |
| `docker_restart` | Inspect the exact container | Allowlisted container name |
| `pm2_restart` | Describe the exact app | Allowlisted PM2 app name |
| `docker_compose_up` | Validate the trusted Compose file | Allowlisted stack name and Compose file |

The sandbox substitutes a local-CA certificate deployment for ACME and only permits mutation of its toy app or Nginx container. The Docker restart and post-repair health probes run against the real sandbox services.
