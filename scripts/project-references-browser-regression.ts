import "./test-herdr.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";

const state = mkdtempSync(join(tmpdir(), "project-references-browser-")); const repo = join(state, "repo"); mkdirSync(repo);
execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" }); writeFileSync(join(repo, "README.md"), "# Fictional guide project\n");
execFileSync("git", ["add", "README.md"], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
let app = createServer({ port: 0, stateDir: join(state, "app"), machines: false });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const response = await fetch(`http://localhost:${app.port}/api/factory/projects`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify({ name: "Reference demo", path: repo, machine_id: "local", provider: "codex", tracker: "app" }) }); assert.equal(response.status, 201); const project = await response.json();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(5000); const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://localhost:${app.port}`); await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Codex project guidance"); await page.getByRole("button", { name: "Capture idea", exact: true }).click();
  await page.getByRole("heading", { name: "Codex project guidance", exact: true }).waitFor(); await page.getByRole("combobox", { name: "Project", exact: true }).selectOption(project.id);
  await page.getByRole("heading", { name: "Project references", exact: true }).waitFor();
  await page.getByRole("button", { name: "Use guide template", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('textarea[name="reference-content"]') as HTMLTextAreaElement)?.value.includes("## Purpose"));
  await page.getByRole("textbox", { name: "Reference title", exact: true }).fill("Refunds");
  await page.getByRole("textbox", { name: "Reference filename", exact: true }).fill("refunds.md");
  await page.getByRole("textbox", { name: "When to use this reference", exact: true }).fill("Before changing refund behavior");
  await page.getByRole("textbox", { name: "Reference text", exact: true }).fill("# Refund guidance\n\nKeep refund requests idempotent.");
  await page.getByRole("button", { name: "Save Project reference", exact: true }).click();
  await page.getByRole("heading", { name: "Refunds · v1", exact: true }).waitFor();
  await page.getByRole("button", { name: "Read reference", exact: true }).click(); await page.getByRole("heading", { name: "Refund guidance", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit reference", exact: true }).click();
  await page.getByRole("textbox", { name: "Reference text", exact: true }).fill("# Refund guidance\n\nKeep refund identifiers stable.");
  await page.getByRole("button", { name: "Save Project reference", exact: true }).click(); await page.getByRole("heading", { name: "Refunds · v2", exact: true }).waitFor();
  await page.getByRole("region", { name: "Project references", exact: true }).locator('input[type="file"]').setInputFiles({ name: "menu.png", mimeType: "image/png", buffer: readFileSync(join(import.meta.dir, "../public/icons/icon-192.png")) });
  await page.getByRole("textbox", { name: "Reference title", exact: true }).fill("Menu reference");
  await page.getByRole("textbox", { name: "Picture caption or additional context", exact: true }).fill("Fictional visual reference");
  await page.getByRole("button", { name: "Save Project reference", exact: true }).click(); await page.getByRole("heading", { name: "Menu reference · v1", exact: true }).waitFor();
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Menu reference · v1", exact: true }) }).getByRole("button", { name: "Read reference", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('img[alt="menu.png"]') as HTMLImageElement)?.naturalWidth > 0);
  await page.getByRole("button", { name: "Prepare Codex references", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('textarea[name="codex-reference-prompt"]') as HTMLTextAreaElement)?.value.includes("Always read"));
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), "");
  const hash = new URL(page.url()).hash; app.stop(); app = createServer({ port: 0, stateDir: join(state, "app"), machines: false }); await page.goto(`http://localhost:${app.port}/${hash}`);
  await page.getByRole("heading", { name: "Refunds · v2", exact: true }).waitFor(); await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.getByRole("button", { name: "Use guide template", exact: true }).isVisible());
  assert(await page.getByRole("button", { name: "Prepare Codex references", exact: true }).isVisible());
  if (process.env["UI_EVIDENCE_DIR"]) { mkdirSync(process.env["UI_EVIDENCE_DIR"], { recursive: true }); await page.getByRole("heading", { name: "Project references", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: join(process.env["UI_EVIDENCE_DIR"], "project-references-mobile.png"), fullPage: true }); }
  assert.deepEqual(errors, []); console.log("Project references browser: template, save, read, Codex preparation, restart and mobile passed");
} finally { app.stop(); await browser.close(); rmSync(state, { recursive: true, force: true }); }
