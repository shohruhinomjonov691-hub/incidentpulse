# @incidentpulse/telegram-bot

grammY sends plain-text reports and accepts `/investigate <project>`. The orchestrator polls for the command when `TELEGRAM_ALLOWED_USER_IDS` is configured. Only those numeric user IDs in `TELEGRAM_CHAT_ID` can enqueue a manual investigation. The command bypasses cached conclusions and shares the weekly LLM budget.
