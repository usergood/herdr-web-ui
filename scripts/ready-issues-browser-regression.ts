/** Confirmed browser seam backed by owned GitHub and Machine responses. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright-core";
import { readyIssuesFixture } from "../server/ready-issues.fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
let page: Page | undefined;
const errors: string[] = [];
try {
  for (const width of [1440, 390]) {
    const f = await readyIssuesFixture();
    try {
      await f.request(f.route + "/configure", f.policy);
      await f.request(`/projects/${f.project.id}/configure`, { checks: [] });
      f.respond({ issues: [f.issue(1)] });
      const source = (await f.request(f.route + "/sync", {})).body.sources[0];
      page = await browser.newPage({ viewport: { width, height: 900 }, ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
      page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message));
      await page.goto(f.origin() + `/#projects/${f.project.id}/settings`);
      await page.getByRole("tab", { name: "GitHub", exact: true }).click();
      const issue = page.getByRole("region", { name: "Issue #1", exact: true });
      await issue.getByRole("textbox", { name: "Acceptance criteria", exact: true }).fill(f.plan.acceptance_criteria);
      await issue.getByRole("textbox", { name: "Confirmed testing seams", exact: true }).fill(f.plan.testing_seams.join("\n"));
      await issue.getByRole("textbox", { name: "Planning decisions", exact: true }).fill(f.plan.planning_decisions.join("\n"));
      await issue.getByRole("button", { name: "Approve this issue revision", exact: true }).click();
      await issue.getByText("Approved by owner", { exact: true }).waitFor();
      await f.tick();
      if (width < 640) await page.getByRole("button", { name: "Back to settings", exact: true }).click();
      await page.getByRole("tab", { name: "Queue", exact: true }).click();
      const queue = page.getByRole("region", { name: "Project queue", exact: true });
      await queue.getByRole("alert").filter({ hasText: "Configure known Project checks" }).waitFor();
      assert.equal(f.launches.length, 0);
      const pause = queue.getByRole("switch", { name: "Pause queue", exact: true });
      await pause.click();
      await queue.getByText("Queue paused", { exact: true }).waitFor();
      await f.request(`/projects/${f.project.id}/configure`, { checks: [["git", "status", "--porcelain"]] });
      await f.tick(); assert.equal(f.launches.length, 0);
      await pause.click();
      await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Pause queue"]')?.getAttribute("aria-checked") === "false");
      await f.tick(); await page.reload();
      if (width < 640 && await page.getByRole("tab", { name: "Queue", exact: true }).count()) await page.getByRole("tab", { name: "Queue", exact: true }).click();
      await page.getByText("Accepted work retains ownership", { exact: false }).waitFor();
      let detail = (await f.request(`/implementations/${source.implementation_id}`)).body;
      assert.deepEqual(detail.runs.map((run: any) => run.action), ["implement-spec"]);
      assert.equal(detail.questions.length, 0);
      assert.equal(detail.runs[0].manifest.issue_scope.approval.plan.acceptance_criteria, f.plan.acceptance_criteria);
      f.restart(); await f.tick(); await page.reload();
      detail = (await f.request(`/implementations/${source.implementation_id}`)).body;
      assert.equal(detail.runs.length, 1); assert.equal(f.launches.length, 1);
      await page.close(); page = undefined;
    } finally { f.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("Ready issues browser: approved scope, actionable hold, pause/resume, automatic factory launch and restart without repeated planning passed on desktop and phone");
} catch (error) { console.error({ url: page?.url(), errors, text: (await page?.locator("body").innerText())?.slice(-6000) }); throw error; }
finally { await browser.close(); }
