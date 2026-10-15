import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { reviewReworkFixture } from "../server/factory-review-rework.fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const width of [1440, 390]) {
    for (const outcome of ["sent", "uncertain", "stale"] as const) {
      const f = await reviewReworkFixture();
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(15_000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      try {
        if (outcome === "uncertain") f.uncertainDelivery(true);
        await page.goto(f.origin() + `/#factory/${f.run.implementation_id}`);
        const review = page.locator("section").filter({ has: page.getByRole("heading", { name: "Review changes", exact: true }) }).last();
        const standards = review.getByRole("checkbox", { name: /^standards · failed/ });
        const spec = review.getByRole("checkbox", { name: /^spec · failed/ });
        await standards.waitFor();
        assert.equal(await review.getByRole("checkbox").count(), 2);
        const send = review.getByRole("button", { name: "Request changes", exact: true });
        assert(await send.isDisabled());
        await standards.focus(); await page.keyboard.press("Space"); await spec.check();
        assert(await send.isEnabled());
        if (outcome === "stale") f.commit(f.run.worktree!, "Changed after report selection\n");
        const response = page.waitForResponse(response => response.url().endsWith("/request-changes"));
        await send.click(); const received = await response;
        assert.equal(received.status(), outcome === "stale" ? 409 : 200);
        if (outcome === "stale") {
          await page.getByRole("alert").filter({ hasText: "reviewed head changed" }).waitFor();
          assert.equal(f.deliveries.length, 0);
        } else {
          const receipt = await received.json(); assert.equal(receipt.status, outcome);
          await page.reload(); await standards.waitFor();
          assert(await standards.isDisabled()); assert(await spec.isDisabled());
          await review.getByText(`${receipt.id} · ${outcome}`, { exact: true }).first().waitFor();
          assert.equal(f.deliveries.length, 1);
          for (const report of f.reports) assert(f.deliveries[0]!.includes(report.id));
          const retained = (await f.agentContract(f.run.id)).review_batches.find((batch: { id: string }) => batch.id === receipt.id);
          assert.deepEqual(retained.reports, receipt.reports);
          await page.getByText("Advanced controls", { exact: true }).click();
          const repair = page.getByRole("button", { name: new RegExp(`^Start rework worker · ${receipt.id}`) });
          if (outcome === "sent") {
            await repair.waitFor();
            const started = page.waitForResponse(response => response.url().endsWith(`/runs/${f.run.id}/workers`) && response.request().method() === "POST");
            await repair.click(); assert.equal((await started).status(), 200);
          } else assert.equal(await repair.count(), 0);
        }
        assert(await review.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
        assert.deepEqual(errors, []);
      } finally { await page.close(); f.close(); }
    }
  }
  console.log("Report rework: desktop/phone selection, keyboard send, exact-head rejection, reload receipts and one repair writer");
} finally { await browser.close(); }
