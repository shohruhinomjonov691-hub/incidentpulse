/**
 * Category definitions shared by triage and synthesize (SPEC §3.1 category).
 * Principle: classify by ROOT CAUSE, not by the symptom a client sees. A proxy answers 502 both
 * when its backend container is stopped and when its upstream port is wrong; those are different causes.
 */
export const CATEGORY_GUIDE = `Categories (pick by root cause, not by symptom):
- tls: certificate problems: expired, not yet valid, wrong hostname, untrusted chain.
- dns: the name does not resolve, or resolves to the wrong place.
- http_5xx: the web/proxy layer is broken while the application containers themselves look fine: wrong upstream host/port, proxy or web-server misconfiguration (including a config error that stops the web server from starting), or 5xx responses when no deeper cause is visible (an application exception or exhausted resource in the app's own logs is classified by that cause instead).
- timeout: connections or responses time out although the services look up: slow or hanging endpoints, including a proxy answering 504 / "upstream timed out" while the backend container is running.
- container_down: a container that should be running is stopped/exited (stopped by hand, killed, OOM-killed) and its own logs show no startup error. The same applies to a pm2-managed app that is stopped or errored while its host or container is still up. Clients may only see 502/503 from the proxy in front: that is still container_down.
- deploy_regression: the APPLICATION itself fails because of a change: its container crash-loops from bad configuration or environment (e.g. a required variable is missing), fails at startup, or a bad release/commit (the app answers 500 with an exception in its logs and a recent commit touches that code). A web server or proxy (nginx etc.) that cannot start because of its OWN configuration error is http_5xx, not this.
- resource: disk, memory or CPU exhaustion, e.g. "no space left on device" (ENOSPC) or out-of-memory in logs; the app may answer 500s because of it.
- unknown: the evidence does not support any of the above.`;

export const SPECIALIST_DESCRIPTIONS = {
  infra:
    "Network-level checks of the project's domains: DNS resolution, TLS certificate details, HTTP status and redirects. Use for certificate, DNS, 5xx/timeout symptoms.",
  logs: "Container state and logs: which containers are running, restarting or exited, and their recent log lines. Use when an application or proxy container may be down, crashing or misconfigured.",
  code: "Source-code and git history: searches the project's code and lists recent commits. Use when a recent change or a bug in the code may be the cause.",
} as const;
