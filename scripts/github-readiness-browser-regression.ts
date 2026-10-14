/** Confirmed browser seam: real controls backed by owned HTTP/native fixtures. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { githubScheduleFixture } from "../server/github-schedules.fixture.ts";

const f = await githubScheduleFixture();
assert.equal((await f.request(f.route + "/configure", f.policy)).status, 200);
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
let page: Page | undefined;
const errors: string[] = [];
try {
  const projectId = f.route.split("/")[2]!;
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(f.origin() + `/#projects/${projectId}/settings`);
  await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  const settings = page.getByTestId("project-github");
  const auto = settings.getByRole("switch", { name: "Implement trusted ready issues automatically", exact: true });
  await auto.waitFor(); assert.equal(await auto.getAttribute("aria-checked"), "false");
  assert.equal(await settings.getByRole("textbox", { name: "Agent implementation label", exact: true }).getAttribute("placeholder"), "ready-for-agent");
  await settings.getByRole("textbox", { name: "Agent implementation label", exact: true }).fill("factory-ready");
  await settings.getByRole("textbox", { name: "Trusted issue approvers", exact: true }).fill("fictional-maintainer");
  await auto.focus(); await page.keyboard.press("Space");
  const saved = page.waitForResponse(response => response.url().endsWith(f.route + "/configure"));
  await settings.getByRole("button", { name: "Save Project settings", exact: true }).click(); assert.equal((await saved).status(), 200);
  const issue = { number: 12, node_id: "fictional-ready-12", title: "Keep imported owner notes", body: "Acceptance: preserve local decisions.", html_url: "https://github.com/fictional/schedules/issues/12", state: "open", labels: [{ name: "factory-ready" }], updated_at: "2026-10-14T12:00:00Z" };
  writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
  await settings.getByRole("button", { name: "Sync GitHub", exact: true }).click();
  const imported = settings.getByRole("region", { name: "Issue #12", exact: true });
  await imported.getByText("Approval of this issue revision is required.", { exact: true }).waitFor();
  await imported.getByRole("textbox", { name: "Acceptance criteria", exact: true }).fill("Keep owner notes on repeated import");
  await imported.getByRole("textbox", { name: "Confirmed testing seams", exact: true }).fill("Public HTTP with disposable native fixtures");
  await imported.getByRole("textbox", { name: "Planning decisions", exact: true }).fill("One Assignment per issue");
  await imported.getByRole("button", { name: "Approve this issue revision", exact: true }).click();
  await imported.getByText("Eligible for automatic implementation", { exact: true }).waitFor();
  assert.equal((await f.request("")).body.implementations.length, 1);
  await settings.getByRole("button", { name: "Sync GitHub", exact: true }).click();
  await imported.getByText("Eligible for automatic implementation", { exact: true }).waitFor();
  assert.equal((await f.request("")).body.implementations.length, 1);
  issue.labels.push({ name: "needs-info" }); writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
  await settings.getByRole("button", { name: "Sync GitHub", exact: true }).click();
  await imported.getByText("Correct conflicting triage labels.", { exact: true }).waitFor();
  for (const width of [390, 320]) {
    const phone = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true }); phone.setDefaultTimeout(10000);
    await phone.goto(f.origin() + `/#projects/${projectId}/settings`); await phone.getByRole("tab", { name: "GitHub", exact: true }).click();
    const form = phone.getByTestId("project-github");
    await form.getByText("Correct conflicting triage labels.", { exact: true }).waitFor();
    assert.equal(await form.getByRole("textbox", { name: "Agent implementation label", exact: true }).inputValue(), "factory-ready");
    assert.equal(await form.getByRole("switch", { name: "Implement trusted ready issues automatically" }).getAttribute("aria-checked"), "true");
    assert.equal(await phone.getByRole("dialog", { name: "Project settings", exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    await phone.close();
  }
  assert.deepEqual(errors, []);
  console.log("GitHub readiness browser: mappings, opt-in, owner approval, repeat import, eligibility reasons and phone layout passed");
} catch (error) { console.error({ url: page?.url(), errors, text: (await page?.locator("body").innerText())?.slice(-7000) }); throw error; }
finally { await browser.close(); f.close(); }
