# @incidentpulse/mcp-codetrail

Read-only MCP server (stdio) for the **code specialist** (SPEC §5.2). Tools:

| Tool | Backend | Notes |
|---|---|---|
| `codetrail_search(project, query)` | `POST {CODETRAIL_BASE_URL}/api/search` `{project_id, question}` | retrieval only, no AI call on the CodeTrail side |
| `codetrail_explain(project, question)` | `POST {CODETRAIL_BASE_URL}/api/explain` | grounded answer; rate-limited by CodeTrail, so search first |
| `git_recent_commits(project, since?, limit?)` | GitHub REST `GET /repos/{owner}/{repo}/commits` | sha7, first message line, author name, date. No emails, no message bodies |

Every result is a zod-validated `structuredContent` with `status`: `ok`, **`not_configured`** (no URL / token / repo mapping: the tool says so instead of failing), `denied` (project not in this server's allowlist) or `error`.
Bodies are redacted and capped (4000 chars). Their text is source code, model output and commit messages: **untrusted data**, wrapped by the orchestrator's input guardrail.

Environment (read by `src/bin.ts`; the orchestrator passes only these to the child process):

```
CODETRAIL_ALLOWED_PROJECTS   comma list of project ids this server answers for
CODETRAIL_BASE_URL           e.g. https://codetrail.example      (unset = not_configured)
CODETRAIL_API_KEY            optional Bearer key
CODETRAIL_PROJECT_IDS_JSON   {"kervan":"<codetrail project_id>"}  (identity when absent)
GITHUB_READONLY_TOKEN        fine-grained token, Contents: read + Metadata: read ONLY  (unset = not_configured)
PROJECT_REPOS_JSON           {"kervan":"owner/repo"}
```

Use a **fine-grained, read-only** GitHub token scoped to the monitored repositories. Do not reuse a broad personal token.
