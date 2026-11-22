# Case study: the first real incident

**IncidentPulse found, diagnosed and (after one human tap) fixed a broken TLS certificate on a live production site, 3 minutes after the first poll saw it down. This is the first real incident the system ever handled; everything before it ran against a local sandbox.**

| | |
|---|---|
| Site | `kervan.uz` (one of 6 production apps on a single Ubuntu 24.04 VPS) |
| Symptom | HTTPS unusable: the server answered with another project's certificate |
| Root cause | The nginx vhost for `kervan.uz` listened on port 80 only (no `ssl`), and no certificate had ever been issued for the domain |
| Fix | `certbot --nginx -d kervan.uz --non-interactive --redirect`, approved by a human in Telegram |
| Detection → recovery | about **3 minutes** (15:14 → 15:17 KST), almost all of it spent waiting for the human |
| Investigation cost | **$0.0076** |
| Collateral damage | none: the other 5 sites kept answering 200 |
| Resulting certificate | valid for 89 days |

IncidentPulse itself had been deployed to that server at 15:13 KST on 2026-11-22 (commit `0eaa635`): 8 services, about 400 MB of RAM in total. The incident was found by its first poll, one minute later. It was not staged.

## Summary

A health poller that makes **no LLM calls** probed all six sites every 15 minutes and found `kervan.uz` down on the very first poll. That opened an incident. The agents investigated with read-only tools (an HTTP probe, a TLS inspection, `nginx -T`, `certbot certificates`), concluded with confidence 0.99 that the vhost had no TLS configuration and no certificate existed, and proposed exactly one runbook from a fixed registry: `certbot_nginx_issue(kervan.uz)`, risk *medium*, with a dry-run that passed.

Nothing was executed until a person pressed **✅ Bajar** ("Do it") in Telegram. A host-side runner, a separate Unix user restricted by a sudoers file of 20 exact commands, then issued the certificate and reloaded nginx. A recovery probe saw `https://kervan.uz` return 200, the incident closed as recovered, and a postmortem was written. Five minutes later, the independent poller confirmed the site was healthy.

The site was also reachable over plain HTTP the whole time, only HTTPS was broken, which is the kind of failure that is easy to miss by eye:

| Before the fix, over HTTP (14:20 KST) | |
|---|---|
| ![kervan.uz home page before the fix, browser shows "Not Secure"](case-study/kervan-before-home.png) | ![kervan.uz menu page before the fix](case-study/kervan-before-menu.png) |

The existing CodeTrail morning monitor had also flagged it (`❌ Kervan — TLS/certificate error`, 09:00 KST, visible in the Telegram screenshots below). It reported the problem but could neither explain it nor fix it, and the error was still there when IncidentPulse was deployed at 15:13.

## Timeline

All times are KST (UTC+9), 2026-11-22.

| Time | Event |
|---|---|
| 15:13 | IncidentPulse deployed to the VPS (commit `0eaa635`): 8 services, about 400 MB RAM |
| 15:14 | First poll of the LLM-free health poller: `kervan.uz` is **Down**. Incident `hp-mwrfy2sp-8ac9` opens |
| 15:14 | Investigation: `http_probe` and `tls_inspect` → `ERR_TLS_CERT_ALTNAME_INVALID`; `nginx -T` and `certbot certificates` read. Root cause at confidence 0.99. Proposal `certbot_nginx_issue(kervan.uz)`, risk medium, dry-run ✅. Cost $0.0076. Telegram message with **Bajar / Rad et / Batafsil** buttons |
| ~15:17 | The human taps **✅ Bajar** |
| ~15:17 | Host runner executes `certbot --nginx -d kervan.uz --non-interactive --redirect`, then `nginx -t` → ok |
| 15:17 | Recovery probe: `https://kervan.uz` → **200**. 🟢 Tiklandi (recovered) message, postmortem generated |
| 15:21 | The independent health poll confirms: "Kervan — qayta ishlayapti" (working again) |

## Evidence

The agents were only allowed to look. Their conclusion rests on four read-only observations, each cited by the report:

1. **HTTP probe.** `https://kervan.uz/` did not complete: `error=ERR_TLS_CERT_ALTNAME_INVALID`.
2. **TLS inspection.** The server presented a chain that was cryptographically fine but for the wrong name: `chainValid=false`, `hostnameMatch=false`, `expired=false`, `notAfter=2027-01-13 (52d)`, `subject=codetrail.gotrips.cloud`, `issuer=Let's Encrypt / YE1`. The certificate was not expired; it simply belonged to a different project on the same server.
3. **nginx configuration (`nginx -T`).** A `conf.d/kervan.conf` existed, with `listen 80` only: no `listen 443 ssl`, no certificate paths.
4. **certbot.** `certbot certificates` listed no certificate for `kervan.uz`.

That combination rules out the usual suspects (expiry, a stopped container, a DNS problem) and points to a vhost that was never upgraded to TLS. It also determined the *right* runbook: there was no certificate to renew, so the system proposed issuing one (`certbot_nginx_issue`) instead of `certbot_renew`.

