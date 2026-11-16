import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const server = spawn("pnpm", ["dev", "--host", "127.0.0.1"], { stdio: "ignore", shell: process.platform === "win32" });
const basePath = process.env.GITHUB_ACTIONS ? "/HGhub" : "";
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:1420${basePath}/tests/quickjs-worker-smoke.html`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(500);
  }
  if (!ready) throw new Error("Vite smoke-test server did not start");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", message => { if (message.type() === "error") process.stderr.write("[browser console] " + message.text() + "\\n"); });
  page.on("pageerror", error => process.stderr.write("[browser pageerror] " + (error.stack || error.message) + "\\n"));
  page.on("worker", worker => process.stderr.write("[browser worker] " + worker.url() + "\\n"));
  await page.goto(`http://127.0.0.1:1420${basePath}/tests/quickjs-worker-smoke.html`);
  await page.waitForFunction(() => document.documentElement.dataset.result === "pass" || document.documentElement.dataset.result === "fail", undefined, { timeout: 15000 });
  const result = await page.locator("#result").textContent();
  if (!result?.startsWith("PASS:")) throw new Error(result || "QuickJS smoke test failed");
  process.stdout.write(result + "\\n");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
