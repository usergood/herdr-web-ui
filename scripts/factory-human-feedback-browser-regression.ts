/** Owned Human Review decline/fix/wait-for-approval journeys. No paid agents. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { published, until } from "./factory-human-review-fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const f = await capacityFixture({ advancingHeads: true });
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      const { id, detail } = await published(f);
      await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#factory/${id}`);
      await page.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Human Review", exact: true }).click();
      const review = page.getByRole("region", { name: "Human Review", exact: true });
      for (let round = 0; round < 2; round++) {
        const before = await detail(); const previous = before.human_reviews[0];
        await review.getByRole("button", { name: "After 1", exact: true }).click();
        await review.getByRole("textbox", { name: "Review finding", exact: true }).fill(`Feedback ${round + 1}`);
        await review.getByRole("button", { name: "Save draft finding", exact: true }).click();
        await review.getByRole("region", { name: "Draft comments", exact: true }).getByText(`Feedback ${round + 1}`, { exact: true }).waitFor();
        await page.reload();
        await review.getByRole("button", { name: "Decline", exact: true }).click();
        await review.getByRole("region", { name: "Submitted comments", exact: true }).getByText(`Feedback ${round + 1}`, { exact: true }).waitFor();
        await review.getByText("Fixes are running. A later approval is required to merge.", { exact: true }).waitFor();
        assert(await review.getByRole("button", { name: "Decline", exact: true }).isDisabled());
        const fixing = await until(detail, d => d.workers.some((w: any) => w.review_origin === "human" && w.condition === "working"));
        const fix = fixing.workers.find((w: any) => w.review_origin === "human" && w.condition === "working");
        f.workers.get(fix.id)!.condition = "ready";
        for (const axis of ["standards", "spec"]) {
          const d = await until(detail, d => d.workers.some((w: any) => w.role === axis && w.condition === "working"));
          f.workers.get(d.workers.find((w: any) => w.role === axis && w.condition === "working").id)!.condition = "ready";
        }
        const returned = await until(detail, d => d.human_reviews[0].condition === "ready" && d.human_reviews[0].head !== previous.head);
        assert.equal(returned.human_reviews[0].id, previous.id);
        await review.getByText("Fixes passed checks and independent reviews. Awaiting your approval.", { exact: true }).waitFor();
        await page.reload();
        await review.getByText("Fixes passed checks and independent reviews. Awaiting your approval.", { exact: true }).waitFor();
        assert.equal(returned.human_feedback_batches.length, round + 1);
        assert(returned.human_feedback_batches.every((b: any) => b.merge_authorized === false));
        assert.equal(returned.implementation.stage, "review");
      }
      assert.equal(await review.getByRole("region", { name: "Draft comments", exact: true }).locator("article").count(), 0);
      assert.equal(await review.getByRole("region", { name: "Submitted comments", exact: true }).locator("article").count(), 2);
      await review.getByRole("button", { name: "Approve and merge", exact: true }).click();
      await review.getByText("Merge verified", { exact: true }).waitFor();
      assert.equal((await detail()).implementation.outcome, "merged");
      assert.equal(f.mergeEffects.length, 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  console.log("PASS Human Review decline, fresh repairs, return awaiting approval and explicit reapproval on desktop/mobile");
} finally { await browser.close(); }
