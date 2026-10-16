/** Confirmed browser seam with owned server state and fictional issue evidence. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { githubScheduleFixture } from "../server/github-schedules.fixture.ts";

let failLaunch = false, versionReads = 0;
const f = await githubScheduleFixture({ native: { version: async provider => failLaunch && provider === "codex" && ++versionReads === 2 ? "changed-after-admission" : "queue-browser-fixture" } });
const projectId = f.route.split("/")[2]!;
assert.equal((await f.request(`/projects/${projectId}/queue/configure`, { expected_revision: null, max_implementations: 1, paused: false })).status, 200);
const policy = (await f.request(f.route + "/configure", { ...f.policy, auto_implement: true })).body;
writeFileSync(f.responses, JSON.stringify({ issues: [1, 2].map(number => ({ number, node_id: `I_QUEUE_${number}`, title: `Queue browser issue ${number}`, body: "Reviewed fictional work", state: "open", html_url: `https://github.com/fictional/schedules/issues/${number}`, updated_at: "2026-10-14T09:00:00Z", labels: [{ name: "ready-for-agent" }] })) }));
const sources = (await f.request(f.route + "/sync", {})).body.sources;
for (const source of sources) await f.request(f.route + `/issues/${source.number}/approve`, { issue_revision: source.revision, policy_revision: policy.revision, plan: { acceptance_criteria: "Owned work follows the Project queue", testing_seams: ["Public API and browser"], planning_decisions: [], dependencies: source.number === 1 ? [{ repository: "fictional/schedules", issue_number: 90, requires: "merge" }] : [] } });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
const errors: string[] = [];
let activePage: Page | undefined;
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
    activePage = page;
    page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(f.origin() + `/#projects/${projectId}/settings`);
    await page.getByRole("tab", { name: "Queue", exact: true }).click();
    const queue = page.getByRole("region", { name: "Project queue", exact: true });
    await queue.getByText("Waiting for verified dependencies", { exact: true }).waitFor();
    assert.equal(await queue.getByRole("spinbutton", { name: "Concurrent Assignments", exact: true }).inputValue(), "1");
    const pause = queue.getByRole("switch", { name: "Pause queue", exact: true });
    await pause.focus(); await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Pause queue"]')?.getAttribute("aria-checked") === "true");
    await queue.getByText("Queue paused", { exact: true }).first().waitFor();
    await queue.getByRole("spinbutton", { name: "Concurrent Assignments", exact: true }).fill("2");
    const saved = page.waitForResponse(response => response.url().endsWith("/queue/configure") && response.request().method() === "POST");
    await queue.getByRole("button", { name: "Save queue settings", exact: true }).click(); assert.equal((await saved).status(), 200);
    await page.reload();
    if (await page.getByRole("dialog", { name: "Project settings", exact: true }).count() === 0) await page.getByRole("button", { name: "Project settings for Schedule fixture", exact: true }).click();
    await page.getByRole("tab", { name: "Queue", exact: true }).click();
    await queue.getByRole("spinbutton", { name: "Concurrent Assignments", exact: true }).waitFor();
    assert.equal(await queue.getByRole("spinbutton", { name: "Concurrent Assignments", exact: true }).inputValue(), "2");
    assert.equal(await pause.getAttribute("aria-checked"), "true");
    await pause.click(); await queue.getByText("Eligible", { exact: true }).waitFor();
    assert.equal(await queue.getByRole("button", { name: "Move earlier", exact: true }).count(), 0);
    assert.equal(await queue.getByRole("button", { name: "Move later", exact: true }).count(), 0);
    await queue.getByText("Queued work starts automatically when capacity is available.", { exact: true }).waitFor();
    await queue.getByText(/^Agent contexts: /).waitFor();
    await queue.getByText(/^Builds: /).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Project settings", exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    if (width < 640) for (const button of await queue.getByRole("button").all()) { const box = await button.boundingBox(); assert.ok(box && box.width >= 40 && box.height >= 40, JSON.stringify({ width, label: await button.getAttribute("aria-label") ?? await button.innerText(), box })); }
    await f.request(`/projects/${projectId}/queue/configure`, { expected_revision: (await f.request(`/projects/${projectId}/queue`)).body.revision, max_implementations: 1, paused: false });
    await page.close();
    activePage = undefined;
  }
  const idea = (await f.request("/implementations", { title: "Retry browser work", description: "", project_id: projectId })).body;
  failLaunch = true; versionReads = 0;
  const failed = (await f.request(`/implementations/${idea.id}/runs`, { action: "work", idempotency_key: "owned-failure" })).body;
  assert.equal(failed.condition, "failed"); failLaunch = false;
  const retryPage = await browser.newPage({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true }); activePage = retryPage;
  retryPage.setDefaultTimeout(10000); retryPage.on("pageerror", error => errors.push(error.message));
  await retryPage.goto(f.origin() + `/#projects/${projectId}/settings`);
  await retryPage.getByRole("tab", { name: "Queue", exact: true }).click();
  const retry = retryPage.getByRole("region", { name: "Project queue", exact: true }).getByRole("button", { name: "Retry", exact: true });
  await retry.waitFor();
  const retried = retryPage.waitForResponse(response => response.url().endsWith(`/implementations/${idea.id}/retry`));
  await retry.tap(); assert.equal((await retried).status(), 200); await retry.waitFor({ state: "hidden" });
  await retryPage.reload();
  if (await retryPage.getByRole("dialog", { name: "Project settings", exact: true }).count() === 0) await retryPage.getByRole("button", { name: "Project settings for Schedule fixture", exact: true }).click();
  await retryPage.getByRole("tab", { name: "Queue", exact: true }).click();
  await retryPage.getByRole("link", { name: "Retry browser work", exact: true }).waitFor();
  assert.equal(await retry.count(), 0);
  assert.equal((await f.request(`/implementations/${idea.id}`)).body.runs.length, 1);
  await retryPage.close(); activePage = undefined;
  assert.deepEqual(errors, []);
  console.log("Project queue browser: desktop, narrow phones, automatic ordering, blockers, pause, saved local policy, separate capacity, explicit Retry and reload passed");
} catch (error) {
  console.error({ url: activePage?.url(), errors, text: (await activePage?.locator("body").innerText())?.slice(0, 8000) }); throw error;
} finally { await browser.close(); f.close(); }
