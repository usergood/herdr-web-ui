/** Built app, owned HTTP/CLI fixtures, desktop and mobile. Build before running. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { githubQueueFixture } from "./fixtures/github-queue.ts";
import { githubReviewFixture } from "./fixtures/github-review.ts";

const fixture = githubQueueFixture();
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const { project, route, readiness } = await fixture.setup();
  const second = { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later greeting", html_url: "https://github.com/fictional/project/issues/2" };
  const blocked = { ...fixture.issue, number: 3, node_id: "fictional-3", title: "Blocked greeting", labels: [{ name: "blocked" }, { name: "ready-for-agent" }] };
  const undecided = { ...fixture.issue, number: 4, node_id: "fictional-4", title: "Missing seams", body: "## Scope\nShow hello.\n## Acceptance criteria\nHello.\n## Dependencies\nNone." };
  const issues = [fixture.issue, second, blocked, undecided]; fixture.save(issues);
  const view = await fixture.json(route + "/sync", {});
  for (const number of [1, 2, 4]) {
    const source = view.sources.find((source: any) => source.number === number);
    await fixture.json(route + `/issues/${number}/approve`, { source_revision: source.revision, policy_revision: readiness.revision });
    await fixture.json(route + `/issues/${number}/prepare`, { source_revision: source.revision });
  }
  await fixture.json(route + "/sync", {});
  const errors: string[] = [];
  const evidence = process.env["UI_EVIDENCE_DIR"]; if (evidence) mkdirSync(evidence, { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const queue = await fixture.json(route + "/queue");
    await fixture.json(route + "/queue", { expected_revision: queue.policy.revision, automatic_implementation: false, paused: false, max_implementations: 1 });
    await fixture.json(`/implementations/${view.sources[0].implementation_id}/order`, { before_id: view.sources[1].implementation_id });
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", error => errors.push(error.message));
    async function reopenGitHubSettings() {
      // Reload closes Settings; its history entry may keep the old address.
      await page.getByRole("heading", { name: project.name, exact: true }).waitFor();
      const drawer = page.getByRole("button", { name: "Open workspace list", exact: true });
      if (await drawer.isVisible()) await drawer.click();
      await page.getByRole("button", { name: `Project settings for ${project.name}`, exact: true }).click();
      await page.getByRole("tab", { name: "GitHub", exact: true }).click();
    }
    try {
      await page.goto(fixture.origin + `/#projects/${project.id}/settings`);
      await page.getByRole("tab", { name: "GitHub", exact: true }).click();
      const region = page.getByRole("region", { name: "Issue queue", exact: true });
      await region.getByText("Automatic implementation is off.", { exact: true }).waitFor();
      await region.getByRole("button", { name: "Preview eligible backlog", exact: true }).click();
      await region.getByText("Eligible issues: 2", { exact: true }).waitFor();
      await region.getByText("Preview is current.", { exact: true }).waitFor();
      const first = region.getByRole("article").filter({ has: page.getByRole("link", { name: "#1 · Fictional scope", exact: true }) });
      const excluded = region.getByRole("article").filter({ has: page.getByRole("link", { name: "#3 · Blocked greeting", exact: true }) });
      await excluded.getByText("Resolve the issue's blocked signal before implementation.", { exact: true }).waitFor();
      await region.getByText("Needs you", { exact: false }).waitFor();
      await first.getByRole("button", { name: "Move later", exact: true }).click();
      await region.getByText("Preview changed. Review the backlog again.", { exact: true }).waitFor();
      assert((await region.getByRole("article").first().textContent())?.includes("Later greeting"));
      await region.getByLabel("Pause queue", { exact: true }).check();
      await region.getByLabel("Implementing Assignment limit", { exact: true }).fill("2");
      await region.getByRole("button", { name: "Save queue settings", exact: true }).click();
      await region.getByText("Queue paused. Admitted work continues.", { exact: true }).waitFor();
      await page.reload();
      await reopenGitHubSettings();
      assert(await region.getByLabel("Pause queue", { exact: true }).isChecked());
      assert.equal(await region.getByLabel("Implementing Assignment limit", { exact: true }).inputValue(), "2");
      await region.getByRole("button", { name: "Preview eligible backlog", exact: true }).click();
      await region.getByText("Eligible issues: 2", { exact: true }).waitFor();
      if (evidence) { await region.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, `issue-queue-${viewport.width}.png`), fullPage: true }); }
      assert(await region.evaluate(element => element.scrollWidth <= element.clientWidth));
      fixture.save(issues, true); assert.equal((await fixture.post(route + "/sync", {})).status, 409);
      await page.reload();
      await reopenGitHubSettings();
      await region.getByText("Eligible issues: 0", { exact: true }).waitFor();
      await region.getByText("Preview changed. Review the backlog again.", { exact: true }).waitFor();
      await region.getByText("Dependency evidence is stale or incomplete. Sync GitHub before starting work.", { exact: true }).first().waitFor();
      fixture.save(issues); await fixture.json(route + "/sync", {});
      await page.goto(fixture.origin + `/#projects/${project.id}`);
      const needsYou = page.getByRole("region", { name: "Needs you", exact: true });
      await needsYou.getByRole("button", { name: "Missing seams", exact: true }).waitFor();
      for (const source of view.sources) assert.deepEqual((await fixture.json(`/implementations/${source.implementation_id}`)).runs, []);
    } finally { await page.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile backlog count/reasons, stale preview, priority, pause, limits, Needs you and outage; no starts");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const admitted = githubQueueFixture(true);
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", error => errors.push(error.message));
    try {
      const { route, readiness } = await admitted.setup();
      const source = (await admitted.json(route + "/sync", {})).sources[0];
      await admitted.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
      await admitted.json(route + "/issues/1/prepare", { source_revision: source.revision });
      await admitted.json(route + "/sync", {});
      const path = `/implementations/${source.implementation_id}`;
      await page.goto(admitted.origin + `/#factory/${source.implementation_id}`);
      const planning = page.getByRole("region", { name: "Issue planning", exact: true });
      await planning.getByRole("button", { name: "Start prepared issue", exact: true }).click();
      const contract = page.getByRole("region", { name: "Admitted issue contract", exact: true });
      await contract.getByText("The admitted scope stays fixed. Required checks and independent reviews still apply.", { exact: true }).waitFor();
      await contract.getByText(source.revision, { exact: true }).waitFor();
      await contract.getByText("Approved by fictional-owner", { exact: true }).waitFor();
      const run = (await admitted.json(path)).runs[0];
      assert.equal(run.condition, "working");
      await contract.getByText("Reused planning", { exact: true }).click();
      await contract.getByText(run.graph_hash, { exact: true }).waitFor();
      await contract.getByText("Public HTTP and real browser journeys.", { exact: true }).first().waitFor();
      assert.equal((await admitted.json(path)).approvals.length, 0);
      admitted.save([admitted.issue], true);
      assert.equal((await admitted.post(route + "/sync", {})).status, 409);
      await page.reload();
      await contract.getByText(source.revision, { exact: true }).waitFor();
      assert.equal((await admitted.json(path)).runs[0].condition, "working");
      admitted.issue.body += "\nNew scope requiring owner review.";
      admitted.issue.updated_at = "2026-10-03T12:00:00Z";
      admitted.save(); await admitted.json(route + "/sync", {});
      await page.reload();
      await contract.getByText("Controlled pause requested. Issue scope changed.", { exact: true }).waitFor();
      await contract.getByText("Produced work is retained. Reconcile active or unreachable workers before another attempt.", { exact: true }).waitFor();
      assert.equal((await admitted.json(path)).runs[0].condition, "needs_you");
      assert.deepEqual((await admitted.json(path)).runs[0].manifest, run.manifest);
      assert(await contract.evaluate(element => element.scrollWidth <= element.clientWidth));
      if (evidence) await page.screenshot({ path: join(evidence, `issue-admission-${viewport.width}.png`), fullPage: true });
    } finally { await page.close(); admitted.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile explicit trusted Start, admitted contract, outage continuation and controlled pause");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const reviewed = githubReviewFixture();
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", error => errors.push(error.message));
    try {
      reviewed.save([reviewed.issue, { ...reviewed.issue, number: 2, node_id: "fictional-2", title: "Unrelated reviewed backlog" }]);
      const { run, path, project, route, readiness } = await reviewed.prepare();
      const second = await reviewed.second(route, readiness);
      await reviewed.integrate(run); await reviewed.json(`/runs/${run.id}/checks`, {});
      await reviewed.review(run, "standards"); await reviewed.review(run, "spec");
      await reviewed.json(`/runs/${run.id}/reconcile`, {});
      await page.goto(reviewed.origin + `/#factory/${run.implementation_id}`);
      const actions = page.getByRole("region", { name: "Next step", exact: true });
      await actions.getByText("Awaiting merge", { exact: true }).waitFor();
      await actions.getByText("Owner acceptance is still required.", { exact: true }).waitFor();
      assert.equal((await reviewed.json(path)).implementation.stage, "review");
      assert.deepEqual((await reviewed.json(path)).approvals, []);
      await actions.getByRole("button", { name: "Accept reviewed head", exact: true }).click();
      await actions.getByText("Reviewed head accepted. Delivery is still pending.", { exact: true }).waitFor();
      assert.equal((await reviewed.json(path)).implementation.stage, "review");
      await page.goto(reviewed.origin + `/#projects/${project.id}`);
      await page.getByRole("heading", { name: project.name, exact: true }).waitFor();
      const drawer = page.getByRole("button", { name: "Open workspace list", exact: true });
      if (await drawer.isVisible()) await drawer.click();
      await page.getByRole("button", { name: `Project settings for ${project.name}`, exact: true }).click();
      await page.getByRole("tab", { name: "GitHub", exact: true }).click();
      const queue = page.getByRole("region", { name: "Issue queue", exact: true });
      await queue.getByText("Project implementation slots available: 1", { exact: true }).waitFor();
      await queue.getByText("Implementing Assignments: 0", { exact: true }).waitFor();
      assert(await queue.evaluate(element => element.scrollWidth <= element.clientWidth));
      if (evidence) await page.screenshot({ path: join(evidence, `issue-completion-${viewport.width}.png`), fullPage: true });
      await page.goto(reviewed.origin + `/#factory/${second.path.split("/").at(-1)}`);
      await page.getByRole("button", { name: "Start prepared issue", exact: true }).click();
      await page.getByRole("region", { name: "Admitted issue contract", exact: true }).waitFor();
      assert.equal((await reviewed.json(second.path)).runs.length, 1);
      assert.equal((await reviewed.json(path)).implementation.stage, "review");
    } finally { await page.close(); reviewed.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile awaiting merge, separate owner acceptance, available Project capacity and unrelated admission without false delivery");
} finally { await browser.close(); fixture.close(); }
