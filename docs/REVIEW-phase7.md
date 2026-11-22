# Pre-deploy review (Phase 7)

Short review done before the production deploy. Scope: transient handling, `correlate.ts`, telemetry, and the host actions runner. Everything marked **fixed** has a test.

## transient (`graph.ts` `isTransient`, `primary-evidence.ts`)

- **Found, fixed:** a failing docker or pm2 probe (docker proxy down, host runner down) returned `error` with no containers, and `Object.values({}).every(Boolean)` is `true`. An incident whose HTTP checks were healthy was then closed as "transient" even though container health was *unknown*. Now `health.unknown` is set when `docker_ps` or `pm2_list` report an error, and `isTransient` returns false.
- OK: transient still needs at least one endpoint and every endpoint healthy, so it never hides a failing HTTP check. With the 15-minute poller a blip is confirmed twice (10 s apart) before an incident exists, so transient closures should be rare.

## correlate.ts

- **Found, fixed:** `causeFingerprint` also read `docker_logs` excerpts. Those are untrusted application text; a log line containing `error=CERT_HAS_EXPIRED notAfter=...` in one project could make two unrelated projects look like they share a cause. Fingerprints now come from fixed probes only (`tls_inspect`, `http_probe`, `dns_lookup`, `docker_ps`).
- Known, accepted: the `cause:<fingerprint>` Redis hash keeps a project for 15 minutes after it recovered (its TTL slides with each write), so a "same cause" notice can name a project that has already recovered. Informational message only; no action depends on it.
- With six projects behind one host, a host-level outage produces one "same cause" notice per project (it is deduplicated per project for 15 minutes).

## telemetry

- **Found, fixed:** a Langfuse base URL over plain `http://` to a non-loopback host would have sent keys and (redacted) incident data in cleartext. Tracing now stays OFF in that case and the orchestrator logs why (`insecureBaseUrl`).
- OK: tracing is off unless both keys are set; everything exported goes through `redact` and a length cap; a tracing failure never re-runs or breaks an investigation. `compose.prod.yaml` passes the keys only if set in the secrets file. Note that with Langfuse Cloud, redacted incident digests leave the server; leave the keys blank to keep everything local.

## Host actions runner (`host/actions-runner`)

Reviewed by hand (the Codex review could not run: the Codex MCP rejected both model choices). Checked:

- **Token:** HMAC over approval id, incident, project, runbook, sorted params and expiry; `timingSafeEqual`; expiry must be in the future and at most 15 min + 5 s ahead; contract test proves it is byte-identical to the orchestrator's `issueToken`. Verified before anything else, before the ledger claim.
- **Single use:** the approval is appended to an fsynced JSON-lines ledger *before* any command runs, so a crash or retry cannot execute it twice; a second request gets `409`. Independent of the orchestrator's Postgres claim.
- **Policy is authoritative:** parameters are exact-key, exact-value against `actions-policy.json`; a valid token cannot widen scope (tested: app outside policy denied with a valid token).
- **No shell:** `execFile` with fixed absolute binaries, argv arrays, clean environment; tested that no command line contains shell metacharacters.
- **sudoers:** generated from the same policy; every line is an exact command. The only patterns are `[0-9]` classes for the loopback port of the nginx helper; no `*` or `?` anywhere (tested). `Defaults` sets `secure_path`, `!requiretty`, a log file.
- **nginx helper (root):** validates domain against the root-owned policy (refuses a policy file that is not root-owned or is group/world-writable), upstream must be `127.0.0.1:<port>` and listening, refuses an existing vhost/conf, backs up `/etc/nginx` first (aborts if the backup fails), `nginx -t`, reload, verifies the new server block is live and answers < 500, and rolls back (remove files, `nginx -t`, restore the tarball if still broken, reload) on any failure. The runner (unprivileged) additionally requires the port to belong to one of the project's own pm2 apps.
- **Socket:** mode 0660, group `incidentpulse-ipc`, directory 0750; body capped at 16 KB; reads limited to 4 concurrent; the runner refuses to start as root.

Residual risks (documented, accepted):

1. `docker-socket-proxy` limits HTTP verbs, not data: a container `GET` can expose a container's environment. Only the orchestrator is on the proxy's internal network.
2. The runner holds `APPROVAL_HMAC_SECRET` (to verify tokens). A compromised runner could mint tokens, but still only for commands the sudoers file allows.
3. The runner service is deliberately not sandboxed with `NoNewPrivileges`/`ProtectSystem`/`ProtectHome` (sudo and the commands it runs need them). The boundary is the dedicated user, exact sudoers, socket permissions and the token.
4. Anyone in group `incidentpulse-ipc` can use the read operations and dry-runs (`certbot --dry-run` talks to the Let's Encrypt staging API and counts against its rate limits). Keep the group to the orchestrator container only.
5. `nginx_config` matches explicit `server_name` values only; a wildcard server block is reported as "vhost missing".

## Follow-up after the first look at the real server

Facts from the server changed three things. Each has a test.

- **Kervan already has a vhost** (`/etc/nginx/conf.d/kervan.conf`, `listen 80`, `proxy_pass http://localhost:3000/`, no 443, no certificate). The inventory reads `nginx -T`, so it already saw every included file, but it called a domain "has a vhost" only when *every* name (apex and, with `www`, `www.`) was served. With `www: true` and an apex-only block it said "no vhost" and would have offered `nginx_site_proxy`, which the helper then refuses. Now a domain has a vhost when *any* of its names is served (the same rule as the root helper), the unprivileged runner refuses `nginx_site_proxy` outright before the helper runs (dry-run and execute, valid token or not), and `certbot_nginx_issue` explains a partial match ("add www by hand or drop www") instead of pointing at `nginx_site_proxy`.
- **`www` is off for the first rollout** (policy example, scope, DEPLOY.md): the certificate is requested with `-d kervan.uz` only.
- **The certbot dry-run used `--webroot`.** A vhost that existed before IncidentPulse has no ACME location, so a webroot staging run cannot pass there even though the real `certbot --nginx` run does. The dry-run now uses the same authenticator as the real run (`certonly --dry-run --nginx`). Trade-off: certbot's nginx authenticator briefly adds the challenge location to the vhost and reloads nginx, then restores it. This was not run against the real server.
- The web container is published on `127.0.0.1:${WEB_HOST_PORT:-3100}` because Kervan owns 3000.
