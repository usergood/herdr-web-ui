import "./test-herdr.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";

const state = mkdtempSync(join(tmpdir(), "saurons-account-browser-"));
const repo = join(state, "repo"); mkdirSync(repo);
execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
writeFileSync(join(repo, "README.md"), "# Fictional account Project\n");
execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
const fixture = join(state, "github-cli.mjs");
writeFileSync(fixture, `if (process.argv.includes("login")) {
  process.stdout.write("First copy your one-time code: DEMO-1234\\nOpen https://github.com/login/device\\n"); process.stdin.once("data", () => process.exit(0));
} else if (process.argv.includes("user/keys")) process.stdout.write(JSON.stringify(process.argv.includes("POST") ? { id: 1042, key: process.argv.find((arg) => arg.startsWith("key=")).slice(4) } : []));
else process.stdout.write(JSON.stringify({ login: "fictional-work", id: 1042 }));\n`);
const app = createServer({ port: 0, stateDir: join(state, "app"), factory: { accountTools: { github: { executable: process.execPath, args: [fixture] } } } });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const origin = `http://localhost:${app.port}`;
  const headers = { "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  const projectResponse = await fetch(origin + "/api/factory/projects", { method: "POST", headers, body: JSON.stringify({ name: "Fictional account Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" }) }); assert.equal(projectResponse.status, 201); const project = await projectResponse.json();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10_000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin); await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Scoped account walkthrough"); await page.getByRole("button", { name: "Capture idea", exact: true }).click();
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption(project.id);
  await page.locator("summary").filter({ hasText: /^Project execution settings$/ }).click();
  const accounts = page.getByRole("region", { name: "Project accounts", exact: true });
  await accounts.getByRole("textbox", { name: "Account name", exact: true }).fill("Work account");
  await accounts.getByRole("textbox", { name: "Expected login", exact: true }).fill("fictional-work");
  await accounts.getByRole("button", { name: "Create account profile", exact: true }).click();
  const card = accounts.getByRole("article").filter({ has: page.getByRole("heading", { name: "Work account", exact: true }) });
  await card.getByRole("button", { name: "Generate managed SSH key", exact: true }).click(); await card.getByText(/^SHA256:/).waitFor();
  await card.getByRole("button", { name: "Start sign-in", exact: true }).click(); await accounts.getByText("DEMO-1234", { exact: true }).waitFor();
  await accounts.getByRole("button", { name: "Continue sign-in", exact: true }).click();
  await card.getByText("Ready", { exact: true }).waitFor();
  await card.getByRole("button", { name: "Register public key with GitHub", exact: true }).click(); await card.getByText("Public key registered", { exact: true }).waitFor();
  await accounts.getByRole("combobox", { name: "GitHub profile", exact: true }).selectOption({ label: "Work account" });
  await accounts.getByRole("button", { name: "Save Project accounts", exact: true }).click(); await accounts.getByText("Project accounts saved", { exact: true }).waitFor();
  await card.getByRole("button", { name: "Edit account profile", exact: true }).click();
  await card.getByRole("textbox", { name: "Account name", exact: true }).fill("Updated work account");
  await card.getByRole("button", { name: "Save account profile", exact: true }).click();
  const updated = accounts.getByRole("article").filter({ has: page.getByRole("heading", { name: "Updated work account", exact: true }) });
  await updated.getByText("Needs sign-in", { exact: true }).waitFor();
  await updated.getByRole("button", { name: "Verify account identity", exact: true }).click(); await updated.getByText("Ready", { exact: true }).waitFor();
  const overview = await (await fetch(origin + "/api/factory")).json(); assert(overview.projects.find((entry: { id: string }) => entry.id === project.id).account_bindings.local.github);
  await page.setViewportSize({ width: 390, height: 844 }); await accounts.scrollIntoViewIfNeeded();
  for (const control of [accounts.getByRole("textbox", { name: "Account name", exact: true }), accounts.getByRole("button", { name: "Save Project accounts", exact: true })]) {
    const bounds = await control.boundingBox(); assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, "Account controls fit the phone viewport");
  }
  if (process.env["UI_EVIDENCE_DIR"]) { mkdirSync(process.env["UI_EVIDENCE_DIR"], { recursive: true }); await page.screenshot({ path: join(process.env["UI_EVIDENCE_DIR"], "project-accounts-mobile.png") }); }
  assert.deepEqual(errors, []); console.log("Project accounts browser: create, key, native sign-in, registration, binding and mobile passed");
} finally { app.stop(); await browser.close(); rmSync(state, { recursive: true, force: true }); }
