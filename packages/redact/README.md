# @incidentpulse/redact

Redaction layer (SPEC §10). `createRedactor({secrets})` masks exact secret values plus patterns (OpenAI/GitHub/Telegram/AWS tokens, JWTs, Bearer headers, URL passwords, `key=value` secrets, PEM keys, emails).
`collectSecrets(env)` gathers secret values from an environment object. Applied to tool results, prompts, log lines and outgoing Telegram messages.
