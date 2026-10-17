/** Explicit merge authority and truthful delivery through the desktop/mobile Human Review. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { releaseBrowserFixture } from "./factory-release-browser-fixture.ts";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { published, until } from "./factory-human-review-fixture.ts";

export async function containingReleaseJourney(browser: Browser, viewport: { width: number; height: number }) {
  const f = await releaseBrowserFixture();
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
  try {
    const origin = () => `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin()}/api/auth`, { data: { token: f.token } })).status(), 204);
    const before = await f.detail(); assert.equal(before.human_review_approvals.length, 0);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin()}/#factory/${f.id}`);
    await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
    const review = page.getByRole("region", { name: "Human Review", exact: true });
    try { await review.getByRole("button", { name: "result.txt · branch:M", exact: true }).waitFor(); }
    catch (error) { console.error(JSON.stringify({ setup_detail: await f.detail(), setup_dom: await page.locator("body").innerText() })); throw error; }
    const response = page.waitForResponse(response => response.url().endsWith(`${f.prefix}/human-review/approve`) && response.request().method() === "POST");
    await review.getByRole("button", { name: "Approve and merge", exact: true }).click();
    const approved = await response; const receipt = await approved.json(); assert.equal(approved.status(), 200, JSON.stringify(receipt));
    const waiting = await until(f.detail, d => d.human_review_approvals[0]?.condition === "awaiting_release");
    const approval = waiting.human_review_approvals[0];
    assert.equal(approval.id, receipt.id); assert.equal(approval.head, f.core.head); assert.equal(approval.snapshot_id, f.snapshot.id);
    assert.equal(approval.idempotency_key, approved.request().postDataJSON().idempotency_key);
    assert.equal(waiting.implementation.stage, "review");
    assert.equal(f.mergeRequests.length, 1);
    const body = f.mergeRequests[0]!;
    assert.equal(body.approval.id, approval.id); assert.equal(body.approval.idempotency_key, approval.idempotency_key);
    assert.equal(body.approval.snapshot_id, f.snapshot.id); assert.equal(body.head, f.core.head);
    assert.notEqual(body.approval.id, f.core.body.approval.id, "The browser creates its own authority; the Machine fixture's API approval is unused");
    const merge = approval.merge_sha;
    assert.equal(f.core.git(["rev-parse", "main"]), merge);
    const effects = () => f.core.calls().filter(args => args[1]?.endsWith("/merge") && args.includes("PUT")).length;
    assert.equal(effects(), 1);
    const observe = () => f.core.post(f.core.route + "merge", body);
    f.core.git(["tag", "unrelated-old-release", f.core.base]); f.core.change({ release: "unrelated-old-release" });
    let observed = await observe(); assert.equal(observed.status, 200);
    assert.equal((await observed.json()).condition, "awaiting_release", "A tag outside the verified merge's ancestry cannot deliver the Assignment");
    const reverted = f.core.descendant("before\n"); f.core.git(["tag", "reverted-release", reverted]); f.core.change({ release: "reverted-release" });
    assert.equal(f.core.git(["show", "reverted-release:result.txt"]), "before");
    f.core.git(["merge-base", "--is-ancestor", merge, reverted]);
    observed = await observe(); assert.equal(observed.status, 200);
    assert.equal((await observed.json()).condition, "awaiting_release", "An actual descendant revert cannot satisfy containing release evidence");
    f.core.git(["tag", "moving-release", merge]); f.core.change({ release: "moving-release", move_tag_after_lookup: f.core.base });
    observed = await observe(); const moved = await observed.json();
    assert.equal(observed.status, 409, JSON.stringify(moved)); assert.equal(moved.error.code, "merge_coverage_unverified");
    assert.equal(f.core.git(["rev-parse", "moving-release"]), f.core.base);
    const stillWaiting = await f.detail(); assert.equal(stillWaiting.implementation.stage, "review");
    assert.equal(stillWaiting.human_review_approvals.length, 1); assert.equal(stillWaiting.human_review_approvals[0].id, approval.id);
    assert.equal(stillWaiting.human_review_approvals[0].release_tag, null); assert.equal(effects(), 1);
    const additive = f.core.descendant("after\nIndependent later content\n");
    f.core.git(["tag", "additive-release", additive]); f.core.change({ release: "additive-release" });
    f.core.git(["merge-base", "--is-ancestor", merge, additive]);
    assert.equal(f.core.git(["show", "additive-release:result.txt"]), "after\nIndependent later content");
    assert.notEqual(f.core.git(["rev-parse", "additive-release:result.txt"]), f.core.git(["rev-parse", `${merge}:result.txt`]));
    await page.close(); await f.restart();
    assert.equal((await context.request.post(`${origin()}/api/auth`, { data: { token: f.token } })).status(), 204);
    const restored = await context.newPage(); restored.setDefaultTimeout(10000); restored.on("pageerror", error => errors.push(error.message));
    await restored.goto(`${origin()}/#factory/${f.id}`);
    await restored.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
    const retainedReview = restored.getByRole("region", { name: "Human Review", exact: true });
    try { await retainedReview.getByText("Release verified", { exact: true }).waitFor({ timeout: 45000 }); }
    catch (error) { console.error(JSON.stringify({ viewport: viewport.width, containing_release_failure: await f.detail(), machine: f.core.githubState(), merge_requests: f.mergeRequests.length })); throw error; }
    const done = await until(f.detail, d => d.runs.find((run: { id: string }) => run.id === f.core.id)?.condition === "completed");
    assert.equal(done.implementation.stage, "done"); assert.equal(done.implementation.outcome, "released");
    assert.equal(done.human_review_approvals.length, 1);
    const delivered = done.human_review_approvals[0];
    assert.equal(delivered.id, approval.id); assert.equal(delivered.idempotency_key, approval.idempotency_key);
    assert.equal(delivered.head, approval.head); assert.equal(delivered.snapshot_id, approval.snapshot_id);
    assert.equal(delivered.condition, "released"); assert.equal(delivered.merge_sha, merge); assert.equal(delivered.release_tag, "additive-release");
    assert(f.mergeRequests.length >= 2, "Restart observes the retained authority without another owner decision");
    for (const request of f.mergeRequests) { assert.equal(request.approval.id, approval.id); assert.equal(request.approval.idempotency_key, approval.idempotency_key); assert.equal(request.head, f.core.head); }
    assert.equal(effects(), 1, "All observations retain exactly one actual GitHub merge");
    assert(done.native_snapshots.some((snapshot: { run_id: string; source_id: string }) => snapshot.run_id === f.core.id && snapshot.source_id === "owned-release-history"));
    await restored.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Orchestrator", exact: true }).click();
    await restored.getByText("Retained containing release history.", { exact: true }).waitFor();
    assert(await restored.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
    console.log(`PASS actual Git additive containing release, reverted/non-containing/moved tags, retained single UI approval after Machine/connection restart (${viewport.width})`);
  } finally { await context.close(); await f.close(); }
}

export async function contextSendJourney(browser: Browser, viewport: { width: number; height: number }) {
  const f = await releaseBrowserFixture({ milestone: "merge" });
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
  try {
    const origin = `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
    const before = await f.detail(); assert.equal(before.human_review_approvals.length, 0);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/#factory/${f.id}`);
    await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
    const review = page.getByRole("region", { name: "Human Review", exact: true });
    f.core.change({ hold_graphql: true, graphql_waiting: false });
    const response = page.waitForResponse(response => response.url().endsWith(`${f.prefix}/human-review/approve`) && response.request().method() === "POST");
    await review.getByRole("button", { name: "Approve and merge", exact: true }).click();
    let authority: { id: string; context_revision: string; idempotency_key: string; head: string; snapshot_id: string } | undefined;
    const question = { question: "Should this merge add an external delivery target?" };
    const ask = () => context.request.post(`${origin}${f.prefix}/questions`, { data: question, headers: { origin, "x-herdr-factory": "1" } });
    const effects = () => f.core.calls().filter(args => args[1]?.endsWith("/merge") && args.includes("PUT")).length;
    try {
      await until(async () => f.core.githubState(), state => state.graphql_waiting === true);
      const retained = await f.detail(); authority = retained.human_review_approvals[0];
      assert(authority); assert.equal(retained.human_review_approvals.length, 1);
      assert.equal(authority.context_revision, before.question_revision);
      assert.equal(authority.head, f.core.head); assert.equal(authority.snapshot_id, f.snapshot.id);
      assert.equal(f.mergeRequests.length, 1); assert.equal(f.mergeRequests[0]!.approval.id, authority.id);
      assert.equal(f.mergeRequests[0]!.approval.idempotency_key, authority.idempotency_key);
      assert.notEqual(authority.id, f.core.body.approval.id);
      await page.getByRole("status").filter({ hasText: "Saving…" }).waitFor();
      assert.equal(await review.getByRole("alert").count(), 0);
      assert.equal(effects(), 0, "GitHub validation is still held before the irreversible merge");
      const attempted = await ask(); const result = await attempted.json();
      const after = await f.detail();
      console.log(JSON.stringify({ viewport: viewport.width, merge_context_attempt: { status: attempted.status(), result, before_revision: before.question_revision, after_revision: after.question_revision, approval: after.human_review_approvals[0], questions: after.questions } }));
      assert.equal(attempted.status(), 409, "A new product scope question cannot change authority while Machine merge validation is in flight");
      assert.equal(result.error.code, "merge_context_busy");
      assert.deepEqual(after.questions, before.questions, "The rejected question writes no owner context");
      assert.equal(after.question_revision, before.question_revision);
      assert.deepEqual(after.events.filter((event: { kind: string }) => ["question_asked", "owner_answered"].includes(event.kind)), before.events.filter((event: { kind: string }) => ["question_asked", "owner_answered"].includes(event.kind)));
      assert.equal(after.human_review_approvals.length, 1); assert.equal(after.human_review_approvals[0].id, authority.id);
      assert.equal(after.human_review_approvals[0].context_revision, authority.context_revision);
      assert.equal(after.human_review_approvals[0].idempotency_key, authority.idempotency_key);
      assert.equal(after.human_review_approvals[0].condition, "pending"); assert.equal(effects(), 0);
    } finally { f.core.change({ hold_graphql: false }); await response; }
    const approved = await response; const receipt = await approved.json(); assert.equal(approved.status(), 200, JSON.stringify(receipt));
    await review.getByRole("status").filter({ hasText: "Merge verified" }).waitFor();
    const delivered = await until(f.detail, d => d.runs.find((run: { id: string }) => run.id === f.core.id)?.condition === "completed");
    assert.equal(delivered.implementation.stage, "done"); assert.equal(delivered.implementation.outcome, "merged");
    assert.equal(delivered.human_review_approvals.length, 1); assert.equal(delivered.human_review_approvals[0].id, authority!.id);
    assert.equal(delivered.human_review_approvals[0].context_revision, authority!.context_revision);
    assert.equal(delivered.human_review_approvals[0].condition, "merged"); assert.equal(effects(), 1);
    await page.reload(); await review.getByRole("status").filter({ hasText: "Merge verified" }).waitFor();
    assert.equal(await review.getByRole("alert").count(), 0);
    const permitted = await ask(); const followup = await permitted.json(); assert.equal(permitted.status(), 201, JSON.stringify(followup));
    const completed = await f.detail();
    assert.equal(completed.questions.length, before.questions.length + 1); assert.equal(followup.question, question.question);
    assert.notEqual(completed.question_revision, before.question_revision, "Verified merge releases the context fence for a genuine later owner question");
    assert.equal(completed.human_review_approvals.length, 1); assert.equal(completed.human_review_approvals[0].id, authority!.id);
    assert.equal(completed.human_review_approvals[0].condition, "merged"); assert.equal(completed.implementation.stage, "done");
    assert.equal(completed.runs.find((run: { id: string }) => run.id === f.core.id).condition, "completed");
    assert.equal(effects(), 1); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
    console.log(`PASS actual UI approval fences owner context during held Machine validation, keeps authority unchanged, and permits later questions after verified merge (${viewport.width})`);
  } finally { f.core.change({ hold_graphql: false }); await context.close(); await f.close(); }
}

export async function postmergeHistoryJourney(browser: Browser, viewport: { width: number; height: number }) {
  let historyAvailable = true;
  const f = await capacityFixture({ advancingHeads: true, runTranscript: () => historyAvailable ? { source_id: "owned-postmerge-history", version: "one", cursor: null, turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: "Retained implementation after verified merge." }] }] } : null });
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
  try {
    const { id, detail, run } = await published(f); await until(detail, d => d.human_reviews[0]?.condition === "ready");
    let origin = `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const openReview = async () => { await page.goto(`${origin}/#factory/${id}`); await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click(); };
    await openReview();
    const review = page.getByRole("region", { name: "Human Review", exact: true });
    await review.getByRole("status").filter({ hasText: "Review the captured result and discuss it with the assistant." }).waitFor();
    historyAvailable = false;
    const response = page.waitForResponse(response => response.url().endsWith(`/implementations/${id}/human-review/approve`) && response.request().method() === "POST");
    await review.getByRole("button", { name: "Approve and merge", exact: true }).click();
    const approved = await response; assert.equal(approved.status(), 200); const approval = await approved.json();
    const failed = await until(detail, d => d.events.some((event: { kind: string }) => event.kind === "delivery_completion_pending"));
    const event = failed.events.filter((event: { kind: string }) => event.kind === "delivery_completion_pending").at(-1);
    const reason = event.data.reason; assert.equal(typeof reason, "string"); assert(reason);
    const pending = failed.runs.find((entry: { id: string }) => entry.id === run.id);
    assert.equal(pending.condition, "ready"); assert.equal(failed.implementation.stage, "done");
    assert.equal(failed.human_review_approvals[0].id, approval.id); assert.equal(failed.human_review_approvals[0].condition, "merged"); assert.equal(f.mergeEffects.length, 1);
    await review.getByRole("status").filter({ hasText: "Merge verified" }).waitFor();
    await page.getByText("Advanced controls", { exact: true }).click();
    const history = page.getByRole("region", { name: "Past attempts", exact: true });
    const notice = history.getByText(reason, { exact: true }); await notice.waitFor();
    console.log(JSON.stringify({ viewport: viewport.width, postmerge_history_fault: { condition: pending.condition, reason, role: await notice.getAttribute("role"), approval: failed.human_review_approvals[0], merge_effects: f.mergeEffects.length } }));
    assert.equal(await notice.getAttribute("role"), "alert", "A real native history failure after verified merge remains an error even when its Run is ready");
    assert.equal(await history.getByRole("status").filter({ hasText: reason }).count(), 0);
    await page.reload(); await page.getByText("Advanced controls", { exact: true }).click();
    await history.getByRole("alert").filter({ hasText: reason }).waitFor();
    f.restart(); origin = `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
    await openReview(); await page.getByText("Advanced controls", { exact: true }).click();
    await history.getByRole("alert").filter({ hasText: reason }).waitFor();
    assert.equal((await detail()).human_review_approvals[0].id, approval.id); assert.equal(f.mergeEffects.length, 1);
    historyAvailable = true;
    const recovered = await until(detail, d => d.runs.find((entry: { id: string }) => entry.id === run.id)?.condition === "completed");
    assert.equal(recovered.implementation.stage, "done"); assert.equal(recovered.human_review_approvals[0].condition, "merged");
    assert.equal(recovered.human_review_approvals.length, 1); assert.equal(recovered.human_review_approvals[0].id, approval.id);
    assert(!recovered.runs.find((entry: { id: string }) => entry.id === run.id).delivery_completion_error);
    await page.reload(); await page.getByText("Advanced controls", { exact: true }).click();
    assert.equal(await history.getByText(reason, { exact: true }).count(), 0);
    await review.getByRole("status").filter({ hasText: "Merge verified" }).waitFor();
    assert.equal(f.mergeEffects.length, 1); assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log(`PASS verified merge retains actual native history error alert through reload/restart and recovers without a second approval (${viewport.width})`);
  } finally { historyAvailable = true; await context.close(); f.close(); }
}

export async function postmergeQuestionReleaseJourney(browser: Browser, viewport: { width: number; height: number }) {
  const f = await releaseBrowserFixture();
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
  try {
    const origin = `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/#factory/${f.id}`);
    await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
    const review = page.getByRole("region", { name: "Human Review", exact: true });
    const response = page.waitForResponse(response => response.url().endsWith(`${f.prefix}/human-review/approve`) && response.request().method() === "POST");
    await review.getByRole("button", { name: "Approve and merge", exact: true }).click();
    const approved = await response; assert.equal(approved.status(), 200);
    const waiting = await until(f.detail, d => d.human_review_approvals[0]?.condition === "awaiting_release");
    const authority = waiting.human_review_approvals[0]; const merge = authority.merge_sha;
    await review.getByRole("status").filter({ hasText: "Merge verified; waiting for a published release containing it" }).waitFor();
    assert.equal(waiting.implementation.stage, "review"); assert.equal(f.core.git(["rev-parse", "main"]), merge);
    const effects = () => f.core.calls().filter(args => args[1]?.endsWith("/merge") && args.includes("PUT")).length;
    assert.equal(effects(), 1);
    const headers = { origin, "x-herdr-factory": "1" };
    const asked = await context.request.post(`${origin}${f.prefix}/questions`, { headers, data: { question: "Should this verified merge gain another delivery target?" } });
    const question = await asked.json(); assert.equal(asked.status(), 201, JSON.stringify(question));
    const answer = "Keep the original reviewed scope and authorized target unchanged.";
    const answered = await context.request.post(`${origin}${f.prefix}/questions/${question.id}/answer`, { headers, data: { revision: question.revision, answer } });
    assert.equal(answered.status(), 200, JSON.stringify(await answered.json()));
    const current = await f.detail(); assert.notEqual(current.question_revision, waiting.question_revision);
    assert.equal(current.questions.find((entry: { id: string }) => entry.id === question.id).answer, answer);
    assert.equal(current.human_review_approvals[0].id, authority.id); assert.equal(current.human_review_approvals[0].context_revision, authority.context_revision);
    assert.deepEqual(current.implementation.delivery_scope, waiting.implementation.delivery_scope);
    f.core.git(["tag", "postmerge-owner-release", merge]); f.core.change({ release: "postmerge-owner-release" });
    const settled = await until(f.detail, d => ["released", "blocked"].includes(d.human_review_approvals[0]?.condition), 45000);
    console.log(JSON.stringify({ viewport: viewport.width, postmerge_answered_release: { approval: settled.human_review_approvals[0], question_revision: settled.question_revision, original_revision: authority.context_revision, actual_release: f.core.githubState().release, merge_effects: effects() } }));
    assert.equal(settled.human_review_approvals[0].condition, "released", "Answered owner context cannot strand read-only observation of an already verified merge's original containing-release milestone");
    await review.getByRole("status").filter({ hasText: "Release verified" }).waitFor();
    const done = await until(f.detail, d => d.runs.find((entry: { id: string }) => entry.id === f.core.id)?.condition === "completed");
    assert.equal(done.implementation.stage, "done"); assert.equal(done.implementation.outcome, "released"); assert.equal(done.human_review_approvals.length, 1);
    const retained = done.human_review_approvals[0]; assert.equal(retained.id, authority.id); assert.equal(retained.idempotency_key, authority.idempotency_key);
    assert.equal(retained.head, authority.head); assert.equal(retained.snapshot_id, authority.snapshot_id); assert.equal(retained.context_revision, authority.context_revision);
    assert.equal(retained.merge_sha, merge); assert.equal(retained.release_tag, "postmerge-owner-release"); assert.equal(effects(), 1);
    for (const request of f.mergeRequests) { assert.equal(request.approval.id, authority.id); assert.equal(request.approval.context_revision, authority.context_revision); assert.equal(request.approval.idempotency_key, authority.idempotency_key); assert.equal(request.head, authority.head); }
    await page.reload(); await review.getByRole("status").filter({ hasText: "Release verified" }).waitFor();
    assert.equal(await review.getByRole("alert").count(), 0); assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log(`PASS answered unchanged scope permits containing release under original verified merge authority without a second approval or merge (${viewport.width})`);
  } finally { await context.close(); await f.close(); }
}

export async function releasePagesJourney(browser: Browser, viewport: { width: number; height: number }) {
  const f = await releaseBrowserFixture();
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
  try {
    const origin = () => `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin()}/api/auth`, { data: { token: f.token } })).status(), 204);
    assert.equal((await f.detail()).human_review_approvals.length, 0);
    let page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const openReview = async () => {
      await page.goto(`${origin()}/#factory/${f.id}`);
      await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
    };
    await openReview();
    let review = page.getByRole("region", { name: "Human Review", exact: true });
    const response = page.waitForResponse(response => response.url().endsWith(`${f.prefix}/human-review/approve`) && response.request().method() === "POST");
    await review.getByRole("button", { name: "Approve and merge", exact: true }).click();
    const approved = await response; assert.equal(approved.status(), 200);
    const receipt = await approved.json();
    const waiting = await until(f.detail, d => d.human_review_approvals[0]?.condition === "awaiting_release");
    const authority = waiting.human_review_approvals[0]; const merge = authority.merge_sha;
    assert.equal(authority.id, receipt.id); assert.equal(authority.idempotency_key, approved.request().postDataJSON().idempotency_key);
    assert.notEqual(authority.id, f.core.body.approval.id, "Only the actual UI creates merge authority");
    assert.equal(authority.head, f.core.head); assert.equal(authority.snapshot_id, f.snapshot.id);
    assert.equal(f.core.git(["rev-parse", "main"]), merge);
    const effects = () => f.core.calls().filter(args => args[1]?.endsWith("/merge") && args.includes("PUT")).length;
    assert.equal(effects(), 1); assert.equal(waiting.implementation.stage, "review");
    await review.getByRole("status").filter({ hasText: "Merge verified; waiting for a published release containing it" }).waitFor();
    assert.equal(await review.getByRole("alert").count(), 0);
    f.core.git(["tag", "second-page-containing-release", merge]);
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, draft: true, prerelease: false, tag_name: `owned-draft-${index}` }));
    const secondPage = [{ id: 101, draft: false, prerelease: false, tag_name: "second-page-containing-release" }];
    f.core.change({ release_pages: { 1: firstPage, 2: secondPage }, release_page_error: 2 });
    const observed = await f.core.post(f.core.route + "merge", f.mergeRequests[0]!);
    const inventory = await observed.json();
    console.log(JSON.stringify({ viewport: viewport.width, incomplete_release_inventory: { status: observed.status, response: inventory, merge_effects: effects(), release_calls: f.core.calls().filter(args => args[1]?.includes("/releases")) } }));
    assert.equal(observed.status, 409, "An unread second release page must report incomplete inventory rather than claim no containing release exists");
    assert.equal(inventory.error.code, "release_inventory_unavailable"); assert.equal(effects(), 1);
    await page.close(); await f.restart();
    assert.equal((await context.request.post(`${origin()}/api/auth`, { data: { token: f.token } })).status(), 204);
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message));
    await openReview(); review = page.getByRole("region", { name: "Human Review", exact: true });
    const failed = await until(f.detail, d => d.human_review_approvals[0]?.reason_is_error === true, 45000);
    const fault = failed.human_review_approvals[0]; assert.equal(fault.condition, "awaiting_release"); assert.equal(fault.merge_sha, merge);
    assert.equal(fault.id, authority.id); assert.equal(failed.human_review_approvals.length, 1); assert.equal(failed.implementation.stage, "review");
    assert.equal(typeof fault.reason, "string"); assert(fault.reason);
    await review.getByRole("alert").filter({ hasText: fault.reason }).waitFor();
    assert.equal(await review.getByRole("status").filter({ hasText: fault.reason }).count(), 0);
    await page.reload(); await review.getByRole("alert").filter({ hasText: fault.reason }).waitFor();
    assert.equal(effects(), 1);
    f.core.change({ release_page_error: null });
    const done = await until(f.detail, d => d.runs.find((run: { id: string }) => run.id === f.core.id)?.condition === "completed", 45000);
    const delivered = done.human_review_approvals[0];
    assert.equal(done.implementation.stage, "done"); assert.equal(done.implementation.outcome, "released"); assert.equal(done.human_review_approvals.length, 1);
    assert.equal(delivered.condition, "released"); assert.equal(delivered.release_tag, "second-page-containing-release");
    assert.equal(delivered.id, authority.id); assert.equal(delivered.idempotency_key, authority.idempotency_key); assert.equal(delivered.context_revision, authority.context_revision);
    assert.equal(delivered.snapshot_id, authority.snapshot_id); assert.equal(delivered.head, authority.head); assert.equal(delivered.merge_sha, merge);
    assert.equal(delivered.reason_is_error, false); assert.equal(delivered.reason, null); assert.equal(effects(), 1);
    for (const request of f.mergeRequests) { assert.equal(request.approval.id, authority.id); assert.equal(request.approval.idempotency_key, authority.idempotency_key); assert.equal(request.approval.context_revision, authority.context_revision); assert.equal(request.head, authority.head); }
    assert(f.core.calls().some(args => args[1]?.includes("/releases?per_page=100&page=2")));
    await review.getByRole("status").filter({ hasText: "Release verified" }).waitFor();
    assert.equal(await review.getByRole("alert").count(), 0);
    await page.reload(); await review.getByRole("status").filter({ hasText: "Release verified" }).waitFor();
    assert.equal(await review.getByRole("alert").count(), 0); assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log(`PASS second-page real containing release recovers from incomplete inventory under original UI approval without another approval or GitHub merge (${viewport.width})`);
  } finally { await context.close(); await f.close(); }
}

/** A containing release preserves the approved change, rather than every unchanged file line. */
export async function releaseScopeJourney(browser: Browser, viewport: { width: number; height: number }, scenario: "independent-context" | "deleted-release") {
  const baseline = "configuration=base\nfeature=off\n";
  const candidate = "configuration=base\nfeature=on\n";
  const f = await releaseBrowserFixture({ baselineContent: baseline, candidateContent: candidate });
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
  try {
    const origin = () => `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin()}/api/auth`, { data: { token: f.token } })).status(), 204);
    assert.equal((await f.detail()).human_review_approvals.length, 0);
    let page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const openReview = async () => {
      await page.goto(`${origin()}/#factory/${f.id}`);
      await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
    };
    await openReview();
    let review = page.getByRole("region", { name: "Human Review", exact: true });
    await review.getByRole("button", { name: "result.txt · branch:M", exact: true }).waitFor();
    const response = page.waitForResponse(response => response.url().endsWith(`${f.prefix}/human-review/approve`) && response.request().method() === "POST");
    await review.getByRole("button", { name: "Approve and merge", exact: true }).click();
    const approved = await response; const receipt = await approved.json(); assert.equal(approved.status(), 200, JSON.stringify(receipt));
    const waiting = await until(f.detail, d => d.human_review_approvals[0]?.condition === "awaiting_release");
    const authority = waiting.human_review_approvals[0]; const merge = authority.merge_sha;
    assert.equal(authority.id, receipt.id); assert.equal(authority.idempotency_key, approved.request().postDataJSON().idempotency_key);
    assert.equal(authority.head, f.core.head); assert.equal(authority.snapshot_id, f.snapshot.id);
    assert.notEqual(authority.id, f.core.body.approval.id, "The UI creates the only authority used by this journey");
    assert.equal(f.core.git(["rev-parse", "main"]), merge); assert.equal(waiting.implementation.stage, "review");
    const effects = () => f.core.calls().filter(args => args[1]?.endsWith("/merge") && args.includes("PUT")).length;
    assert.equal(effects(), 1); assert.equal(f.mergeRequests.length, 1);
    const request = f.mergeRequests[0]!; assert.equal(request.approval.id, authority.id);
    await review.getByRole("status").filter({ hasText: "Merge verified; waiting for a published release containing it" }).waitFor();
    assert.equal(await review.getByRole("alert").count(), 0);
    const tag = scenario === "independent-context" ? "independent-context-release" : "disappearing-release";
    const releasedContent = scenario === "independent-context" ? "configuration=independent\nfeature=on\n" : candidate;
    const commit = f.core.descendant(releasedContent);
    f.core.git(["tag", tag, commit]); f.core.git(["merge-base", "--is-ancestor", merge, commit]);
    assert.equal(f.core.git(["show", `${tag}:result.txt`]), releasedContent.trim());
    f.core.change({ release: tag, ...(scenario === "deleted-release" ? { release_after_inventory_patch: { release: null } } : {}) });
    const observed = await f.core.post(f.core.route + "merge", request); const result = await observed.json();
    console.log(JSON.stringify({ viewport: viewport.width, scenario, original_authority: authority, machine_observation: { status: observed.status, result }, published_state: f.core.githubState(), merge_effects: effects() }));
    if (scenario === "independent-context") {
      assert.equal(observed.status, 200, JSON.stringify(result));
      assert.equal(result.condition, "released", "An independent edit to an unchanged configuration line must preserve the approved feature change's delivery");
    } else {
      assert.equal(f.core.git(["rev-parse", tag]), commit, "The Git tag remains after its published release disappears");
      assert.equal(observed.status, 409, "A release removed after inventory cannot satisfy the delivery milestone merely because its tag remains");
      assert.equal(typeof result.error?.message, "string");
      assert.equal(f.core.githubState().release, null, "The published release was actually removed after its inventory row was returned");
      // Retain an eventually consistent inventory while the current publication lookup
      // is still unavailable, so automatic observation and reload see the same fault.
      f.core.change({ release_pages: { 1: [{ id: 1, draft: false, prerelease: false, tag_name: tag }] }, release_lookup_missing: true });
    }
    assert.equal(effects(), 1);
    await page.close(); await f.restart();
    assert.equal((await context.request.post(`${origin()}/api/auth`, { data: { token: f.token } })).status(), 204);
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message));
    await openReview(); review = page.getByRole("region", { name: "Human Review", exact: true });
    if (scenario === "deleted-release") {
      const pending = await until(f.detail, d => d.human_review_approvals[0]?.reason_is_error === true, 45000);
      const fault = pending.human_review_approvals[0];
      assert.equal(pending.implementation.stage, "review"); assert.equal(fault.condition, "awaiting_release");
      assert.equal(fault.id, authority.id); assert.equal(fault.merge_sha, merge); assert.equal(fault.release_tag, null);
      assert.equal(pending.human_review_approvals.length, 1); assert.equal(effects(), 1);
      assert.equal(typeof fault.reason, "string"); assert(fault.reason);
      await review.getByRole("alert").filter({ hasText: fault.reason }).waitFor();
      assert.equal(await review.getByRole("status").filter({ hasText: fault.reason }).count(), 0);
      await page.reload(); await review.getByRole("alert").filter({ hasText: fault.reason }).waitFor();
      f.core.change({ release: tag, release_pages: null, release_after_inventory_patch: null, release_lookup_missing: false, release_lookup_patch: null });
    }
    const done = await until(f.detail, d => d.runs.find((run: { id: string }) => run.id === f.core.id)?.condition === "completed", 45000);
    const delivered = done.human_review_approvals[0];
    assert.equal(done.implementation.stage, "done"); assert.equal(done.implementation.outcome, "released");
    assert.equal(done.human_review_approvals.length, 1); assert.equal(delivered.condition, "released");
    assert.equal(delivered.id, authority.id); assert.equal(delivered.idempotency_key, authority.idempotency_key);
    assert.equal(delivered.context_revision, authority.context_revision); assert.equal(delivered.head, authority.head);
    assert.equal(delivered.snapshot_id, authority.snapshot_id); assert.equal(delivered.merge_sha, merge); assert.equal(delivered.release_tag, tag);
    assert.equal(delivered.reason_is_error, false); assert.equal(delivered.reason, null); assert.equal(effects(), 1);
    for (const observation of f.mergeRequests) {
      assert.equal(observation.approval.id, authority.id); assert.equal(observation.approval.idempotency_key, authority.idempotency_key);
      assert.equal(observation.approval.context_revision, authority.context_revision); assert.equal(observation.head, authority.head);
    }
    await review.getByRole("status").filter({ hasText: "Release verified" }).waitFor();
    assert.equal(await review.getByRole("alert").count(), 0);
    await page.reload(); await review.getByRole("status").filter({ hasText: "Release verified" }).waitFor();
    assert.equal(await review.getByRole("alert").count(), 0); assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log(`PASS real Git release ${scenario}, original UI authority and single merge, automatic delivery/recovery on ${viewport.width}`);
  } finally { await context.close(); await f.close(); }
}

