/** Explicit merge authority and truthful delivery through the desktop/mobile Human Review. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { published, until } from "./factory-human-review-fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const scenario of ["merge", "release", "stale", "failing", "protected", "denied", "lost", "pending"] as const) {
      const f = await capacityFixture({ advancingHeads: true });
      f.setTranscript({ source_id: "owned-delivery-history", version: "one", cursor: null, turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: "Retained implementation delivery history." }] }] });
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
      try {
        if (scenario === "merge") f.reviewFiles([
          { path: "progress.ts", status: "branch:M", diff: "@@ -1 +1 @@\n-before\n+after\n", binary: false, oversized: false },
          { path: "logo.bin", status: "branch:A", diff: "", binary: true, oversized: false },
        ]);
        const { id, detail, run } = await published(f, scenario === "release" ? "release" : "merge");
        await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
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
        await approve.click();
        if (scenario === "failing") {
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
          assert.equal(await review.getByRole("alert").count(), 0);
          await page.reload();
          f.mergeFailure(null);
          await review.getByText("Merge verified", { exact: true }).waitFor();
          assert.equal((await detail()).implementation.stage, "done");
        } else if (scenario === "release") {
          await review.getByText("Merge verified; waiting for a published release containing it", { exact: true }).waitFor();
          assert.equal((await detail()).implementation.stage, "review");
          f.releaseMerged();
          await review.getByText("Release verified", { exact: true }).waitFor({ timeout: 45000 });
          assert.equal((await detail()).implementation.outcome, "released");
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
        assert.equal((await detail()).human_review_approvals.length, scenario === "failing" ? 0 : 1);
        if (["merge", "lost", "release", "pending"].includes(scenario)) assert.equal(f.mergeEffects.length, 1);
        assert.equal(f.launches.length, scenario === "merge" ? 3 : 2);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
      } finally { await context.close(); f.close(); }
    }
  }
  console.log("PASS Human Review merge authority, stale/protected/denied targets, lost replies, retained CI waits, release completion, delivery archive and postdelivery discussion on desktop/mobile");
} finally { await browser.close(); }
