/** Explicit merge authority and truthful delivery through the desktop/mobile Human Review. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { published, until } from "./factory-human-review-fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
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
          const waiting = await until(detail, d => d.human_review_approvals?.[0]?.condition === "pending");
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
  console.log("PASS Human Review merge authority, stale/protected/denied targets, lost replies, retained CI waits, frozen release authority despite newer Project/old Machine policy, release completion, delivery archive and postdelivery discussion on desktop/mobile");
} finally { await browser.close(); }