if (import.meta.main) {
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const variant of ["answered_scope", "answered_pending", "answered_comments"] as const) {
      const f = await capacityFixture({ advancingHeads: true });
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
      try {
        const { id, prefix, detail, run } = await published(f);
        const original = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
        const candidate = original.human_reviews[0];
        const originalWorkers = new Set(original.workers.map((worker: { id: string }) => worker.id));
        const originalEvidence = new Set(original.review_evidence.map((report: { id: string }) => report.id));
        const origin = `http://localhost:${f.app.port}`;
        assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${origin}/#factory/${id}`);
        const navigation = page.getByRole("navigation", { name: "Workflow history", exact: true });
        await navigation.getByRole("button", { name: "Human Review", exact: true }).click();
        const review = page.getByRole("region", { name: "Human Review", exact: true });
        const approve = review.getByRole("button", { name: "Approve and merge", exact: true });
        await review.getByText("Approval merges this checked and independently reviewed candidate into its authorized target.", { exact: true }).waitFor();
        let prior: { id: string; context_revision: string; idempotency_key: string } | null = null;
        let priorBody: Record<string, unknown> | null = null;
        if (variant === "answered_pending") {
          f.mergeFailure("merge_waiting");
          const response = page.waitForResponse(response => response.url().endsWith(`${prefix}/human-review/approve`) && response.request().method() === "POST");
          await approve.click();
          const pending = await response;
          assert.equal(pending.status(), 200); prior = await pending.json(); priorBody = pending.request().postDataJSON();
          assert.equal((await detail()).human_review_approvals[0].condition, "pending");
          assert.equal(f.mergeEffects.length, 0);
        }
        let draftId: string | null = null;
        if (variant === "answered_comments") {
          await review.getByRole("button", { name: "After 1", exact: true }).click();
          await review.getByRole("textbox", { name: "Review finding", exact: true }).fill("Recheck the retained behavior after the owner answer");
          await review.getByRole("button", { name: "Save draft finding", exact: true }).click();
          await review.getByRole("region", { name: "Draft comments", exact: true }).getByText("Recheck the retained behavior after the owner answer", { exact: true }).waitFor();
          draftId = (await detail()).comments.find((comment: { content: string }) => comment.content === "Recheck the retained behavior after the owner answer").id;
        }
        const questionResponse = await f.agent(run.id, "question", { question: "Should this published candidate gain another external delivery target?" });
        assert.equal(questionResponse.status, 201);
        const question = await questionResponse.json();
        assert.equal(question.answer, null);
        if (variant === "answered_scope") {
          const rejected = page.waitForResponse(response => response.url().endsWith(`${prefix}/human-review/approve`) && response.request().method() === "POST");
          await approve.click();
          assert.equal((await rejected).status(), 409, "Unanswered context must not retain merge authority");
          assert.equal((await detail()).human_review_approvals.length, 0);
        }
        if (variant !== "answered_pending") await navigation.getByRole("button", { name: "Orchestrator", exact: true }).click();
        await page.getByText(question.question, { exact: true }).first().waitFor();
        await page.getByRole("textbox", { name: "Your answer", exact: true }).fill("No new delivery target; keep the accepted scope unchanged and review this answer.");
        const answered = page.waitForResponse(response => response.url().endsWith(`${prefix}/questions/${question.id}/answer`) && response.request().method() === "POST");
        const delivered = page.waitForResponse(response => /\/runs\/[^/]+\/send-answers$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
        await page.getByRole("button", { name: "Save answer", exact: true }).click();
        const answerResponse = await answered; assert.equal(answerResponse.status(), 200);
        assert.equal(answerResponse.request().postDataJSON().revision, question.revision);
        assert(["sent", "queued", "sending"].includes((await (await delivered).json()).condition));
        const ownerContext = await f.agent(run.id, "contract").then(response => response.json());
        assert.notEqual(ownerContext.question_revision, original.question_revision);
        assert.equal((await f.agent(run.id, "consume", { revision: ownerContext.question_revision })).status, 200);
        f.runs.get(run.id)!.condition = "ready";
        const retainedAnswer = (await detail()).questions.find((entry: { id: string }) => entry.id === question.id);
        assert.equal(retainedAnswer.answer, "No new delivery target; keep the accepted scope unchanged and review this answer.");
        if (prior) {
          const invalidated = await until(detail, d => d.human_review_approvals.find((receipt: { id: string }) => receipt.id === prior!.id)?.condition === "blocked");
          const oldReceipt = invalidated.human_review_approvals.find((receipt: { id: string }) => receipt.id === prior!.id);
          assert.equal(oldReceipt.context_revision, original.question_revision);
          assert.equal(oldReceipt.idempotency_key, prior.idempotency_key);
          assert.equal(oldReceipt.merge_not_sent, true);
          f.mergeFailure(null);
        }
        assert.equal(f.mergeEffects.length, 0);
        console.log(JSON.stringify({ viewport: viewport.width, variant, question: question.id, answered_revision: ownerContext.question_revision, previous_revision: original.question_revision }));
        for (const axis of ["standards", "spec"]) {
          const reviewing = await until(detail, d => d.workers.some((worker: { id: string; role: string; condition: string }) => !originalWorkers.has(worker.id) && worker.role === axis && worker.condition === "working"));
          const worker = reviewing.workers.find((worker: { id: string; role: string; condition: string }) => !originalWorkers.has(worker.id) && worker.role === axis && worker.condition === "working");
          const contract = await f.agent(run.id, "contract").then(response => response.json());
          assert.equal(contract.question_revision, ownerContext.question_revision);
          assert.equal((await f.agent(run.id, "consume", { revision: contract.question_revision, worker_id: worker.id })).status, 200);
          f.workers.get(worker.id)!.condition = "ready";
        }
        const fresh = await until(detail, d => d.automatic_review[0]?.condition === "published" && d.automatic_review[0].context_revision === ownerContext.question_revision && d.human_reviews[0]?.condition === "ready");
        const refreshed = fresh.automatic_review[0];
        assert((refreshed.generation ?? 0) > (original.automatic_review[0].generation ?? 0));
        assert.notEqual(refreshed.check_id, original.automatic_review[0].check_id);
        assert.equal(refreshed.evidence_ids.length, 2);
        assert(refreshed.evidence_ids.every((id: string) => !originalEvidence.has(id)));
        assert.equal(fresh.human_reviews[0].head, candidate.head);
        assert.equal(fresh.human_reviews[0].snapshot_id, candidate.snapshot_id);
        assert.equal(fresh.pull_requests[0].number, original.pull_requests[0].number);
        assert.equal(fresh.pull_requests[0].head, original.pull_requests[0].head);
        assert.equal(f.mergeEffects.length, 0, "Fresh evidence and an owner answer alone never authorize merge");
        if (priorBody) {
          const replay = await f.api(`${prefix}/human-review/approve`, priorBody);
          assert([200, 409].includes(replay.status));
          assert.equal((await detail()).human_review_approvals.find((receipt: { id: string }) => receipt.id === prior!.id).condition, "blocked");
          assert.equal(f.mergeEffects.length, 0, "Replaying the old approval cannot authorize the changed owner context");
        }
        if (variant !== "answered_pending") {
          await navigation.getByRole("button", { name: "Human Review", exact: true }).click();
          await page.reload();
        }
        if (variant === "answered_comments") {
          const draft = (await detail()).comments.find((comment: { id: string }) => comment.id === draftId);
          assert.equal(draft.snapshot_id, candidate.snapshot_id); assert.equal(draft.status, "draft");
          await review.getByRole("region", { name: "Draft comments", exact: true }).getByText(draft.content, { exact: true }).waitFor();
          const response = page.waitForResponse(response => response.url().endsWith(`${prefix}/human-review/submit`) && response.request().method() === "POST");
          await review.getByRole("button", { name: "Approve with comments", exact: true }).click();
          const approved = await response; assert.equal(approved.status(), 202);
          const batch = await approved.json(); assert.equal(batch.merge_authorized, true);
          assert.equal(batch.snapshot_id, candidate.snapshot_id);
          for (const role of ["implementer", "standards", "spec"]) {
            const repairing = await until(detail, d => d.workers.some((worker: { role: string; condition: string }) => worker.role === role && worker.condition === "working"));
            const worker = repairing.workers.find((worker: { role: string; condition: string }) => worker.role === role && worker.condition === "working");
            const contract = await f.agent(run.id, "contract").then(response => response.json());
            assert.equal(contract.question_revision, ownerContext.question_revision);
            assert.equal((await f.agent(run.id, "consume", { revision: contract.question_revision, worker_id: worker.id })).status, 200);
            f.workers.get(worker.id)!.condition = "ready";
          }
        } else {
          const response = page.waitForResponse(response => response.url().endsWith(`${prefix}/human-review/approve`) && response.request().method() === "POST");
          await approve.click();
          const approved = await response; assert.equal(approved.status(), 200);
          assert.equal((await approved.json()).context_revision, ownerContext.question_revision);
        }
        await review.getByText("Merge verified", { exact: true }).waitFor();
        const done = await until(detail, d => d.implementation.stage === "done");
        assert.equal(done.human_review_approvals.length, prior ? 2 : 1);
        assert.equal(done.human_review_approvals.at(-1).context_revision, ownerContext.question_revision);
        assert.equal(done.human_review_approvals.at(-1).condition, "merged");
        if (prior) assert.equal(done.human_review_approvals[0].condition, "blocked");
        assert.equal(f.mergeEffects.length, 1);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
      } finally { await context.close(); f.close(); }
    }
    for (const scenario of ["scope_question", "frozen_release", "merge", "release", "stale", "failing", "protected", "denied", "lost", "offline", "pending"] as const) {
      const f = await capacityFixture({ advancingHeads: true });
      f.setTranscript({ source_id: "owned-delivery-history", version: "one", cursor: null, turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: "Retained implementation delivery history." }] }] });
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
      try {
        if (scenario === "merge") f.reviewFiles([
          { path: "progress.ts", status: "branch:M", diff: "@@ -1 +1 @@\n-before\n+after\n", binary: false, oversized: false },
          { path: "logo.bin", status: "branch:A", diff: "", binary: true, oversized: false },
        ]);
        const { id, detail, run } = await published(f, scenario === "release" || scenario === "frozen_release" ? "release" : "merge");
        await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
        if (scenario === "frozen_release") {
          const frozen = await detail();
          assert.equal(frozen.implementation.delivery_scope.milestone, "release");
          assert.equal((await f.api(`/projects/${frozen.implementation.project_id}/configure`, { delivery_policy: "merge" })).status, 200);
          assert.equal((await f.api("").then(response => response.json())).projects.find((project: { id: string }) => project.id === frozen.implementation.project_id).delivery_policy, "merge");
          assert.equal((await detail()).implementation.delivery_scope.milestone, "release", "Future Project policy preserves the Assignment's frozen release requirement");
        }
        let scopeQuestion: { id: string; answer: string | null } | null = null;
        if (scenario === "scope_question") {
          const response = await f.api(`/implementations/${id}/questions`, { run_id: run.id, question: "Should this review add another external delivery target?" });
          assert(response.ok);
          scopeQuestion = await response.json();
          assert.equal(scopeQuestion!.answer, null);
        }
        const occupied = await f.assignment("Occupied approval capacity");
        const occupiedRun = await f.api(`/implementations/${occupied}/runs`, { action: "work", idempotency_key: "occupy" }).then(r => r.json());
        if (scenario === "failing") { f.failNextCheck(); assert.equal((await f.api(`/runs/${run.id}/checks`, {}).then(r => r.json())).condition, "failed"); }
        if (scenario === "stale") f.changeHead(run.id, "f".repeat(40));
        if (scenario === "protected") f.mergeFailure("merge_blocked");
        if (scenario === "denied") f.mergeFailure("merge_denied");
        if (scenario === "lost") f.loseNextMerge();
        if (scenario === "pending") f.mergeFailure("merge_waiting");
        const origin = `http://localhost:${f.app.port}`;
        assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${origin}/#factory/${id}`);
        await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
        const review = page.getByRole("region", { name: "Human Review", exact: true });
        await review.getByText("Approval merges this checked and independently reviewed candidate into its authorized target.", { exact: true }).waitFor();
        const approve = review.getByRole("button", { name: "Approve and merge", exact: true });
        assert(await approve.isEnabled());
        if (scenario === "merge") {
          await review.getByRole("button", { name: "After 1", exact: true }).click();
          const lineDraft = review.getByRole("textbox", { name: "Review finding", exact: true });
          await lineDraft.fill("Unfinished line feedback"); assert(await approve.isDisabled());
          await review.getByRole("button", { name: "logo.bin · branch:A", exact: true }).click();
          assert(await approve.isDisabled());
          await review.getByRole("button", { name: "progress.ts · branch:M", exact: true }).click();
          assert.equal(await lineDraft.inputValue(), "Unfinished line feedback");
          await review.getByRole("button", { name: "Save draft finding", exact: true }).click();
          await review.getByRole("region", { name: "Draft comments", exact: true }).getByText("Unfinished line feedback", { exact: true }).waitFor();
          await page.reload();
          await review.getByRole("region", { name: "Draft comments", exact: true }).getByText("Unfinished line feedback", { exact: true }).waitFor();
          assert(await approve.isDisabled());
          await review.getByRole("button", { name: "Remove draft", exact: true }).click();
          await review.getByText("Finish your draft comments before approving without comments.", { exact: true }).waitFor({ state: "hidden" });
          assert(await approve.isEnabled());
          const draft = review.getByRole("textbox", { name: "Discuss this review", exact: true });
          await draft.fill("Unfinished review feedback"); assert(await approve.isDisabled()); await draft.fill("");
        }
        assert.equal(await page.getByRole("button", { name: "Accept reviewed head", exact: true }).count(), 0);
        const approvalResponse = scenario === "scope_question" ? page.waitForResponse(response => response.url().endsWith(`/implementations/${id}/human-review/approve`) && response.request().method() === "POST") : null;
        if (scenario === "frozen_release") {
          // The owned fictional Machine emulates an older merge-only response; durable connection scope stays frozen.
          const nativeProject = (f.runs.get(run.id)!.manifest as { project: { delivery_policy: string } }).project;
          const nativeMilestone = nativeProject.delivery_policy;
          const approved = page.waitForResponse(response => response.url().endsWith(`/implementations/${id}/human-review/approve`) && response.request().method() === "POST");
          nativeProject.delivery_policy = "merge";
          try {
            await approve.click();
            assert.equal((await approved).status(), 200);
            assert.equal(f.mergeEffects.length, 1, "The old Machine's merge-only receipt precedes restoring its native manifest");
          } finally { nativeProject.delivery_policy = nativeMilestone; }
        } else {
          if (scenario === "offline") f.offline(true);
          const approved = scenario === "lost" || scenario === "offline" ? page.waitForResponse(response => response.url().endsWith(`/implementations/${id}/human-review/approve`) && response.request().method() === "POST") : null;
          await approve.click();
          if (approved) {
            const response = await approved;
            assert.equal(response.status(), 200);
            const uncertain = await response.json();
            assert.equal(uncertain.condition, "uncertain");
            // Keep the fictional Machine unresolved while observing the retained error and reload.
            if (scenario === "lost") f.offline(true);
            assert(uncertain.reason);
            console.log(JSON.stringify({ viewport: viewport.width, scenario, condition: uncertain.condition, reason: uncertain.reason }));
            await review.getByRole("alert").filter({ hasText: uncertain.reason }).waitFor();
            assert.equal(await review.getByRole("status").filter({ hasText: uncertain.reason }).count(), 0);
            await page.reload();
            await review.getByRole("alert").filter({ hasText: uncertain.reason }).waitFor();
            const retained = await detail();
            assert.equal(retained.human_review_approvals.length, 1);
            assert.equal(retained.human_review_approvals[0].id, uncertain.id);
            assert.notEqual(retained.implementation.stage, "done");
            assert.equal(f.mergeEffects.length, scenario === "lost" ? 1 : 0);
            f.mergeFailure(null); f.offline(false);
            await review.getByText("Merge verified", { exact: true }).waitFor();
            assert.equal((await detail()).human_review_approvals[0].id, uncertain.id, "Recovery observes the retained approval without another click");
          }
        }
        if (scenario === "scope_question") {
          const blockedResponse = await approvalResponse!;
          assert.equal(blockedResponse.status(), 409, "An unanswered scope question must block approval before authority is retained");
          const blocked = await blockedResponse.json();
          assert.match(blocked.error.message, /question|scope|context/i);
          await page.getByRole("alert").filter({ hasText: blocked.error.message }).waitFor();
          const retained = await detail();
          assert.equal(retained.questions.find((q: { id: string }) => q.id === scopeQuestion!.id).answer, null);
          assert.equal(retained.human_review_approvals.length, 0);
          assert.notEqual(retained.implementation.stage, "done");
          assert.equal(f.mergeEffects.length, 0);
        } else if (scenario === "failing") {
          await page.getByText("Retain passing configured checks and independent Standards and Spec reports for this candidate", { exact: true }).waitFor();
          assert.notEqual((await detail()).implementation.stage, "done"); assert.equal(f.mergeEffects.length, 0);
        } else if (["protected", "denied", "stale"].includes(scenario)) {
          const reason = scenario === "protected" ? "GitHub protection, pending reviews, required checks or conflicts block this target" : scenario === "denied" ? "GitHub refused this merge under its repository permissions, protection or conflict rules; inspect the PR before further action" : "The checked workspace changed after Human Review capture";
          await review.getByRole("alert").filter({ hasText: reason }).waitFor();
          assert.notEqual((await detail()).implementation.stage, "done");
          assert.equal(f.mergeEffects.length, 0);
        } else if (scenario === "pending") {
          const waiting = await until(detail, d => d.human_review_approvals?.[0]?.condition === "pending" && !!d.human_review_approvals[0].reason);
          assert.equal(waiting.human_review_approvals.length, 1);
          assert.equal(f.mergeEffects.length, 0);
          assert(waiting.human_review_approvals[0].reason);
          await review.getByRole("status").filter({ hasText: waiting.human_review_approvals[0].reason }).waitFor();
          assert.equal(await review.getByRole("alert").count(), 0);
          await page.reload();
          f.mergeFailure(null);
          await review.getByText("Merge verified", { exact: true }).waitFor();
          assert.equal((await detail()).implementation.stage, "done");
        } else if (scenario === "release" || scenario === "frozen_release") {
          const waiting = await detail();
          assert.equal(waiting.implementation.stage, "review", "A merge receipt cannot complete a release-required Assignment");
          const releaseWait = scenario === "frozen_release" ? "Merge verified; waiting for the Assignment's required containing release" : "Merge verified; waiting for a published release containing it";
          await review.getByRole("status").filter({ hasText: releaseWait }).waitFor();
          assert.equal(await review.getByRole("alert").filter({ hasText: releaseWait }).count(), 0);
          assert.equal(waiting.human_review_approvals.length, 1);
          assert.equal(waiting.human_review_approvals[0].condition, "awaiting_release");
          assert.notEqual(waiting.runs.find((candidate: { id: string }) => candidate.id === run.id).condition, "completed");
          assert.equal(await page.getByRole("button", { name: "Archive task", exact: true }).count(), 0);
          const approvalId = waiting.human_review_approvals[0].id;
          f.releaseMerged();
          await review.getByText("Release verified", { exact: true }).waitFor({ timeout: 45000 });
          const released = await detail();
          assert.equal(released.implementation.stage, "done");
          assert.equal(released.implementation.outcome, "released");
          assert.equal(released.human_review_approvals.length, 1);
          assert.equal(released.human_review_approvals[0].id, approvalId, "A later valid release completes under the retained approval without another click");
          assert.equal(released.human_review_approvals[0].release_tag, "fixture-release");
        } else {
          await review.getByText("Merge verified", { exact: true }).waitFor();
          assert.equal((await detail()).implementation.stage, "done");
        }
        if (scenario === "merge") {
          assert.equal((await detail()).runs.find((r: any) => r.id === run.id).condition, "completed");
          await page.getByRole("button", { name: "Archive task", exact: true }).click();
          await page.getByRole("button", { name: "Restore", exact: true }).click();
          assert.equal((await detail()).implementation.archived_at, null);
          f.runs.get(occupiedRun.id)!.condition = "ready";
          await review.getByRole("textbox", { name: "Discuss this review", exact: true }).fill("Explain the delivered change");
          await review.getByRole("button", { name: "Send discussion", exact: true }).click();
          const discussed = await until(detail, d => d.human_review_deliveries?.[0]?.condition === "sent");
          assert.equal(discussed.implementation.stage, "done");
          assert.equal(discussed.human_review_approvals[0].condition, "merged");
          assert.equal(discussed.runs.find((r: any) => r.id === run.id).condition, "completed");
          const assistant = discussed.human_reviews[0].assistant_run_id;
          f.setTranscript({ source_id: "owned-delivered-explanation", version: "one", cursor: null, turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: "The delivered change retains truthful progress." }] }] });
          f.runs.get(assistant)!.condition = "ready";
          await until(detail, d => d.native_snapshots.some((s: any) => s.run_id === assistant && s.source_id === "owned-delivered-explanation"));
          await page.reload();
          await review.getByText("The delivered change retains truthful progress.", { exact: true }).waitFor();
          assert.equal((await detail()).implementation.stage, "done");
        }
        await page.reload();
        assert.equal((await detail()).human_review_approvals.length, scenario === "failing" || scenario === "scope_question" ? 0 : 1);
        if (["merge", "lost", "offline", "release", "frozen_release", "pending"].includes(scenario)) assert.equal(f.mergeEffects.length, 1);
        assert.equal(f.launches.length, scenario === "merge" ? 3 : 2);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
      } finally { await context.close(); f.close(); }
    }
  }
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) await containingReleaseJourney(browser, viewport);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) await contextSendJourney(browser, viewport);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) { await postmergeHistoryJourney(browser, viewport); await postmergeQuestionReleaseJourney(browser, viewport); }
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) await releasePagesJourney(browser, viewport);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) for (const scenario of ["independent-context", "deleted-release"] as const) await releaseScopeJourney(browser, viewport, scenario);
  console.log("PASS Human Review merge authority, stale/protected/denied targets, lost replies, retained CI waits, frozen release authority despite newer Project/old Machine policy, release completion, delivery archive and postdelivery discussion on desktop/mobile");
} finally { await browser.close(); }
}
