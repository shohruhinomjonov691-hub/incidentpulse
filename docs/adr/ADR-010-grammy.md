# ADR-010: grammY for the Telegram bot

- **Status:** Accepted
- **Date:** 2026-11-21 (written at the end of Phase 6, from what was built)
- **Spec reference:** [docs/SPEC.md](../SPEC.md) §2, row ADR-010

## Context

Alerts and approvals have to reach a phone, and only the owner may approve a state-changing action.

## Decision

`apps/telegram-bot` sends short Uzbek reports and handles `/status`, `/stop`, `/resume`, `/investigate <project>` and the inline buttons (✅ Bajar / ❌ Rad et / 🔍 Batafsil). A press is accepted only if the numeric sender id is in `TELEGRAM_ALLOWED_USER_IDS`, the chat matches, and the signed callback verifies.

Pinned version(s) (see [docs/VERSIONS.md](../VERSIONS.md)): `grammy` 1.46.0

## Why this and not another

Typed, small, long-polling needs no public endpoint, and it is the stack already planned for the owner's other projects.

## Alternatives considered

- **Telegraf / node-telegram-bot-api.** Equivalent for this job.
- **Slack.** Not used by the owner.

## Consequences

Callback payloads are limited to 64 bytes, so a button carries only `ip:<action>:<approval id>:<HMAC>`: a signed reference to an approval row, never the command itself.
