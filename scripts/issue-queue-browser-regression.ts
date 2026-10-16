import { issueContinuationFixture } from "./fixtures/issue-continuation.ts";
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
      const retired = await manual.json(`/runs/${followup.id}/reconcile`, {});
      const redundantStop = await manual.json(`/runs/${followup.id}/stop`, {});
      assert.equal(redundantStop.condition, "completed");
      assert.deepEqual(redundantStop.implementation_completion, retired.implementation_completion);
      await manual.json(`/runs/${followup.id}/reconcile`, {});
      await page.reload();
      await page.getByText("Advanced controls", { exact: true }).last().click();
      const execution = page.getByRole("heading", { name: "Execution evidence", exact: true }).locator("..");
      const [cleanup] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith(`/runs/${followup.id}/cleanup`) && response.request().method() === "POST"),
        page.getByRole("button", { name: "Remove clean checkout", exact: true }).last().click(),
      ]);
      assert.equal(cleanup.status(), 409);
      await page.getByRole("alert").filter({ hasText: "Choose Accept reviewed head before removing this implementation checkout" }).waitFor();
      const acceptReviewedHead = execution.getByRole("button", { name: "Accept reviewed head", exact: true });
      // The alert can render before perform's refresh clears the busy state.
      await acceptReviewedHead.and(page.locator(":enabled")).waitFor();
      assert(await acceptReviewedHead.isEnabled());
      await (viewport.width < 640 ? execution : actions).getByRole("button", { name: "Accept reviewed head", exact: true }).click();
      const [acceptedCleanup] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith(`/runs/${followup.id}/cleanup`) && response.request().method() === "POST"),
        page.getByRole("button", { name: "Remove clean checkout", exact: true }).last().click(),
      ]);
      assert.equal(acceptedCleanup.status(), 200);
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
    const stale = githubReviewFixture();
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
    try {
      const { run, route, path } = await stale.prepare();
      await stale.integrate(run); await stale.json(`/runs/${run.id}/checks`, {});
      await stale.review(run, "standards"); await stale.review(run, "spec");
      const retired = await stale.json(`/runs/${run.id}/reconcile`, {});
      const snapshot = await stale.json(path + "/snapshots", { run_id: run.id, mode: "branch" });
      await stale.json(path + "/comments", { snapshot_id: snapshot.id, path: "README.md", side: "new", line_start: 1, line_end: 1, content: "Correct the produced greeting" });
      assert.equal((await stale.json(`/runs/${run.id}/reconcile`, {})).condition, "needs_you");
      stale.restart();
      await page.goto(stale.origin + `/#factory/${run.implementation_id}`);
      await page.getByText("Advanced controls", { exact: true }).last().click();
      const history = page.getByRole("heading", { name: "Run history", exact: true }).locator("..");
      const reconciled = page.waitForResponse(response => response.url().endsWith(`/runs/${run.id}/reconcile`) && response.request().method() === "POST");
      await history.getByRole("button", { name: "Reconcile Run", exact: true }).click();
      assert.equal((await (await reconciled).json()).condition, "needs_you");
      await history.getByRole("status").filter({ hasText: "Implementation evidence changed or is unavailable" }).waitFor();
      assert(await history.getByRole("button", { name: "Remove clean checkout", exact: true }).isDisabled());
      assert.equal((await stale.json(route + "/queue")).implementing_count, 1);
      const stopped = page.waitForResponse(response => response.url().endsWith(`/runs/${run.id}/stop`) && response.request().method() === "POST");
      await history.getByRole("button", { name: "Stop Run", exact: true }).click();
      assert.equal((await (await stopped).json()).condition, "cancelled");
      const retry = page.waitForResponse(response => response.url().endsWith(`/runs/${run.id}/retry`) && response.request().method() === "POST");
      await page.getByRole("region", { name: "GitHub issue source", exact: true }).getByRole("button", { name: "Retry", exact: true }).click();
      const retried = await (await retry).json();
      assert.equal(retried.condition, "working"); assert.equal(retried.retry_of, run.id);
      assert.deepEqual(retried.manifest.rework, { run_id: run.id, head: retired.implementation_completion.head, workspace_hash: retired.implementation_completion.workspace_hash });
      const detail = await stale.json(path);
      assert.deepEqual(detail.runs.map((run: any) => [run.action, run.condition]), [["implement-spec", "cancelled"], ["implement-spec", "working"]]);
      assert.deepEqual(detail.approvals, []); assert.equal(detail.comments[0].status, "draft");
      stale.setHead("b".repeat(40));
      await stale.integrate(retried); const checked = await stale.json(`/runs/${retried.id}/checks`, {});
      await stale.review(retried, "standards"); await stale.review(retried, "spec");
      assert.equal((await stale.json(`/runs/${retried.id}/reconcile`, {})).condition, "ready");
      await page.reload();
      const review = page.locator("details").filter({ has: page.locator(":scope > summary").filter({ hasText: /^Review changes$/ }) });
      await review.locator(":scope > summary").click();
      const resolve = review.getByRole("button", { name: "Resolve with fresh evidence", exact: true });
      await resolve.waitFor();
      const resolved = page.waitForResponse(response => response.url().endsWith(`/comments/${detail.comments[0].id}/resolve`) && response.request().method() === "POST");
      await resolve.click();
      const resolution = await resolved;
      assert.equal(resolution.status(), 200); assert.equal(resolution.request().postDataJSON().head, checked.head);
      assert.equal((await resolution.json()).run_id, run.id);
      assert.equal((await stale.json(`/runs/${retried.id}/reconcile`, {})).condition, "completed");
      await page.reload();
      const accepted = page.waitForResponse(response => response.url().endsWith(`/runs/${retried.id}/accept`) && response.request().method() === "POST");
      await page.getByRole("region", { name: "Next step", exact: true }).getByRole("button", { name: "Accept reviewed head", exact: true }).click();
      assert.equal((await accepted).status(), 200);
      assert.equal((await stale.json(path)).approvals.some((approval: any) => approval.kind === "review" && approval.scope.startsWith(`Run ${retried.id};`)), true);
    } finally { await page.close(); stale.close(); }
  }
  console.log("PASS: desktop/mobile retired implementation retains invalidated capacity until explicit Stop and Retry preserves its produced commit");
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
        const initial = await guarded.json(path);
        assert.deepEqual(initial.approvals, []); assert.deepEqual(initial.questions, []);
        assert.equal(prepared.planning.condition, "prepared"); assert.equal(prepared.planning.origin, "issue_body");
        await guarded.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true });
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
        const stale = await guarded.json(path);
        assert.equal(stale.github_sources[0].planning.condition, "stale");
        assert.equal(stale.github_sources[0].planning.specification_id, initial.specifications.at(-1).id);
        assert.equal(stale.github_sources[0].planning.graph_hash, initial.graph_hash);
        await openControl();
        assert(await page.getByRole("button", { name: control, exact: true }).isDisabled());
        guarded.save(); await guarded.json(route + "/sync", {});
        assert.deepEqual((await guarded.json(path)).questions, []);
        assert.equal((await guarded.json(path)).github_sources[0].planning.condition, "prepared");
        // Readiness loss retains the same action, but renewal alone cannot refresh its plan.
        guarded.issue.labels = []; guarded.save(); await guarded.json(route + "/sync", {});
        await openControl();
        assert(await page.getByRole("button", { name: control, exact: true }).isDisabled());
        assert.equal((await guarded.json(path)).runs.length, 0);
        guarded.issue.labels = [{ name: "ready-for-agent" }]; guarded.save();
        const renewed = (await guarded.json(route + "/sync", {})).sources[0];
        await guarded.json(route + "/issues/1/approve", { source_revision: renewed.revision, policy_revision: readiness.revision });
        await openControl();
        assert(await page.getByRole("button", { name: control, exact: true }).isDisabled());
        await guarded.json(route + "/issues/1/prepare", { source_revision: renewed.revision });
        const recovered = (await guarded.json(route + "/sync", {})).sources[0];
        assert.equal(recovered.planning.condition, "prepared");
        assert.deepEqual((await guarded.json(path)).approvals, []);
        const queue = await guarded.json(route + "/queue");
        await guarded.json(route + "/queue", { expected_revision: queue.policy.revision, automatic_implementation: false, paused: false });
        await openControl();
        const started = page.waitForResponse(response => response.url().endsWith(path + "/runs") && response.request().method() === "POST");
        await page.getByRole("button", { name: control, exact: true }).click();
        const admitted = await started; assert.equal(admitted.status(), 202);
        const run = await admitted.json();
        assert.equal(run.manifest.issue_admission.source.id, source.id);
        assert.equal(run.manifest.issue_admission.source.revision, recovered.revision);
        assert.equal((await guarded.json(path)).runs.length, 1);
      } finally { await page.close(); guarded.close(); }
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile existing implementation controls retain disabled actions across outage/readiness loss and use fresh guarded admission");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const condition of ["ready", "working", "disconnected"] as const) {
      const continuation = issueContinuationFixture();
      const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
      page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
      try {
        continuation.setPlanningCondition(condition);
        const { path, planning, body, project } = await continuation.preparedPlanning();
        const before = await continuation.json(path);
        assert.deepEqual(before.questions, []);
        assert.equal(before.github_sources[0].planning.condition, "prepared");
        assert.equal(before.github_sources[0].planning.origin, "app_plan");
        await page.goto(continuation.origin + `/#factory/${planning.implementation_id}`);
        const button = page.getByRole("region", { name: "Next step", exact: true }).getByRole("button", { name: "Continue workflow", exact: true });
        await button.waitFor();
        if (condition !== "ready") {
          assert(await button.isDisabled());
          assert.equal((await continuation.json(path)).runs.length, 1);
          continue;
        }
        // A different Assignment's ready chat cannot retire the displayed step.
        const other = await continuation.json("/implementations", { title: "Unrelated browser plan", project_id: project.id, description: "Owned unrelated planning" });
        const unrelated = await continuation.json(`/implementations/${other.id}/runs`, { action: "to-spec", idempotency_key: "browser-unrelated-step" });
        await continuation.json(`/runs/${unrelated.id}/reconcile`, {});
        const rejected = await page.evaluate(async ({ path, body, runId }) => {
          const response = await fetch("/api/factory" + path + "/continue", { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1", authorization: "Bearer fixture-owner" }, body: JSON.stringify({ ...body, run_id: runId, idempotency_key: "browser-wrong-step" }) });
          return { status: response.status, code: (await response.json()).error.code };
        }, { path, body, runId: unrelated.id });
        assert.deepEqual(rejected, { status: 409, code: "step_changed" });
        const unchanged = await continuation.json(path);
        assert.deepEqual(unchanged.runs, before.runs); assert.deepEqual(unchanged.messages, before.messages);
        assert.equal(unchanged.events.some((event: any) => event.kind === "workflow_step_finished"), false);
        assert.equal((await continuation.json(`/implementations/${other.id}`)).runs[0].condition, "ready");
        const started = page.waitForResponse(response => response.url().endsWith(path + "/continue") && response.request().method() === "POST");
        await button.click();
        const response = await started; assert.equal(response.status(), 202);
        assert.equal(response.request().postDataJSON().run_id, planning.id);
        assert.deepEqual(response.request().postDataJSON().issue_scope, body.issue_scope);
        const detail = await continuation.json(path);
        assert.deepEqual(detail.runs.map((run: any) => [run.action, run.condition]), [["to-tickets", "completed"], ["implement-spec", "working"]]);
        assert(detail.messages.some((message: any) => message.content.includes("Retained fictional planning handoff.")));
        assert.equal(detail.runs[1].manifest.issue_admission.source.id, body.issue_scope.source_id);
      } finally { await page.close(); continuation.close(); }
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile exact ready planning Continue retains handoff and admission; working, uncertain and unrelated predecessors cannot retire");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const continuation = issueContinuationFixture();
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
    try {
      const { path, planning, body, route } = await continuation.preparedPlanning("to-spec");
      const prepared = await continuation.json(path);
      assert.deepEqual(prepared.approvals, []); assert.deepEqual(prepared.questions, []);
      assert.equal(prepared.github_sources[0].planning.condition, "prepared");
      assert.equal(prepared.github_sources[0].planning.origin, "issue_body");
      continuation.setFactoryReady(false);
      await page.goto(continuation.origin + `/#factory/${planning.implementation_id}`);
      continuation.save([continuation.issue], true); assert.equal((await continuation.post(route + "/sync", {})).status, 409);
      await page.reload();
      assert(await page.getByRole("region", { name: "Next step", exact: true }).getByRole("button", { name: "Continue workflow", exact: true }).isDisabled());
      const retained = await continuation.json(path);
      assert.equal(retained.github_sources[0].planning.condition, "stale");
      assert.equal(retained.github_sources[0].planning.specification_id, prepared.specifications.at(-1).id);
      assert.equal(retained.github_sources[0].planning.graph_hash, prepared.graph_hash);
      assert.deepEqual(retained.runs, prepared.runs); assert.deepEqual(retained.messages, prepared.messages);
      continuation.save(); await continuation.json(route + "/sync", {});
      assert.equal((await continuation.json(path)).github_sources[0].planning.condition, "prepared");
      await page.reload();
      const started = page.waitForResponse(response => response.url().endsWith(path + "/continue") && response.request().method() === "POST");
      await page.getByRole("region", { name: "Next step", exact: true }).getByRole("button", { name: "Continue workflow", exact: true }).click();
      const response = await started; assert.equal(response.status(), 202);
      assert.deepEqual(response.request().postDataJSON().issue_scope, body.issue_scope);
      const probe = await response.json(); assert.equal(probe.action, "verify-provider");
      const question = await continuation.agent(probe.id, "question", { question: "Confirm the owned browser verification fixture?" }).then(response => response.json());
      await continuation.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Owned fictional verification answer" });
      continuation.setVerificationAvailable(); continuation.setRunCondition(probe.id, "ready");
      const contract = await continuation.agent(probe.id, "contract").then(response => response.json());
      assert.equal((await continuation.agent(probe.id, "consume", { revision: contract.question_revision })).status, 200);
      const deadline = Date.now() + 5000;
      let detail;
      do {
        detail = await continuation.json(path);
        if (detail.runs.at(-1)?.action === "implement-spec" && detail.runs.at(-1)?.condition === "working") break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      assert.deepEqual(detail.runs.map((run: any) => [run.action, run.condition]), [["to-spec", "completed"], ["verify-provider", "completed"], ["implement-spec", "working"]]);
      assert.equal(detail.runs.at(-1).manifest.issue_admission.source.revision, body.issue_scope.source_revision);
      assert.deepEqual(detail.approvals, []);
      assert.equal(detail.runs.length, 3);
      await page.goto(continuation.origin + `/#factory/${planning.implementation_id}`);
      await page.getByRole("region", { name: "Next step", exact: true }).waitFor();
      assert.equal(await page.getByRole("region", { name: "Next step", exact: true }).getByRole("button", { name: "Continue workflow", exact: true }).count(), 0);
    } finally { await page.close(); continuation.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile prepared issue Continue runs verification before one guarded implementation successor");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const continuation = issueContinuationFixture();
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", recordPageError);
    try {
      const { path, planning, body, route, readiness } = await continuation.preparedPlanning("to-spec");
      const before = await continuation.json(path);
      continuation.issue.labels = []; continuation.save(); await continuation.json(route + "/sync", {});
      await page.goto(continuation.origin + `/#factory/${planning.implementation_id}`);
      const button = page.getByRole("region", { name: "Next step", exact: true }).getByRole("button", { name: "Continue workflow", exact: true });
      assert(await button.isDisabled());
      const rejected = await continuation.post(path + "/continue", body);
      assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error.code, "issue_changed");
      continuation.issue.labels = [{ name: "ready-for-agent" }]; continuation.save();
      const current = (await continuation.json(route + "/sync", {})).sources[0];
      await continuation.json(route + "/issues/1/approve", { source_revision: current.revision, policy_revision: readiness.revision });
      await page.reload(); assert(await button.isDisabled());
      const busy = await continuation.post(route + "/issues/1/prepare", { source_revision: current.revision });
      assert.equal(busy.status, 409); assert.equal((await busy.json()).error.code, "planning_busy");
      const stillBlocked = await continuation.post(path + "/continue", { ...body, issue_scope: { ...body.issue_scope, source_revision: current.revision } });
      assert.equal(stillBlocked.status, 409); assert.equal((await stillBlocked.json()).error.code, "issue_not_eligible");
      const retained = await continuation.json(path);
      assert.deepEqual(retained.runs, before.runs); assert.deepEqual(retained.messages, before.messages);
      assert.deepEqual(retained.approvals, []); assert.deepEqual(retained.questions, []);
      assert.equal(retained.github_sources[0].planning.graph_hash, before.graph_hash);
      assert.equal(retained.events.some((event: any) => event.kind === "workflow_step_finished"), false);
    } finally { await page.close(); continuation.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile natural Continue remains visible and blocked after readiness renewal while its predecessor retains ownership");
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
    await fixture.json(route + "/queue", { expected_revision: queue.policy.revision, automatic_implementation: false, paused: false });
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
      const drawer = page.getByRole("button", { name: "Close workspace list", exact: true });
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
      assert.equal(await region.getByRole("button", { name: "Move earlier", exact: true }).count(), 0);
      assert.equal(await region.getByRole("button", { name: "Move later", exact: true }).count(), 0);
      assert(await first.isVisible());
      await region.getByRole("article").first().getByRole("link", { name: "#1 · Fictional scope", exact: true }).waitFor();
      await region.getByLabel("Pause queue", { exact: true }).check();
      await region.getByLabel("Implementing Assignment limit", { exact: true }).fill("2");
      await region.getByRole("button", { name: "Save queue settings", exact: true }).click();
      await region.getByText("Queue paused. Admitted work continues.", { exact: true }).waitFor();
      await region.getByText("Preview changed. Review the backlog again.", { exact: true }).waitFor();
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
  console.log("PASS: desktop/mobile backlog count/reasons, stale preview, automatic creation order, pause, limits, Needs you and outage; no starts");
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
      const contract = page.getByRole("region", { name: "Admitted issue contract", exact: true }).first();
      await contract.getByText("The admitted scope stays fixed. Required checks and independent reviews still apply.", { exact: true }).waitFor();
      await contract.getByText(source.revision, { exact: true }).waitFor();
      await contract.getByText("Approved by fictional-owner", { exact: true }).waitFor();
      const run = (await admitted.json(path)).runs[0];
      assert.equal(run.condition, "working");
      const advanced = page.locator("details").filter({ has: page.locator(":scope > summary").filter({ hasText: /^Advanced controls$/ }) });
      await advanced.locator(":scope > summary").click();
      const frozenContract = advanced.getByRole("region", { name: "Admitted issue contract", exact: true });
      await frozenContract.getByText("Reused planning", { exact: true }).click();
      await frozenContract.getByText(run.graph_hash, { exact: true }).waitFor();
      await frozenContract.getByText("Public HTTP and real browser journeys.", { exact: true }).first().waitFor();
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
      const drawer = page.getByRole("button", { name: "Close workspace list", exact: true });
      if (await drawer.isVisible()) await drawer.click();
      await page.getByRole("button", { name: `Project settings for ${project.name}`, exact: true }).click();
      await page.getByRole("tab", { name: "GitHub", exact: true }).click();
      const queue = page.getByRole("region", { name: "Issue queue", exact: true });
      assert.equal(await queue.getByText(/Project implementation slots available/).count(), 0);
      assert.equal(await queue.getByRole("spinbutton", { name: "Concurrent Assignments", exact: true }).count(), 0);
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
  console.log("PASS: desktop/mobile awaiting merge, separate owner acceptance, informational ownership and unrelated Agent admission without false delivery");
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
      assert.equal(await queue.getByRole("button", { name: "Move earlier", exact: true }).count(), 0);
      assert.equal(await queue.getByRole("button", { name: "Move later", exact: true }).count(), 0);
      assert.equal((await automatic.json(route + "/queue")).entries[0].number, 1);
      await queue.getByRole("article").first().getByRole("link", { name: "#1 · Fictional scope", exact: true }).waitFor();
      automatic.setLaunchOutcome("failed");
      await queue.getByLabel("Pause queue", { exact: true }).uncheck();
      await queue.getByRole("button", { name: "Save queue settings", exact: true }).click();
      await queue.getByText("Automatic implementation is on.", { exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Issue queue"] form button:disabled'));
      const sources = (await automatic.json(route)).sources;
      const failedSource = sources.find((source: any) => source.number === 1);
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
      automatic.issue.body += "\nChanged automatic scope.";
      automatic.save([automatic.issue, later, blocked], false, {}, true); await automatic.json(route + "/sync", {});
      await page.reload();
      await contract.getByText("Controlled pause requested. Issue scope changed.", { exact: true }).waitFor();
      assert.deepEqual((await automatic.json(failedPath)).runs.at(-1).manifest, run.manifest);
      assert(await contract.evaluate(element => element.scrollWidth <= element.clientWidth));
    } finally { await page.close(); automatic.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile identity selection, reviewed automatic opt-in, queued/blocked creation order, pause, failed-attempt Retry, outage continuation and controlled pause");
} finally { await browser.close(); fixture.close(); }
