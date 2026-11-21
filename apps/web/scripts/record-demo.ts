// Records the demo of sandbox scenario 1 (expired certificate) in the real web UI.
//
//   node apps/web/scripts/record-demo.ts <frames-dir>
//   uv run --with pillow apps/web/scripts/frames-to-gif.py <frames-dir> docs/demo.gif
//
// It starts `apps/orchestrator/scripts/sandbox-phase5.ts` (debate + postmortem services, the web app and
// the sandbox stack; a PAID run of ~$0.015), drives Chromium through Playwright (login → live
// timeline → Approve → recovered → postmortem) and saves a PNG every ~0.6 s. Playwright's own video
// recorder needs ffmpeg to become a GIF, so frames + Pillow keep this dependency-free.
//
// The Approve button is pressed by this script in the browser: the same click a person would make.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const framesDir = resolve(process.argv[2] ?? "demo-frames");
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const results = join(framesDir, "..", "demo-run.json");
const child = spawn(
  process.execPath,
  [
    "--env-file-if-exists=.env",
    "apps/orchestrator/scripts/sandbox-phase5.ts",
    "--out",
    results,
    "--hold",
    "40", // keep the web app up after RECOVERED so the last screens can be recorded
  ],
  {
    cwd: root,
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "sandbox/runtime/certs/ca.pem") },
    stdio: ["ignore", "pipe", "inherit"],
  },
);

let incidentUrl: string | undefined;
let password: string | undefined;
let ready = false;
let recovered = false;
let finished = false;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  for (const line of chunk.split("\n")) {
    if (line.startsWith("WEB ")) incidentUrl = line.slice(4).trim();
    else if (line.startsWith("WEB_PASSWORD ")) password = line.slice(13).trim();
    else if (line.startsWith("READY ")) ready = true;
    else if (line.startsWith("RECOVERED")) recovered = true;
    if (line.trim()) console.log(`[phase5] ${line.replace(/WEB_PASSWORD .*/, "WEB_PASSWORD ***")}`);
  }
});
child.on("exit", () => {
  finished = true;
});

async function waitFor(condition: () => boolean, label: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (finished) throw new Error(`phase5 exited before: ${label}`);
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(250);
  }
}

let index = 0;
let phase = "start";
const shot = async (page: Page) => {
  const name = `${String(index++).padStart(4, "0")}-${phase}.png`;
  await page.screenshot({ path: join(framesDir, name) }).catch(() => undefined);
};
let capturing = true;
async function capture(page: Page) {
  while (capturing) {
    await shot(page);
    await sleep(450);
  }
}

try {
  await waitFor(() => Boolean(incidentUrl && password), "web url and password", 180_000);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 720 } });
  const page = await context.newPage();
  const origin = new URL(incidentUrl as string).origin;

  await page.goto(`${origin}/login`);
  await page.getByLabel(/password/i).fill(password as string);
  await page.getByRole("button", { name: /sign in|log in|enter|continue/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });

  // The incident row appears once the graph starts: reload until the page exists.
  phase = "investigating";
  const frames = capture(page);
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await page.goto(incidentUrl as string);
    if (response?.ok()) break;
    await sleep(1000);
  }

  await waitFor(() => ready, "approval ready", 240_000);
  phase = "awaiting-approval";
  await page.reload();
  await page.getByRole("button", { name: "Approve" }).waitFor({ timeout: 20_000 });
  await sleep(3500); // let a viewer read the evidence and the proposal

  phase = "approving";
  await page.getByRole("button", { name: "Approve" }).click();
  phase = "recovering";
  await waitFor(() => recovered, "recovery and postmortem", 240_000);
  await sleep(1500);
  await page.reload();
  phase = "recovered";
  await sleep(3500);

  // The postmortem written by the CrewAI service.
  const id = (incidentUrl as string).split("/").pop() as string;
  phase = "postmortem";
  await page.goto(`${origin}/postmortems/${id}`);
  await sleep(4500);
  capturing = false;
  await frames;
  await browser.close();
  writeFileSync(join(framesDir, "done.txt"), `${index} frames\n`);
  console.log(`recorded ${index} frames in ${framesDir}`);
} finally {
  capturing = false;
  if (!finished) {
    // Let phase5 finish its own cleanup (stops services, tears the sandbox down).
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolveExit();
      }, 60_000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
}
