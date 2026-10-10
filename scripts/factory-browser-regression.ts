/** Public browser seam: owned state and Herdr only. Build before running. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";

const state = mkdtempSync(join(tmpdir(), "saurons-eye-browser-"));
let app = createServer({ port: 0, stateDir: state });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://localhost:${app.port}`);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Retained browser research");
  await page.getByRole("textbox", { name: "Idea notes", exact: true }).fill("Original context");
  await page.getByRole("button", { name: "Capture idea", exact: true }).click();
  await page.getByRole("heading", { name: "Retained browser research", exact: true }).waitFor();
  const hash = new URL(page.url()).hash;
  await page.getByRole("textbox", { name: "New note", exact: true }).fill("A durable second note");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByText("A durable second note", { exact: true }).waitFor();
  const escaped: string[] = [];
  page.on("request", (request) => { if (request.url().includes("factory-sandbox-exfiltrate")) escaped.push(request.url()); });
  await page.locator(".factory-panel input[type=file]").setInputFiles({ name: "sandbox.html", mimeType: "text/html", buffer: Buffer.from('<h1>Sandboxed research</h1><script>parent.document.body.dataset.compromised="yes";fetch("/factory-sandbox-exfiltrate")</script><img src="/factory-sandbox-exfiltrate"><form action="/factory-sandbox-exfiltrate" target="_top"><button>Escape sandbox</button></form>') });
  await page.frameLocator('iframe[title="sandbox.html"]').getByRole("heading", { name: "Sandboxed research" }).waitFor();
  await page.frameLocator('iframe[title="sandbox.html"]').getByRole("button", { name: "Escape sandbox" }).click();
  assert.equal(await page.evaluate(() => document.body.dataset.compromised), undefined);
  assert.deepEqual(escaped, []);
  app.stop(); app = createServer({ port: 0, stateDir: state });
  await page.goto(`http://localhost:${app.port}/${hash}`);
  await page.getByText("A durable second note", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector(".sidebar")!.getBoundingClientRect().right <= 0);
  assert(await page.getByRole("heading", { name: "Retained browser research", exact: true }).isVisible());
  assert(await page.getByRole("textbox", { name: "New note", exact: true }).isVisible());
  if (process.env["UI_EVIDENCE_DIR"]) {
    mkdirSync(process.env["UI_EVIDENCE_DIR"], { recursive: true });
    await page.screenshot({ path: join(process.env["UI_EVIDENCE_DIR"], "factory-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: join(process.env["UI_EVIDENCE_DIR"], "factory-desktop.png"), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log("factory browser: capture, notes, restart and mobile passed");
} finally { app.stop(); await browser.close(); rmSync(state, { recursive: true, force: true }); }
