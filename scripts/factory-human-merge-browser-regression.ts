/** Explicit merge authority and truthful delivery through the desktop/mobile Human Review. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { published, until } from "./factory-human-review-fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const scenario of ["merge", "release", "stale", "failing", "protected", "denied", "lost"] as const) {
      const f = await capacityFixture({ advancingHeads: true });
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
      try {
        const { id, detail, run } = await published(f, scenario === "release" ? "release" : "merge");
        await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
        const occupied = await f.assignment("Occupied approval capacity");
        await f.api(`/implementations/${occupied}/runs`, { action: "work", idempotency_key: "occupy" });
        if (scenario === "failing") { f.failNextCheck(); assert.equal((await f.api(`/runs/${run.id}/checks`, {}).then(r => r.json())).condition, "failed"); }
        if (scenario === "stale") f.changeHead(run.id, "f".repeat(40));
        if (scenario === "protected") f.mergeFailure("merge_blocked");
        if (scenario === "denied") f.mergeFailure("merge_denied");
        if (scenario === "lost") f.loseNextMerge();
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
          await review.getByText(reason, { exact: true }).waitFor();
          assert.notEqual((await detail()).implementation.stage, "done");
          assert.equal(f.mergeEffects.length, 0);
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
        await page.reload();
        assert.equal((await detail()).human_review_approvals.length, scenario === "failing" ? 0 : 1);
        if (["merge", "lost", "release"].includes(scenario)) assert.equal(f.mergeEffects.length, 1);
        assert.equal(f.launches.length, 2);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
      } finally { await context.close(); f.close(); }
    }
  }
  console.log("PASS Human Review merge authority, stale/protected/denied targets, lost replies and release completion on desktop/mobile");
} finally { await browser.close(); }
