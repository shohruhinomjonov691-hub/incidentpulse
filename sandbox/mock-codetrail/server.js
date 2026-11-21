// Sandbox-only stand-in for CodeTrail's HTTP API and the GitHub commits API (scenario 8).
// Static, loopback-only, no credentials worth stealing: it answers like a repo whose newest commit
// (a refactor of the account page) is the one that broke the toy app.
const http = require("node:http");

const port = Number(process.env.PORT || 3000);
const minutes = (n) => new Date(Date.now() - n * 60_000).toISOString();

const commits = () => [
  {
    sha: "9f3c1a77d2e0b5a4c6d8e9f01234567890abcdef",
    commit: {
      message:
        "refactor(account): read plan from user.profile.plan instead of user.plan\n\nProfile data is moving to a separate object.",
      author: { name: "dev-a", date: minutes(11) },
    },
  },
  {
    sha: "4be20c91a3f7d6e5b8c0a1f2e3d4c5b6a7980123",
    commit: {
      message: "chore: bump nginx base image to 1.31",
      author: { name: "dev-b", date: minutes(60 * 49) },
    },
  },
  {
    sha: "c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9",
    commit: {
      message: "docs: update README setup steps",
      author: { name: "dev-b", date: minutes(60 * 72) },
    },
  },
  {
    sha: "77aa88bb99cc00dd11ee22ff33445566778899aa",
    commit: {
      message: "feat: add /healthz endpoint",
      author: { name: "dev-a", date: minutes(60 * 120) },
    },
  },
];

const SEARCH_EXCERPT = [
  "src/account.js:38  function renderAccount(user) {",
  "src/account.js:42    const plan = user.profile.plan; // was: user.plan (changed in 9f3c1a7)",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this is sample source text served as data, not a template
  "src/account.js:43    return `${user.name} (${plan})`;",
  "src/routes.js:18   res.end(renderAccount(session.user));",
  "Note: session.user.profile is only set for accounts created after the profile migration; older sessions have no profile object.",
].join("\n");

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/commits$/.test(url.pathname)) {
      if (!String(req.headers.authorization || "").startsWith("Bearer ")) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "Bad credentials" }));
      }
      const per = Math.min(20, Number(url.searchParams.get("per_page") || 20));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(commits().slice(0, per)));
    }
    if (
      req.method === "POST" &&
      (url.pathname === "/api/search" || url.pathname === "/api/explain")
    ) {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(SEARCH_EXCERPT);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(port, "0.0.0.0");
