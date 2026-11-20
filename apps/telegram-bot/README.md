# @incidentpulse/telegram-bot

grammY sends plain-text reports and accepts `/investigate <project>`, `/stop`, `/resume` and `/status`. The orchestrator polls when `TELEGRAM_ALLOWED_USER_IDS` is configured. It checks both numeric sender ID and configured chat before accepting a command or a signed approval button.

`✅ Bajar` and `❌ Rad et` record one decision. `🔍 Batafsil` sends the redacted evidence and dry run to the allowed user's private chat. Unanswered requests expire after 60 minutes. `/investigate` bypasses the cache and uses the shared weekly budget.