The proposal as Telegram showed it (the bot's messages are in Uzbek: *Sabab* = cause, *Dalil* = evidence, *Taklif* = proposal, *Xarajat* = cost):

![Telegram alert with the cause, evidence, the proposed runbook and Approve / Reject buttons](case-study/telegram-1-alert-awaiting-approval.png)

## Human approval

Nothing in the pipeline can change the server without a person. The proposal arrives with three buttons:

- **✅ Bajar**: approve and execute
- **❌ Rad et**: reject
- **🔍 Batafsil**: open the full evidence and reasoning

Pressing Approve mints a single-use HMAC token bound to this incident, this project, this runbook and these exact parameters. It expires after 15 minutes and is consumed atomically in Postgres, so a repeated or replayed tap cannot run the command twice. Only the Telegram user IDs on the allowlist (checked server-side) can approve.

Two details worth noting: the runbook was marked *medium* risk, because it edits a live nginx configuration, and the dry-run had already passed before the question was asked. The decision took roughly two to three minutes, which is the dominant part of the whole incident and exactly the part that should stay human.

After the tap the buttons disappear (an approval can only be used once) and the system executes:

![Telegram after approval: the buttons are gone while the runbook executes](case-study/telegram-2-approved-executing.png)

## Execution and audit

The orchestrator never runs commands itself, and no LLM ever sees the execution tool. The approved action goes to a small **host runner** that sits on a Unix socket:

- it runs as a **separate Unix user**, not as the orchestrator's user;
- `sudoers` grants that user **20 exact commands**, with fixed arguments, and nothing else;
- the commands are executed as fixed argument arrays (`execFile`, no shell), with parameters validated against exact per-project values.

For this incident it ran, in order:

```
certbot --nginx -d kervan.uz --non-interactive --redirect
nginx -t        # ok
```

The audit trail has two layers: the application's audit table (decision, token claim, execution result) and the **sudo journal** on the host, so what actually ran as root is recorded by the operating system and not only by the application that asked for it.

## Verification

Success is not "the command exited 0". After execution the system re-probes the site itself:

- **15:17**: recovery probe `https://kervan.uz` → **200**. The incident closed as recovered, and a postmortem was generated.
- **15:21**: the independent health poller, a separate component from the incident pipeline, polled again and confirmed the site was healthy.
- The other **5 production sites** answered 200 throughout: no collateral damage.
- The new certificate is valid for **89 days**.

![Telegram: recovered, with a link to the postmortem](case-study/telegram-3-recovered-postmortem.png)

![Telegram: the poller independently confirms the site is back](case-study/telegram-4-poller-confirmed.png)

## What went well

- **Detection needed no LLM.** The poller is plain HTTP checks on a timer, so a model outage or a budget cap cannot blind it, and a healthy fleet costs $0.
- **The diagnosis was specific, and right.** Wrong certificate, vhost without TLS, nothing to renew: each claim cites an evidence item, and the chosen runbook matches that distinction.
- **It was cheap.** $0.0076 for the investigation, in line with the $0.0083 mean measured on the sandbox eval.
- **The human stayed in the loop without slowing the machine.** The system did everything up to the decision in under a minute; the person only had to read one message and tap one button.
- **The blast radius was small by construction.** One runbook, one domain, 20 allowed commands, a single-use token. The other five sites were never touched.
- **Verification was independent.** The system checked the result itself, and a second, unrelated component confirmed it.

## What we fixed during rollout

The deploy found real problems that the sandbox could not. They are listed because they are the point of running on a real server:

1. **A wrong "no vhost" conclusion in my own deploy guide.** `DEPLOY.md` first inspected only `sites-enabled/`, found nothing for Kervan, and concluded that no vhost existed. The vhost lived in `conf.d/`. Following the guide would have created a **duplicate server block** for `kervan.uz`. The inventory now uses `nginx -T`, which prints the configuration nginx actually loaded, wherever it came from, and creating a second block for an existing domain is explicitly forbidden.
2. **Port 3000 was already taken: by Kervan.** The dashboard would have collided with a production app. The web UI now listens on **3100**.
3. **`umask 077` broke the runner.** A restrictive umask during setup left files unreadable to the runner's Unix user, so the host runner failed to start. Fixed in the deploy steps.
4. **The Node archive was owned by uid 1000.** A binary executed by root through sudo must not be writable by an unprivileged user, otherwise that user can get root. Ownership was moved to `root`.

Items 3 and 4 are the kind of issue that only shows up when a privileged helper meets a real, lived-in machine; item 1 is a reminder that the documentation I wrote can be wrong in the same way a model can be.

## Follow-ups

- **A typo in the model's prose.** The cause sentence says "codiTrail.gotrips.cloud"; the evidence beside it spells `codetrail.gotrips.cloud` correctly. Cosmetic, but a human reading the summary should be able to trust it. The next step is to quote hostnames from evidence verbatim instead of retyping them, and to add a check that any hostname in the prose also appears in the evidence.
- **Make the approval wait visible.** About 3 minutes of detection → recovery is almost entirely the person. Worth measuring per incident, and considering a reminder when a proposal sits unanswered.
- **One real incident is an anecdote.** It shows the loop works on real infrastructure; it is not a success rate. The 14-scenario eval remains the only broader measurement.
- **Not covered by this incident:** the transient exit, escalation, a rejected proposal, and a repair that fails verification.

## Reading list

- [README](../README.md): architecture, evaluation, cost, safety
- [docs/DEPLOY.md](DEPLOY.md): the production deploy
- [docs/REVIEW-phase7.md](REVIEW-phase7.md): the pre-deploy review
- [docs/RESUME.md](RESUME.md): the numbers behind the claims
