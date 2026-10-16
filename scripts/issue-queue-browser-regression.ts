/** Built app, owned HTTP/CLI fixtures, desktop and mobile. Build before running. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { githubQueueFixture } from "./fixtures/github-queue.ts";
import { githubReviewFixture } from "./fixtures/github-review.ts";
import { githubDeliveryResponses } from "./fixtures/github-delivery.ts";

const fixture = githubQueueFixture();
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
const errors: string[] = [];
const recordPageError = (error: Error) => { errors.push(error.message); };
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const issueSourced of [true, false]) {
      const direct = githubReviewFixture();
      const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
      page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
      try {
        const { project, route } = await direct.setup();
        const source = issueSourced ? (await direct.json(route + "/sync", {})).sources[0] : null;
        const assignment = source ? { id: source.implementation_id } : await direct.json("/implementations", { title: "Owned ordinary Work", description: "Fictional manual work", project_id: project.id });
        const path = `/implementations/${assignment.id}`;
        direct.setNativeIdentity();
        await page.goto(direct.origin + `/#factory/${assignment.id}`);
        const actions = page.getByRole("region", { name: "Next step", exact: true });
        const started = page.waitForResponse(response => response.url().endsWith(path + "/runs") && response.request().method() === "POST");
        await actions.getByRole("button", { name: "Start work", exact: true }).click();
        const response = await started; assert.equal(response.status(), 202);
        const run = await response.json();
        assert.equal(run.action, "work"); assert.equal(run.manifest.issue_admission, undefined);
        await page.goto(direct.origin + `/#factory/${assignment.id}`);
        await actions.getByRole("button", { name: "Mark work done", exact: true }).click();
        if (issueSourced) {
          await actions.getByText("Awaiting merge", { exact: true }).waitFor();
          assert.equal(await page.getByRole("button", { name: "Archive task", exact: true }).count(), 0);
          assert.equal((await direct.post(path + "/archive", {})).status, 409);
          direct.issue.state = "closed"; direct.save(); await direct.json(route + "/sync", {});
          await page.reload();
          await actions.getByText("Awaiting merge", { exact: true }).waitFor();
          assert.equal((await direct.post(path + "/archive", {})).status, 409);
          const current = (await direct.json(route)).sources[0];
          await direct.json(route + "/issues/1/delivery", { source_revision: current.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: "v1" });
          direct.setApiResponses(githubDeliveryResponses({ containsRelease: false }));
          await direct.json(route + "/sync", {}); await page.reload();
          await actions.getByText("Awaiting merge", { exact: true }).waitFor();
          assert.equal((await direct.post(path + "/archive", {})).status, 409);
          direct.setApiResponses(githubDeliveryResponses()); await direct.json(route + "/sync", {});
          await page.reload();
          assert.equal((await direct.json(path)).implementation.outcome, "released");
        }
        await page.getByRole("button", { name: "Archive task", exact: true }).click();
        await page.getByRole("button", { name: "Restore", exact: true }).waitFor();
        const detail = await direct.json(path);
        assert.equal(detail.implementation.stage, "done"); assert(detail.implementation.archived_at);
        assert.equal(detail.implementation.outcome, issueSourced ? "released" : "implementation_complete");
      } finally { await page.close(); direct.close(); }
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile ordinary Start work and Mark work done preserve issue delivery and manual archive boundaries");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const manual = githubReviewFixture();
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
    try {
      const { project } = await manual.setup();
      const assignment = await manual.json("/implementations", { title: "Owned manual Assignment", description: "Show a greeting", project_id: project.id });
      const path = `/implementations/${assignment.id}`;
      const specification = await manual.json(path + "/specifications", { content: "Show hello through the public HTTP interface." });
      for (const kind of ["specification", "testing_seams"]) await manual.json(path + "/approvals", { kind, revision: specification.id, scope: "Owned fixture approval for public HTTP" });
      const graph = await manual.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "greeting", title: "Greeting", acceptance: "Show hello", dependencies: [] }] });
      await manual.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Owned fixture graph approval" });
      const run = await manual.json(path + "/runs", { action: "implement-spec", idempotency_key: "owned-manual-implementation" });
      await manual.integrate(run); const check = await manual.json(`/runs/${run.id}/checks`, {});
      await manual.review(run, "standards"); await manual.review(run, "spec");
      assert.equal((await manual.json(`/runs/${run.id}/reconcile`, {})).condition, "completed");
      await page.goto(manual.origin + `/#factory/${assignment.id}`);
      const actions = page.getByRole("region", { name: "Next step", exact: true });
      assert.equal((await manual.json(path)).implementation.stage, "review");
      assert.equal((await manual.post(path + "/archive", {})).status, 409);
      await actions.getByRole("button", { name: "Accept reviewed head", exact: true }).click();
      await page.getByRole("button", { name: "Archive task", exact: true }).waitFor();
      assert.equal(await actions.getByRole("button", { name: "Accept reviewed head", exact: true }).count(), 0);
      // A previous acceptance at this same head does not accept a later Run.
      const followup = await manual.json(path + "/runs", { action: "implement-spec", idempotency_key: "owned-manual-followup" });
      await manual.integrate(followup); await manual.json(`/runs/${followup.id}/checks`, {});
      await manual.review(followup, "standards"); await manual.review(followup, "spec");
      await manual.json(`/runs/${followup.id}/reconcile`, {});
      await page.reload();
      await page.getByText("Advanced controls", { exact: true }).last().click();
      const execution = page.getByRole("heading", { name: "Execution evidence", exact: true }).locator("..");
      const cleanup = page.waitForResponse(response => response.url().endsWith(`/runs/${followup.id}/cleanup`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "Remove clean checkout", exact: true }).last().click();
      assert.equal((await cleanup).status(), 409);
      await page.getByRole("alert").filter({ hasText: "Choose Accept reviewed head before removing this implementation checkout" }).waitFor();
      assert(await execution.getByRole("button", { name: "Accept reviewed head", exact: true }).isEnabled());
      await (viewport.width < 640 ? execution : actions).getByRole("button", { name: "Accept reviewed head", exact: true }).click();
      const acceptedCleanup = page.waitForResponse(response => response.url().endsWith(`/runs/${followup.id}/cleanup`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "Remove clean checkout", exact: true }).last().click();
      assert.equal((await acceptedCleanup).status(), 200);
      await page.getByRole("button", { name: "Archive task", exact: true }).click();
      await page.getByRole("button", { name: "Restore", exact: true }).waitFor();
      const detail = await manual.json(path);
      assert.equal(detail.implementation.stage, "done");
      assert(detail.implementation.archived_at);
      assert.equal(detail.approvals.filter((approval: any) => approval.kind === "review" && approval.revision === check.head).length, 2);
      assert.equal(await actions.getByRole("button", { name: "Accept reviewed head", exact: true }).count(), 0);
      assert.equal(await execution.getByRole("button", { name: "Accept reviewed head", exact: true }).count(), 0);
    } finally { await page.close(); manual.close(); }
  }
  console.log("PASS: desktop/mobile retired manual implementation acceptance and archive");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const control of ["Start implementation", "Start factory"]) {
      const guarded = githubReviewFixture();
      const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
      page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
      try {
        const { route, readiness } = await guarded.setup();
        const source = (await guarded.json(route + "/sync", {})).sources[0];
        const path = `/implementations/${source.implementation_id}`;
        await guarded.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
        await guarded.json(route + "/issues/1/prepare", { source_revision: source.revision });
        const prepared = (await guarded.json(route + "/sync", {})).sources[0];
        for (const kind of ["specification", "testing_seams"]) await guarded.json(path + "/approvals", { kind, revision: prepared.planning.specification_id, scope: "Public HTTP and real browser journeys." });
        await guarded.json(path + "/approvals", { kind: "ticket_graph", revision: prepared.planning.graph_hash, scope: "Approved bounded greeting" });
        await guarded.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
        guarded.setNativeIdentity();
        async function openControl() {
          const url = guarded.origin + `/#factory/${source.implementation_id}`;
          if (page.url() === url) await page.reload(); else await page.goto(url);
          if (control === "Start factory") await page.getByText("Advanced controls", { exact: true }).last().click();
        }
        await openControl();
        const rejected = page.waitForResponse(response => response.url().endsWith(path + "/runs") && response.request().method() === "POST");
        await page.getByRole("button", { name: control, exact: true }).click();
        const response = await rejected;
        assert.equal(response.status(), 409);
        assert.equal((await response.json()).error.code, "queue_paused");
        assert.deepEqual(response.request().postDataJSON().issue_scope, { source_id: source.id, source_revision: prepared.revision, graph_hash: prepared.planning.graph_hash });
        assert.equal((await guarded.json(path)).runs.length, 0);
        // Outage cannot turn a prepared issue back into manual admission.
        guarded.save([guarded.issue], true); assert.equal((await guarded.post(route + "/sync", {})).status, 409);
        await openControl();
        assert(await page.getByRole("button", { name: control, exact: true }).isDisabled());
        guarded.save(); await guarded.json(route + "/sync", {});
        const queue = await guarded.json(route + "/queue");
        await guarded.json(route + "/queue", { expected_revision: queue.policy.revision, automatic_implementation: false, paused: false, max_implementations: 1 });
        await openControl();
        const started = page.waitForResponse(response => response.url().endsWith(path + "/runs") && response.request().method() === "POST");
        await page.getByRole("button", { name: control, exact: true }).click();
        const admitted = await started; assert.equal(admitted.status(), 202);
        const run = await admitted.json();
        assert.equal(run.manifest.issue_admission.source.id, source.id);
        assert.equal(run.manifest.issue_admission.source.revision, prepared.revision);
        assert.equal((await guarded.json(path)).runs.length, 1);
      } finally { await page.close(); guarded.close(); }
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile existing implementation controls use guarded issue admission, pause and outage rules");
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
  const evidence = process.env["UI_EVIDENCE_DIR"]; if (evidence) mkdirSync(evidence, { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const queue = await fixture.json(route + "/queue");
    await fixture.json(route + "/queue", { expected_revision: queue.policy.revision, automatic_implementation: false, paused: false, max_implementations: 1 });
    await fixture.json(`/implementations/${view.sources[0].implementation_id}/order`, { before_id: view.sources[1].implementation_id });
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
    const queueResponses: unknown[] = [];
    page.on("response", async response => {
      if (!response.url().endsWith(route + "/queue")) return;
      try { queueResponses.push({ status: response.status(), body: await response.json() }); if (queueResponses.length > 10) queueResponses.shift(); } catch { /* A reload can cancel an in-flight read. */ }
    });
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
      const preview = page.waitForResponse(response => response.url().endsWith(route + "/preview") && response.request().method() === "POST");
      await region.getByRole("button", { name: "Preview eligible backlog", exact: true }).click();
      assert.equal((await preview).status(), 200);
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
      const refreshedPreview = page.waitForResponse(response => response.url().endsWith(route + "/preview") && response.request().method() === "POST");
      await region.getByRole("button", { name: "Preview eligible backlog", exact: true }).click();
      assert.equal((await refreshedPreview).status(), 200);
      await region.getByText("Eligible issues: 2", { exact: true }).waitFor();
      if (evidence) { await region.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, `issue-queue-${viewport.width}.png`), fullPage: true }); }
      assert(await region.evaluate(element => element.scrollWidth <= element.clientWidth));
      fixture.save(issues, true);
      const outage = await fixture.post(route + "/sync", {});
      assert.equal(outage.status, 409);
      assert.equal((await outage.json()).error.code, "github_invalid_response");
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
    } catch (error) {
      if (evidence) {
        try {
          writeFileSync(join(evidence, `issue-queue-failure-${viewport.width}.json`), JSON.stringify({ url: page.url(), dom: await page.locator("body").innerText(), queue: await fixture.json(route + "/queue"), queueResponses, errors }, null, 2));
          await page.screenshot({ path: join(evidence, `issue-queue-failure-${viewport.width}.png`), fullPage: true });
        } catch (captureError) { console.error("Could not retain browser diagnostics", captureError); }
      }
      throw error;
    } finally { await page.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile backlog count/reasons, stale preview, priority, pause, limits, Needs you and outage; no starts");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const admitted = githubQueueFixture(true);
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
    try {
      const { project, route, readiness } = await admitted.setup();
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
      await page.goto(admitted.origin + `/#projects/${project.id}`);
      const needsYou = page.getByRole("region", { name: "Needs you", exact: true });
      await needsYou.getByRole("button", { name: source.current.title, exact: true }).waitFor();
      await page.reload();
      await needsYou.getByRole("button", { name: source.current.title, exact: true }).waitFor();
      await needsYou.getByRole("button", { name: source.current.title, exact: true }).click();
      await contract.getByText("Controlled pause requested. Issue scope changed.", { exact: true }).waitFor();
    } finally { await page.close(); admitted.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile explicit trusted Start, admitted contract, outage continuation and controlled pause");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const reviewed = githubReviewFixture();
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
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
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const automatic = githubQueueFixture(true);
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
    try {
      const { project, account, route } = await automatic.setup();
      const later = { ...automatic.issue, number: 2, node_id: "fictional-auto-2", title: "Queued automatic greeting" };
      const blocked = { ...automatic.issue, number: 3, node_id: "fictional-auto-3", title: "Blocked automatic greeting", labels: [{ name: "blocked" }, { name: "ready-for-agent" }] };
      automatic.save([automatic.issue, later, blocked], false, {}, true);
      await page.goto(automatic.origin + `/#projects/${project.id}/settings`);
      await page.getByRole("tab", { name: "GitHub", exact: true }).click();
      await page.getByLabel("Automatic sync", { exact: true }).check();
      const saved = page.waitForResponse(response => response.url().endsWith(route + "/configure") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Save Project settings", exact: true }).click(); await saved;
      const readiness = page.getByRole("region", { name: "Issue readiness", exact: true });
      await readiness.getByRole("combobox", { name: "Readiness account", exact: true }).selectOption(account.id);
      const selected = page.waitForResponse(response => response.url().endsWith(route + "/readiness") && response.request().method() === "POST");
      await readiness.getByRole("button", { name: "Save readiness settings", exact: true }).click(); await selected;
      await readiness.getByText("Readiness identity: fictional-owner", { exact: true }).waitFor();
      const queue = page.getByRole("region", { name: "Issue queue", exact: true });
      const enable = queue.getByRole("button", { name: "Enable automatic implementation", exact: true });
      assert(await enable.isDisabled());
      await queue.getByLabel("Pause queue", { exact: true }).check();
      await queue.getByRole("button", { name: "Save queue settings", exact: true }).click();
      await queue.getByText("Queue paused. Admitted work continues.", { exact: true }).waitFor();
      // First observation cannot attest historical native dependencies. The
      // fictional owner renews the labels after that observed scope.
      await automatic.renewLabels(route);
      await queue.getByRole("button", { name: "Preview eligible backlog", exact: true }).click();
      await queue.getByText("Eligible issues: 2", { exact: true }).waitFor();
      await enable.click();
      await queue.getByText("Automatic implementation is on.", { exact: true }).waitFor();
      assert.deepEqual(automatic.launches, []);
      assert.deepEqual((await automatic.json(route + "/queue")).entries.filter((entry: any) => entry.eligible).map((entry: any) => [entry.number, entry.lane]), [[1, "queued"], [2, "queued"]]);
      // Lane and eligibility share one rendered status paragraph.
      await queue.getByText("Queued · Eligible", { exact: true }).first().waitFor();
      await queue.getByText("Resolve the issue's blocked signal before implementation.", { exact: true }).waitFor();
      const first = queue.getByRole("article").filter({ has: page.getByRole("link", { name: "#1 · Fictional scope", exact: true }) });
      const moved = page.waitForResponse(response => response.url().endsWith("/order") && response.request().method() === "POST");
      await first.getByRole("button", { name: "Move later", exact: true }).click();
      assert.equal((await moved).status(), 200);
      assert.equal((await automatic.json(route + "/queue")).entries[0].number, 2);
      await queue.getByRole("article").first().getByRole("link", { name: `#2 · ${later.title}`, exact: true }).waitFor();
      assert((await queue.getByRole("article").first().textContent())?.includes(later.title));
      automatic.setLaunchOutcome("failed");
      await queue.getByLabel("Pause queue", { exact: true }).uncheck();
      await queue.getByRole("button", { name: "Save queue settings", exact: true }).click();
      await queue.getByText("Automatic implementation is on.", { exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Issue queue"] form button:disabled'));
      const sources = (await automatic.json(route)).sources;
      const failedSource = sources.find((source: any) => source.number === 2);
      const failedPath = `/implementations/${failedSource.implementation_id}`;
      const failed = (await automatic.json(failedPath)).runs[0];
      assert.equal(failed.condition, "failed");
      await automatic.json(route + "/sync", {});
      assert.equal((await automatic.json(failedPath)).runs.length, 1);
      await page.goto(automatic.origin + `/#factory/${failedSource.implementation_id}`);
      await page.getByText("Attempt failed. Use Retry to start again.", { exact: true }).waitFor();
      automatic.setLaunchOutcome("working");
      // Another failed backlog attempt releases capacity; Retry still needs the owner's explicit action.
      await page.getByRole("region", { name: "Issue planning", exact: true }).getByRole("button", { name: "Retry", exact: true }).click();
      const contract = page.getByRole("region", { name: "Admitted issue contract", exact: true }).last();
      await contract.getByText("Execution confirmed.", { exact: true }).waitFor();
      const run = (await automatic.json(failedPath)).runs.at(-1);
      assert.equal(run.retry_of, failed.id);
      automatic.save([automatic.issue, later, blocked], true, {}, true);
      assert.equal((await automatic.post(route + "/sync", {})).status, 409);
      await page.reload();
      await contract.getByText("Execution confirmed.", { exact: true }).waitFor();
      later.body += "\nChanged automatic scope.";
      automatic.save([automatic.issue, later, blocked], false, {}, true); await automatic.json(route + "/sync", {});
      await page.reload();
      await contract.getByText("Controlled pause requested. Issue scope changed.", { exact: true }).waitFor();
      assert.deepEqual((await automatic.json(failedPath)).runs.at(-1).manifest, run.manifest);
      assert(await contract.evaluate(element => element.scrollWidth <= element.clientWidth));
    } finally { await page.close(); automatic.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile identity selection, reviewed automatic opt-in, queued/blocked priority, pause, failed-attempt Retry, outage continuation and controlled pause");
} finally { await browser.close(); fixture.close(); }
