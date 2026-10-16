/** Approve saved comments, validate fresh repairs and merge without another owner approval. */
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
      await review.getByRole("button", { name: "After 1", exact: true }).click();
      await review.getByRole("textbox", { name: "Review finding", exact: true }).fill("Keep progress through reload");
      await review.getByRole("button", { name: "Save draft finding", exact: true }).click();
      await review.getByRole("region", { name: "Draft comments", exact: true }).getByText("Keep progress through reload", { exact: true }).waitFor();
      await page.reload();
      const approve = review.getByRole("button", { name: "Approve with comments", exact: true });
      await review.getByText("Approval submits all saved comments for repair, then merges after passing checks and independent reviews. No further approval is required.", { exact: true }).waitFor();
      await review.getByRole("button", { name: "Edit draft", exact: true }).click();
      await review.getByRole("textbox", { name: "Review finding", exact: true }).fill("Unsaved edited feedback");
      assert(await approve.isDisabled(), "Unsaved edits must be saved or cancelled before approval");
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      await review.getByRole("textbox", { name: "Discuss this review", exact: true }).fill("Unsaved feedback");
      assert(await approve.isDisabled());
      await review.getByRole("textbox", { name: "Discuss this review", exact: true }).fill("");
      await approve.click();
      await review.getByText("Approved fixes are running. Merge follows passing checks and independent reviews.", { exact: true }).waitFor();
      const fixing = await until(detail, d => d.workers.some((w: any) => w.review_origin === "human" && w.condition === "working"));
      f.workers.get(fixing.workers.find((w: any) => w.review_origin === "human" && w.condition === "working").id)!.condition = "ready";
      for (const axis of ["standards", "spec"]) {
        const d = await until(detail, d => d.workers.some((w: any) => w.role === axis && w.condition === "working"));
        assert.equal(f.mergeEffects.length, 0);
        f.workers.get(d.workers.find((w: any) => w.role === axis && w.condition === "working").id)!.condition = "ready";
      }
      await review.getByText("Merge verified", { exact: true }).waitFor();
      await page.reload();
      await review.getByText("Merge verified", { exact: true }).waitFor();
      const result = await detail();
      assert.equal(result.human_review_approvals.length, 1);
      assert.equal(result.human_review_approvals[0].head, result.human_feedback_batches[0].resolution.head);
      assert.equal(result.implementation.outcome, "merged"); assert.equal(f.mergeEffects.length, 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  console.log("PASS Approve with comments repairs, reviews and merges without reapproval on desktop/mobile");
} finally { await browser.close(); }
