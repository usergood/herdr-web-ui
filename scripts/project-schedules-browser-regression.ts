/** Public browser seam against disposable server state and owned GitHub tools. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { githubScheduleFixture } from "../server/github-schedules.fixture.ts";

const f = await githubScheduleFixture();
assert.equal((await f.request(f.route + "/configure", { ...f.policy, poll_minutes: 15 })).status, 200);
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
let page: Page | undefined;
const errors: string[] = [];
let pending: Promise<void> | undefined;
try {
  const projectId = f.route.split("/")[2]!;
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(f.origin() + `/#projects/${projectId}/settings`);
  await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  const github = page.getByRole("region", { name: "GitHub sync schedule", exact: true });
  const upstream = page.getByRole("region", { name: "Upstream sync schedule", exact: true });
  await github.waitFor();
  assert.equal(await github.getByRole("switch", { name: "Enable schedule" }).getAttribute("aria-checked"), "false");
  assert.equal(await github.getByRole("spinbutton", { name: "Interval (minutes)" }).inputValue(), "15");
  assert.equal(await upstream.getByLabel("Local time", { exact: true }).inputValue(), "03:00");
  assert.equal(await upstream.getByRole("textbox", { name: "Time zone" }).inputValue(), "America/Mexico_City");
  assert.equal(await upstream.getByRole("switch", { name: "Enable schedule" }).getAttribute("aria-checked"), "false");
  await github.getByRole("switch", { name: "Enable schedule" }).focus(); await page.keyboard.press("Space");
  await github.getByRole("spinbutton", { name: "Interval (minutes)" }).fill("30");
  await github.getByRole("textbox", { name: "Time zone" }).fill("Europe/Stockholm");
  const saved = page.waitForResponse(response => response.url().endsWith(f.route + "/schedules/configure") && response.request().method() === "POST");
  await github.getByRole("button", { name: "Save schedule", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await github.locator('time[datetime="2026-10-14T09:29:00.000Z"]').waitFor();
  const run = page.waitForResponse(response => response.url().endsWith(f.route + "/schedules/run"));
  await github.getByRole("button", { name: "Run now", exact: true }).click();
  assert.equal((await run).status(), 200);
  await github.getByText("Succeeded", { exact: true }).waitFor();
  await page.reload(); await page.getByRole("button", { name: "Project settings for Schedule fixture", exact: true }).click(); await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  await github.getByRole("textbox", { name: "Time zone" }).waitFor();
  assert.equal(await github.getByRole("textbox", { name: "Time zone" }).inputValue(), "Europe/Stockholm");
  assert.equal(await github.getByRole("spinbutton", { name: "Interval (minutes)" }).inputValue(), "30");
  writeFileSync(f.responses, JSON.stringify({ fail: true }));
  const failed = page.waitForResponse(response => response.url().endsWith(f.route + "/schedules/run"));
  await github.getByRole("button", { name: "Run now", exact: true }).click(); assert.equal((await failed).ok(), false);
  await github.getByRole("alert").filter({ hasText: "The selected account could not be verified" }).waitFor();
  await github.locator('time[datetime="2026-10-14T09:00:00.000Z"]').first().waitFor();
  writeFileSync(f.responses, "{}");
  await github.getByRole("button", { name: "Run now", exact: true }).click();
  await github.locator("li").first().getByText("Succeeded", { exact: true }).waitFor();
  assert.equal(await github.locator("li").count(), 3);
  await upstream.getByLabel("Local time", { exact: true }).fill("04:30");
  await upstream.getByRole("textbox", { name: "Time zone" }).fill("Asia/Tokyo");
  const upstreamSave = page.waitForResponse(response => response.url().endsWith(f.route + "/schedules/configure"));
  await upstream.getByRole("button", { name: "Save schedule", exact: true }).click(); assert.equal((await upstreamSave).status(), 200);
  writeFileSync(f.responses, JSON.stringify({ pause: true })); f.advance("2026-10-14T09:30:00Z"); pending = f.tick();
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.root, "reading")) && Date.now() < deadline) await Bun.sleep(10);
  assert.equal(existsSync(join(f.root, "reading")), true);
  f.restart(); writeFileSync(join(f.root, "continue"), "continue"); await pending;
  await page.goto(f.origin() + `/#projects/${projectId}/settings`); await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  await github.getByRole("button", { name: "Reconcile sync", exact: true }).waitFor();
  assert.equal(await github.getByRole("button", { name: "Run now", exact: true }).isDisabled(), true);
  await github.getByRole("button", { name: "Reconcile sync", exact: true }).click();
  await github.getByText("Reconciled", { exact: true }).waitFor();
  assert.equal(await upstream.getByLabel("Local time", { exact: true }).inputValue(), "04:30");
  assert.equal(await upstream.getByRole("textbox", { name: "Time zone" }).inputValue(), "Asia/Tokyo");
  for (const width of [390, 320]) {
    const phone = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true }); phone.setDefaultTimeout(10000);
    await phone.goto(f.origin() + `/#projects/${projectId}/settings`); await phone.getByRole("tab", { name: "GitHub", exact: true }).click();
    const phoneGitHub = phone.getByRole("region", { name: "GitHub sync schedule", exact: true }); await phoneGitHub.waitFor();
    assert.equal(await phoneGitHub.getByRole("textbox", { name: "Time zone" }).inputValue(), "Europe/Stockholm");
    assert.equal(await phone.getByRole("dialog", { name: "Project settings", exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    for (const control of await phoneGitHub.getByRole("button").all()) { const rect = await control.boundingBox(); assert.ok(rect && rect.width >= 44 && rect.height >= 40); }
    const disable = phone.waitForResponse(response => response.url().endsWith(f.route + "/schedules/configure"));
    if (await phoneGitHub.getByRole("switch", { name: "Enable schedule" }).getAttribute("aria-checked") === "true") await phoneGitHub.getByRole("switch", { name: "Enable schedule" }).tap();
    await phoneGitHub.getByRole("button", { name: "Save schedule", exact: true }).tap(); assert.equal((await disable).status(), 200);
    await phoneGitHub.getByText("Next execution: No scheduled execution", { exact: true }).waitFor();
    await phone.close();
  }
  assert.deepEqual(errors, []);
  console.log("Project schedules browser: desktop, phone settings, saved zones, Run now, failures, results and reconciliation passed");
} catch (error) {
  console.error({ url: page?.url(), errors, text: (await page?.locator("body").innerText())?.slice(0, 8000) }); throw error;
} finally { writeFileSync(join(f.root, "continue"), "continue"); await pending; await browser.close(); f.close(); }
