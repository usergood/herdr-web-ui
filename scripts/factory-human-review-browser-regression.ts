/** Human Review is usable without an agent slot on desktop and mobile. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { releaseBrowserFixture } from "./factory-release-browser-fixture.ts";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { published, until } from "./factory-human-review-fixture.ts";

export async function forcedColorLineJourney(browser: Browser, viewport: { width: number; height: number }) {
  const f = await releaseBrowserFixture({ milestone: "merge", forcedDiffColors: true,
    baselineContent: "unchanged header\nold first\nold second\nunchanged footer\n",
    candidateContent: "unchanged header\nnew first\nnew second\nunchanged footer\n" });
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
  try {
    assert.equal(f.core.git(["config", "--get", "color.ui"]), "always"); assert.equal(f.core.git(["config", "--get", "color.diff"]), "always");
    const origin = `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
    const before = await f.detail(); assert.equal(before.human_review_approvals.length, 0); assert.equal(before.comments.length, 0);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/#factory/${f.id}`);
    await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
    const review = page.getByRole("region", { name: "Human Review", exact: true });
    await review.getByRole("button", { name: "result.txt · branch:M", exact: true }).click();
    await review.getByRole("status").filter({ hasText: "Review the captured result and discuss it with the assistant." }).waitFor();
    assert.equal(await review.getByRole("alert").count(), 0);
    assert.equal(await review.getByRole("button", { name: "Approve and merge", exact: true }).isDisabled(), false);
    const file = f.snapshot.files.find((entry: { path: string }) => entry.path === "result.txt"); assert(file);
    const apiBody = { snapshot_id: f.snapshot.id, path: "result.txt", change: "branch:M", side: "old", line_start: 2, line_end: 3, content: "HTTP old range under forced Git colors" };
    const saved = await context.request.post(`${origin}${f.prefix}/comments`, { data: apiBody, headers: { origin, "x-herdr-factory": "1" } });
    const apiComment = await saved.json();
    console.log(JSON.stringify({ viewport: viewport.width, forced_colors: { ansi_in_capture: file.diff.includes("\u001b["), old_buttons: await review.getByRole("button", { name: "Before 2", exact: true }).count(), new_buttons: await review.getByRole("button", { name: "After 2", exact: true }).count(), comment_status: saved.status(), comment: apiComment } }));
    assert.equal(saved.status(), 201, "A real forced-color Git capture must support its valid old-side range anchor");
    assert.equal(file.diff.includes("\u001b["), false, "Capture must retain plain patch data despite forced Git colors");
    assert.match(file.diff, /^@@ -1,4 \+1,4 @@/m); assert(file.diff.includes("-old first\n-old second\n+new first\n+new second\n"));
    assert.equal(apiComment.snapshot_id, f.snapshot.id); assert.equal(apiComment.context, file.diff);
    const expected: [string, "old" | "new", number, number][] = [[apiBody.content, "old", 2, 3]];
    const drafts = review.getByRole("region", { name: "Draft comments", exact: true });
    for (const [side, label] of [["old", "Before"], ["new", "After"]] as const) {
      for (const range of [false, true]) {
        const first = review.getByRole("button", { name: `${label} 2`, exact: true });
        if (viewport.width < 640) await first.tap(); else { await first.focus(); await first.press("Enter"); }
        if (range) {
          await review.getByRole("button", { name: "Select range end", exact: true }).click();
          const last = review.getByRole("button", { name: `${label} 3`, exact: true });
          if (viewport.width < 640) await last.tap(); else { await last.focus(); await last.press("Enter"); }
        }
        const end = range ? 3 : 2; const content = `${label} ${range ? "range" : "line"} under forced Git colors`;
        await review.getByRole("status").filter({ hasText: `result.txt · ${label} 2–${end}` }).waitFor();
        await review.getByRole("textbox", { name: "Review finding", exact: true }).fill(content);
        const response = page.waitForResponse(response => response.url().endsWith(`${f.prefix}/comments`) && response.request().method() === "POST");
        await review.getByRole("button", { name: "Save draft finding", exact: true }).click();
        const posted = await response; const comment = await posted.json(); assert.equal(posted.status(), 201, JSON.stringify(comment));
        assert.deepEqual(posted.request().postDataJSON(), { snapshot_id: f.snapshot.id, path: "result.txt", change: "branch:M", side, line_start: 2, line_end: end, content });
        await drafts.getByText(content, { exact: true }).waitFor(); expected.push([content, side, 2, end]);
      }
    }
    await page.reload();
    for (const [content] of expected) await drafts.getByText(content, { exact: true }).waitFor();
    const retained = await f.detail();
    assert.deepEqual(retained.comments.map((comment: { content: string; side: string; line_start: number; line_end: number }) => [comment.content, comment.side, comment.line_start, comment.line_end]), expected);
    for (const comment of retained.comments) { assert.equal(comment.snapshot_id, f.snapshot.id); assert.equal(comment.path, "result.txt"); assert.equal(comment.change, "branch:M"); assert.equal(comment.context, file.diff); assert.equal(comment.status, "draft"); assert.equal(comment.batch_id, null); }
    assert.equal(retained.human_reviews[0].snapshot_id, f.snapshot.id); assert.equal(retained.human_reviews[0].head, f.core.head);
    assert.equal(retained.human_review_approvals.length, 0); assert.equal(f.mergeRequests.length, 0); assert.equal(retained.workers.length, 0);
    assert.equal(f.core.calls().filter(args => args[1]?.endsWith("/merge")).length, 0);
    assert(await review.getByRole("button", { name: "Approve and merge", exact: true }).isDisabled(), "Saved findings grant no merge authority");
    assert.equal(await review.getByRole("alert").count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
    console.log(`PASS real forced-color capture preserves old/new single-line and range drafts through public API/UI and reload (${viewport.width})`);
  } finally { await context.close(); await f.close(); }
}

/** A resting observation cannot release an unresolved Human Review discussion send. */
export async function discussionOwnershipJourney(browser: Browser, viewport: { width: number; height: number }, lost: boolean) {
  const f = await capacityFixture({ advancingHeads: true });
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
  let gate: ReturnType<typeof f.holdNextSend> | undefined;
  try {
    const { id, prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const origin = () => `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin()}/api/auth`, { data: { token: f.token } })).status(), 204);
    let page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const open = async () => {
      await page.goto(`${origin()}/#factory/${id}`);
      await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
    };
    await open();
    const send = async (content: string) => {
      const review = page.getByRole("region", { name: "Human Review", exact: true });
      await review.getByRole("textbox", { name: "Discuss this review", exact: true }).fill(content);
      const response = page.waitForResponse(response => response.url().endsWith(`${prefix}/human-review/messages`) && response.request().method() === "POST");
      await review.getByRole("button", { name: "Send discussion", exact: true }).click();
      const saved = await response; assert.equal(saved.status(), 202);
      return { message: await saved.json(), body: saved.request().postDataJSON() };
    };
    const first = await send("Explain this captured result without editing");
    const started = await until(detail, d => d.runs.some((run: any) => run.conversation_kind === "human_review" && run.condition === "working") && d.human_review_deliveries.some((entry: any) => entry.id === first.message.id && entry.condition === "sent"));
    const assistant = started.runs.find((run: any) => run.conversation_kind === "human_review");
    f.runs.get(assistant.id)!.condition = "ready";
    assert.equal((await f.api(`/runs/${assistant.id}/reconcile`, {})).status, 200);
    const parked = await detail(); const oldContinuation = parked.runs.find((run: any) => run.id === assistant.id).continuation;
    assert.equal(oldContinuation.condition, "parked");
    assert.deepEqual((await f.api("").then(response => response.json())).capacity.normal, { limit: 1, used: 0 });
    const otherId = await f.assignment("Waiting behind owned discussion"); const otherPrefix = `/implementations/${otherId}`;
    const otherDetail = () => f.api(otherPrefix).then(response => response.json());
    const other = await otherDetail();
    await f.api(`/projects/${other.implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixtures only" });
    const specification = await f.api(`${otherPrefix}/specifications`, { content: "Begin only when normal capacity is genuinely free" }).then(response => response.json());
    const oldLaunches = [...f.launches]; const oldWorkers = [...f.workerLaunches];
    gate = f.holdNextSend(); let entered = false; void gate.started.then(() => { entered = true; });
    if (lost) f.loseNextSend();
    const second = await send("Retain this second discussion exactly once");
    await until(async () => entered, value => value);
    f.runs.get(assistant.id)!.condition = "ready";
    assert.equal((await f.api(`/runs/${assistant.id}/reconcile`, {})).status, 200);
    const held = await detail(); const heldRun = held.runs.find((run: any) => run.id === assistant.id);
    const heldCapacity = (await f.api("").then(response => response.json())).capacity;
    assert.equal((await f.api(`${otherPrefix}/specification-acceptance`, { source: "button", specification_id: specification.id, hash: specification.hash })).status, 201);
    console.log(JSON.stringify({ viewport: viewport.width, lost_ack: lost, held_discussion: { run_id: heldRun.id, condition: heldRun.condition, continuation: heldRun.continuation, delivery: held.human_review_deliveries.find((entry: any) => entry.id === second.message.id), capacity: heldCapacity, launches: f.launches, prompts: f.prompts } }));
    if (!lost) f.runs.get(assistant.id)!.condition = "working";
    gate.release();
    let observed;
    if (lost) {
      await until(detail, d => d.human_review_deliveries.some((entry: any) => entry.id === second.message.id && entry.condition === "uncertain"));
      await page.close(); f.restart();
      assert.equal((await f.api(`/runs/${assistant.id}/reconcile`, {})).status, 200);
      observed = await detail();
      const waiting = await until(otherDetail, d => d.capacity_waiting.length > 0 || d.runs.length > 0);
      const capacity = (await f.api("").then(response => response.json())).capacity;
      const retained = observed.runs.find((run: any) => run.id === assistant.id);
      console.log(JSON.stringify({ viewport: viewport.width, lost_discussion_after_restart: { run_id: retained.id, condition: retained.condition, continuation: retained.continuation, delivery: observed.human_review_deliveries.find((entry: any) => entry.id === second.message.id), capacity, other_runs: waiting.runs.map((run: any) => ({ id: run.id, condition: run.condition })), launches: f.launches, prompts: f.prompts } }));
      assert.equal(retained.continuation.condition, "uncertain", "A pre-ACK resting observation cannot settle a lost discussion send");
      assert.equal(retained.continuation.id, oldContinuation.id); assert.equal(retained.continuation.kind, "children");
      assert.deepEqual(capacity.normal, { limit: 1, used: 1 }); assert(capacity.contexts.some((entry: any) => entry.id === assistant.id && entry.uncertain));
      assert.equal(waiting.runs.length, 0); assert.deepEqual(f.launches, oldLaunches); assert.deepEqual(f.workerLaunches, oldWorkers);
      assert.equal((await f.api(`${prefix}/human-review/messages`, second.body)).status, 202);
      assert.equal((await detail()).messages.filter((entry: any) => entry.id === second.message.id).length, 1);
      assert.equal((await context.request.post(`${origin()}/api/auth`, { data: { token: f.token } })).status(), 204);
      page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message));
      await open(); const reason = observed.human_review_deliveries.find((entry: any) => entry.id === second.message.id).reason;
      const review = page.getByRole("region", { name: "Human Review", exact: true });
      await review.getByRole("alert").filter({ hasText: reason }).waitFor();
      await page.getByRole("region", { name: "Factory capacity", exact: true }).getByText("Agent contexts: 1/1", { exact: true }).waitFor();
      await page.reload(); await review.getByRole("alert").filter({ hasText: reason }).waitFor();
    } else {
      const acknowledged = await until(detail, d => d.human_review_deliveries.some((entry: any) => entry.id === second.message.id && entry.condition === "sent"));
      assert.equal(acknowledged.human_review_deliveries.find((entry: any) => entry.id === second.message.id).reason, null);
      const ackQueue = await until(otherDetail, d => d.capacity_waiting.length > 0 || d.runs.length > 0);
      const ackCapacity = (await f.api("").then(response => response.json())).capacity;
      console.log(JSON.stringify({ viewport: viewport.width, acknowledged_working_discussion: { run: acknowledged.runs.find((run: any) => run.id === assistant.id), delivery: acknowledged.human_review_deliveries.find((entry: any) => entry.id === second.message.id), capacity: ackCapacity, other_runs: ackQueue.runs.map((run: any) => ({ id: run.id, condition: run.condition })), native_condition: f.runs.get(assistant.id)!.condition } }));
      assert.equal(f.runs.get(assistant.id)!.condition, "working");
      assert(ackCapacity.contexts.some((entry: any) => entry.id === assistant.id), "The old pre-ACK ready observation cannot release the newly executing discussion turn");
      assert.deepEqual(ackCapacity.normal, { limit: 1, used: 1 }); assert.equal(ackQueue.runs.length, 0); assert.deepEqual(f.launches, oldLaunches);
      f.runs.get(assistant.id)!.condition = "ready";
      assert.equal((await f.api(`/runs/${assistant.id}/reconcile`, {})).status, 200);
      observed = await detail(); const resting = observed.runs.find((run: any) => run.id === assistant.id);
      const admitted = await until(otherDetail, d => d.runs.length === 1);
      console.log(JSON.stringify({ viewport: viewport.width, confirmed_discussion: { run_id: resting.id, condition: resting.condition, continuation: resting.continuation, delivery: observed.human_review_deliveries.find((entry: any) => entry.id === second.message.id), admitted_run: admitted.runs[0].id, launches: f.launches, prompts: f.prompts } }));
      assert.equal(resting.continuation.condition, "parked"); assert.equal(resting.continuation.id, oldContinuation.id);
      assert.equal(f.launches.length, oldLaunches.length + 1); assert.deepEqual(f.workerLaunches, oldWorkers);
      await page.reload(); await page.getByRole("region", { name: "Human Review", exact: true }).getByText(second.message.content, { exact: true }).waitFor();
    }
    assert.equal(heldRun.continuation.condition, "sending", "Human Review must retain an unresolved native-send claim across a resting observation");
    assert.equal(heldRun.continuation.id, oldContinuation.id); assert.deepEqual(heldCapacity.normal, { limit: 1, used: 1 }); assert(heldCapacity.contexts.some((entry: any) => entry.id === assistant.id));
    assert.equal(held.human_review_deliveries.find((entry: any) => entry.id === second.message.id).condition, "sending");
    assert.deepEqual(observed.human_reviews, started.human_reviews); assert.deepEqual(observed.pull_requests, ready.pull_requests); assert.deepEqual(observed.review_evidence, ready.review_evidence); assert.deepEqual(observed.checks, ready.checks); assert.deepEqual(observed.approvals, ready.approvals);
    assert.equal(observed.human_review_approvals.length, 0); assert.equal(f.mergeEffects.length, 0); assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].run_id, assistant.id); assert(f.prompts[0].text.includes(second.message.content));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
    console.log(`PASS Human Review ${lost ? "lost" : "confirmed"} discussion ACK retains capacity until settlement/rest, stable scope and one delivery (${viewport.width})`);
  } finally { gate?.release(); await context.close(); f.close(); }
}

if (import.meta.main) {
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const handoff of ["snapshot", "machine", "rest"] as const) {
      const f = await capacityFixture({ advancingHeads: true });
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
      const publication = f.holdNextPublication();
      try {
        const candidate = published(f);
        await publication.started;
        if (handoff === "rest") f.runs.get(f.launches[0]!)!.condition = "working";
        else f.reviewUnavailable(true);
        publication.release();
        const { id, detail, run } = await candidate;
        let waiting = await until(detail, d => d.human_reviews?.[0]?.condition === "waiting");
        if (handoff === "machine") {
          f.reviewUnavailable(false); f.offline(true);
          waiting = await until(detail, d => d.runs.find((entry: { id: string }) => entry.id === run.id)?.condition === "disconnected" && d.human_reviews[0]?.condition === "waiting");
        }
        const retained = waiting.human_reviews[0];
        assert(retained.reason);
        assert.equal(retained.snapshot_id, null);
        assert.equal(waiting.human_review_approvals.length, 0);
        let origin = `http://localhost:${f.app.port}`;
        assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        const openReview = async () => {
          await page.goto(`${origin}/#factory/${id}`);
          await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
        };
        await openReview();
        const review = page.getByRole("region", { name: "Human Review", exact: true });
        const role = handoff === "rest" ? "status" : "alert";
        await review.getByText(retained.reason, { exact: true }).waitFor();
        await review.getByRole(role).filter({ hasText: retained.reason }).waitFor();
        assert.equal(await review.getByRole(role === "alert" ? "status" : "alert").filter({ hasText: retained.reason }).count(), 0);
        assert(await review.getByRole("button", { name: "Approve and merge", exact: true }).isDisabled());
        await page.reload();
        await review.getByRole(role).filter({ hasText: retained.reason }).waitFor();
        f.restart(); origin = `http://localhost:${f.app.port}`;
        assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
        await openReview();
        await review.getByRole(role).filter({ hasText: retained.reason }).waitFor();
        assert.equal((await detail()).human_reviews[0].id, retained.id);
        if (handoff === "rest") {
          const native = f.runs.get(run.id)!;
          native.condition = "blocked"; native.waiting_reason = "Owned native permission required";
          const blocked = await until(detail, d => d.runs.find((entry: { id: string }) => entry.id === run.id)?.condition === "blocked" && d.human_reviews[0]?.reason_is_error === true);
          assert.equal(blocked.human_reviews[0].reason, native.waiting_reason);
          await review.getByRole("alert").filter({ hasText: native.waiting_reason }).waitFor();
          assert.equal(await review.getByRole("status").filter({ hasText: native.waiting_reason }).count(), 0);
          await page.reload();
          await review.getByRole("alert").filter({ hasText: native.waiting_reason }).waitFor();
          native.condition = "needs_you";
          const permission = await until(detail, d => d.runs.find((entry: { id: string }) => entry.id === run.id)?.condition === "needs_you" && d.human_reviews[0]?.reason_is_error === false);
          assert.equal(permission.human_reviews[0].reason, native.waiting_reason);
          await review.getByRole("status").filter({ hasText: native.waiting_reason }).waitFor();
          assert.equal(await review.getByRole("alert").filter({ hasText: native.waiting_reason }).count(), 0);
          console.log(`PASS blocked handoff alert to canonical permission status with identical reason ${viewport.width}x${viewport.height}`);
        }
        f.reviewUnavailable(false); f.offline(false); Object.assign(f.runs.get(run.id)!, { condition: "ready", waiting_reason: null });
        const recovered = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
        assert.equal(recovered.human_reviews[0].id, retained.id);
        assert.equal(recovered.human_reviews[0].reason, null);
        assert.equal(recovered.human_reviews[0].reason_is_error, false);
        assert(recovered.human_reviews[0].snapshot_id);
        await review.getByRole("status").filter({ hasText: "Review the captured result and discuss it with the assistant." }).waitFor();
        assert.equal(await review.getByRole("alert").count(), 0);
        assert.equal(recovered.human_review_approvals.length, 0);
        assert.equal(f.mergeEffects.length, 0);
        assert.equal(recovered.events.filter((event: { kind: string }) => event.kind === "human_review_handoff").length, 1);
        console.log(`PASS ${handoff} handoff ${role}, retained reload/restart and recovery ${viewport.width}x${viewport.height}`);
      } finally { publication.release(); await context.close(); f.close(); }
    }
    // The owned Machine returns a different captured head from the checked PR. The public
    // handoff must retain that mismatch as blocked, and both layouts must announce the error.
    const blockedFixture = await capacityFixture({ advancingHeads: true });
    const blockedContext = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      blockedFixture.reviewHead("f".repeat(40));
      const { id, detail } = await published(blockedFixture);
      const blocked = await until(detail, d => d.human_reviews?.[0]?.condition === "blocked");
      const reason = "The captured candidate differs from the checked PR head";
      assert.equal(blocked.human_reviews[0].reason, reason);
      assert.equal(blocked.human_review_approvals.length, 0);
      const origin = `http://localhost:${blockedFixture.app.port}`;
      assert.equal((await blockedContext.request.post(`${origin}/api/auth`, { data: { token: blockedFixture.token } })).status(), 204);
      const page = await blockedContext.newPage(); page.setDefaultTimeout(10000);
      await page.goto(`${origin}/#factory/${id}`);
      await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
      const review = page.getByRole("region", { name: "Human Review", exact: true });
      await review.getByText(reason, { exact: true }).waitFor();
      await review.getByRole("alert").filter({ hasText: reason }).waitFor();
      assert.equal(await review.getByRole("status").filter({ hasText: reason }).count(), 0);
      assert(await review.getByRole("button", { name: "Approve and merge", exact: true }).isDisabled());
      console.log(`PASS blocked snapshot mismatch alert ${viewport.width}x${viewport.height}`);
    } finally { await blockedContext.close(); blockedFixture.close(); }
    const discussionFixture = await capacityFixture({ advancingHeads: true });
    const discussionContext = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      const { id, detail } = await published(discussionFixture);
      await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      discussionFixture.legacyHumanReview();
      const origin = `http://localhost:${discussionFixture.app.port}`;
      assert.equal((await discussionContext.request.post(`${origin}/api/auth`, { data: { token: discussionFixture.token } })).status(), 204);
      const page = await discussionContext.newPage(); page.setDefaultTimeout(10000);
      await page.goto(`${origin}/#factory/${id}`);
      await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
      const review = page.getByRole("region", { name: "Human Review", exact: true });
      await review.getByRole("textbox", { name: "Discuss this review", exact: true }).fill("Discuss the captured candidate without editing");
      await review.getByRole("button", { name: "Send discussion", exact: true }).click();
      const blocked = await until(detail, d => d.capacity_waiting.some((w: any) => w.id.startsWith("discussion:") && w.condition === "blocked"));
      const request = blocked.capacity_waiting.find((w: any) => w.id.startsWith("discussion:") && w.condition === "blocked");
      assert.match(request.reason, /Human Review bridge support/);
      await review.getByRole("alert").filter({ hasText: request.reason }).waitFor();
      assert.equal(await review.getByRole("status").filter({ hasText: request.reason }).count(), 0);
      await page.reload();
      await review.getByRole("alert").filter({ hasText: request.reason }).waitFor();
      assert.equal(discussionFixture.launches.length, 1);
      assert.equal(discussionFixture.prompts.length, 0);
      assert.equal((await detail()).human_review_approvals.length, 0);
      console.log(`PASS blocked discussion alert without launch or approval ${viewport.width}x${viewport.height}`);
    } finally { await discussionContext.close(); discussionFixture.close(); }
    const f = await capacityFixture({ advancingHeads: true });
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      f.reviewFiles([
        { path: "src/progress.ts", status: "branch:R090", diff: "diff --git a/src/old.ts b/src/progress.ts\nrename from src/old.ts\nrename to src/progress.ts\n@@ -1,2 +1,2 @@\n-before\n-old second\n+after\n+new second\n", binary: false, oversized: false },
        { path: "removed.txt", status: "branch:D", diff: "--- a/removed.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n", binary: false, oversized: false },
        { path: "assets/logo.bin", status: "branch:A", diff: "", binary: true, oversized: false },
        { path: "large.txt", status: "branch:M", diff: "", binary: false, oversized: true },
      ]);
      const { id, prefix, detail } = await published(f);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#factory/${id}`);
      // Use the stable workflow navigation, as the owner does.
      await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
      const review = page.getByRole("region", { name: "Human Review", exact: true });
      await review.getByRole("navigation", { name: "Changed files", exact: true }).waitFor();
      await review.getByRole("status").filter({ hasText: "Review the captured result and discuss it with the assistant." }).waitFor();
      await review.getByRole("button", { name: "src/progress.ts · branch:R090", exact: true }).click();
      await review.getByRole("region", { name: "Captured diff", exact: true }).locator("pre").filter({ hasText: "rename from src/old.ts" }).waitFor();
      await review.getByText("Review snapshot", { exact: true }).first().click();
      await review.getByText(ready.human_reviews[0].head, { exact: true }).waitFor();
      await review.getByRole("button", { name: "removed.txt · branch:D", exact: true }).click();
      await review.getByRole("region", { name: "Captured diff", exact: true }).locator("pre").filter({ hasText: "-removed" }).waitFor();
      await review.getByRole("button", { name: "assets/logo.bin · branch:A", exact: true }).click();
      await review.getByText("Binary file: a text diff is unavailable.", { exact: true }).waitFor();
      await review.getByRole("button", { name: "large.txt · branch:M", exact: true }).click();
      await review.getByText("This file exceeds the review size limit.", { exact: true }).waitFor();
      const diffBox = await review.getByRole("region", { name: "Captured diff", exact: true }).boundingBox();
      const discussionBox = await review.getByRole("region", { name: "Review discussion", exact: true }).boundingBox();
      assert(diffBox && discussionBox);
      if (viewport.width > 640) assert(discussionBox.x >= diffBox.x + diffBox.width && discussionBox.y < diffBox.y + diffBox.height, "Desktop discussion must sit beside the captured files");
      else assert(discussionBox.y >= diffBox.y + diffBox.height, "Mobile discussion must remain reachable below the captured files");
      await review.getByRole("button", { name: "src/progress.ts · branch:R090", exact: true }).click();
      const oldLine = review.getByRole("button", { name: "Before 1", exact: true });
      if (viewport.width < 640) await oldLine.tap(); else { await oldLine.focus(); await page.keyboard.press("Enter"); }
      await review.getByRole("button", { name: "Select range end", exact: true }).click();
      const oldEnd = review.getByRole("button", { name: "Before 2", exact: true });
      if (viewport.width < 640) await oldEnd.tap(); else { await oldEnd.focus(); await page.keyboard.press("Enter"); }
      await review.getByRole("textbox", { name: "Review finding", exact: true }).fill("Keep this old range documented");
      await review.getByRole("button", { name: "Save draft finding", exact: true }).click();
      const drafts = review.getByRole("region", { name: "Draft comments", exact: true });
      await drafts.getByText("Keep this old range documented", { exact: true }).waitFor();
      await review.getByRole("button", { name: "After 1", exact: true }).click();
      await review.getByRole("textbox", { name: "Review finding", exact: true }).fill("New side feedback");
      await review.getByRole("button", { name: "Save draft finding", exact: true }).click();
      await drafts.getByText("New side feedback", { exact: true }).waitFor();
      await review.getByRole("button", { name: "removed.txt · branch:D", exact: true }).click();
      await review.getByRole("button", { name: "Before 1", exact: true }).click();
      await review.getByRole("textbox", { name: "Review finding", exact: true }).fill("Deleted file feedback");
      await review.getByRole("button", { name: "Save draft finding", exact: true }).click();
      await drafts.getByText("Deleted file feedback", { exact: true }).waitFor();
      await page.reload();
      await drafts.getByText("Keep this old range documented", { exact: true }).waitFor();
      const comment = drafts.locator("article").filter({ hasText: "New side feedback" });
      await comment.getByRole("button", { name: "Edit draft", exact: true }).click();
      await comment.getByRole("textbox", { name: "Review finding", exact: true }).fill("Edited new side feedback");
      await comment.getByRole("button", { name: "Save draft finding", exact: true }).click();
      await comment.getByText("Edited new side feedback", { exact: true }).waitFor();
      await comment.getByRole("button", { name: "Remove draft", exact: true }).click();
      await page.reload();
      assert.equal(await drafts.getByText("Edited new side feedback", { exact: true }).count(), 0);
      const drafted = await detail();
      assert.deepEqual(drafted.comments.map((c: any) => [c.path, c.side, c.line_start, c.line_end]), [["src/progress.ts", "old", 1, 2], ["removed.txt", "old", 1, 1]]);
      assert.equal(drafted.workers.length, 3); assert.equal(f.prompts.length, 0);
      const other = await f.assignment("Occupied browser capacity");
      await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "occupy" });
      await review.getByRole("textbox", { name: "Discuss this review", exact: true }).fill("Explain this change");
      await review.getByRole("button", { name: "Send discussion", exact: true }).click();
      await review.getByText("Explain this change", { exact: true }).waitFor();
      await page.reload(); await review.getByText("Explain this change", { exact: true }).waitFor();
      f.runs.get(f.launches.at(-1)!)!.condition = "ready";
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review" && r.condition === "working"));
      const assistant = started.runs.find((r: any) => r.conversation_kind === "human_review");
      f.setTranscript({ source_id: "browser-review", version: "one", cursor: null, turns: [{ role: "assistant", ts: new Date().toISOString(), parts: [{ kind: "text", text: "The captured change preserves progress." }] }] });
      f.runs.get(assistant.id)!.condition = "ready";
      await review.getByText("The captured change preserves progress.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Mark work done", exact: true }).count(), 0);
      f.offline(true);
      await f.api(`/runs/${assistant.id}/reconcile`, {});
      await page.reload();
      await review.getByText("The captured change preserves progress.", { exact: true }).waitFor();
      await review.getByText("The selected Machine rejected this factory operation; verify its bridge, native tools and checkout", { exact: true }).waitFor();
      await review.getByRole("button", { name: "removed.txt · branch:D", exact: true }).click();
      await review.getByRole("region", { name: "Captured diff", exact: true }).locator("pre").filter({ hasText: "-removed" }).waitFor();
      assert.equal((await detail()).human_reviews[0].id, ready.human_reviews[0].id);
      f.offline(false); f.reviewHead("f".repeat(40));
      await f.api(`${prefix}/snapshots`, { run_id: ready.human_reviews[0].run_id, mode: "branch" });
      await page.reload();
      await drafts.getByText("Stale anchor: the candidate changed. Original lines are retained.", { exact: true }).first().waitFor();
      assert.equal(await drafts.getByText("Stale anchor: the candidate changed. Original lines are retained.", { exact: true }).count(), 2);
      assert.equal((await detail()).comments[0].snapshot_id, ready.human_reviews[0].snapshot_id);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) await forcedColorLineJourney(browser, viewport);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) for (const lost of [false, true]) await discussionOwnershipJourney(browser, viewport, lost);
  console.log("PASS Human Review captured files, discussion, capacity and retained history on desktop/mobile");
} finally { await browser.close(); }
}
