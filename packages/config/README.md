# @incidentpulse/config

Typed configuration parsed from an env object (never from files; Node loads `.env` via `--env-file`). Errors name the variable, never its value.
Model name comes from `OPENAI_MODEL` (default `gpt-5.4-mini`); an unknown model without `MODEL_PRICE_*` fails closed so the cost budget stays meaningful.
Project → domains map lives here (only `kervan → kervan.uz` is built in; override with `PROJECT_DOMAINS_JSON`).
