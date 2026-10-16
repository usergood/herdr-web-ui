/** Human Review is usable without an agent slot on desktop and mobile. */
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
      const started = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review"));
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
  console.log("PASS Human Review captured files, discussion, capacity and retained history on desktop/mobile");
} finally { await browser.close(); }
