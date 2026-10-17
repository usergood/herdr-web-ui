/** Lifecycle controls stay usable while an owned Machine is still allocating Start. */
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import type { FactoryCurrent } from "../shared/factory.ts";
import { capacityFixture } from "./factory-capacity-fixture.ts";

export async function checkInFlightLifecycle(browser: Browser): Promise<void> {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const action of ["pause", "delete"] as const) {
      const fixture = await capacityFixture();
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
      const gate = fixture.holdNextAllocation();
      try {
        const id = await fixture.assignment(`Lifecycle during ${action} allocation`);
        const origin = `http://localhost:${fixture.app.port}`;
        assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: fixture.token } })).status(), 204);
        const page = await context.newPage(); page.setDefaultTimeout(10_000);
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${origin}/#factory/${id}`);
        const start = page.getByRole("button", { name: "Start work", exact: true });
        const startResponse = page.waitForResponse(response => response.url().endsWith(`/implementations/${id}/runs`) && response.request().method() === "POST");
        await start.click();
        let timeout: ReturnType<typeof setTimeout>;
        const runId = await Promise.race([gate.started, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Owned Machine did not receive Start")), 10_000); })]).finally(() => clearTimeout(timeout));
        const accepted = await fixture.api(`/implementations/${id}`).then(response => response.json()) as FactoryCurrent;
        assert.equal(accepted.runs.find(run => run.id === runId)?.condition, "accepted");
        const execution = page.getByRole("region", { name: "Assignment execution", exact: true });
        const deletion = page.getByRole("region", { name: "Assignment deletion", exact: true });
        assert.equal(await execution.getByRole("button", { name: "Pause Assignment", exact: true }).isEnabled(), true, "Pause must stay usable while Start waits on Machine allocation");
        assert.equal(await deletion.getByRole("button", { name: "Delete Assignment", exact: true }).isEnabled(), true, "Delete must stay usable while Start waits on Machine allocation");
        const stopped = page.waitForResponse(response => response.url().endsWith(`/implementations/${id}/${action}`) && response.request().method() === "POST");
        if (action === "pause") await execution.getByRole("button", { name: "Pause Assignment", exact: true }).click();
        else {
          await deletion.getByRole("button", { name: "Delete Assignment", exact: true }).click();
          await deletion.getByText(/Exported copies and external provider history/).waitFor();
          await deletion.getByRole("button", { name: "Delete all owned work", exact: true }).click();
        }
        const stopResponse = await stopped;
        assert.equal(stopResponse.status(), action === "pause" ? 200 : 202, "The lifecycle request reaches the public API before Start returns");
        if (action === "delete") assert.equal((await stopResponse.json()).condition, "pending", "Delete retains allocation ownership until the held reply settles");
        gate.release();
        await startResponse;
        if (action === "pause") {
          await execution.getByText("Paused", { exact: true }).waitFor();
          await page.reload();
          await execution.getByText("Paused", { exact: true }).waitFor();
          const current = await fixture.api(`/implementations/${id}`).then(response => response.json()) as FactoryCurrent;
          assert.equal(current.implementation.pause?.condition, "paused");
          assert.equal(current.runs.find(run => run.id === runId)?.suspension?.condition, "stopped");
          assert.equal(fixture.resumptions.length, 0);
        } else {
          await page.waitForURL(url => !url.hash.includes(id));
          assert.equal((await fixture.api(`/implementations/${id}`)).status, 404);
          await page.reload();
          assert.equal((await fixture.api(`/implementations/${id}`)).status, 404);
        }
        assert.deepEqual(fixture.launches, [runId], "The late Start response cannot launch replacement work");
        assert.deepEqual(errors, []);
        console.log(`PASS ${viewport.width}px ${action} during held Machine Start response`);
      } finally { gate.release(); await context.close(); fixture.close(); }
    }
  }
}
