/** Retrying Machine faults keep alert semantics independently of queue eligibility. */
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { until } from "./factory-human-review-fixture.ts";

export async function checkQueuedMachineErrors(browser: Browser): Promise<void> {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const fixture = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await fixture.api("/settings", { max_agents: 1 });
      const holderId = await fixture.assignment("Occupied healthy capacity");
      const holder = await fixture.api(`/implementations/${holderId}/runs`, { action: "work", idempotency_key: "holder" }).then(response => response.json());
      const id = await fixture.assignment("Retrying owned Machine connection");
      const origin = `http://localhost:${fixture.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: fixture.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/#factory/${id}`);
      const start = page.getByRole("button", { name: "Start work", exact: true });
      await until(() => start.isEnabled(), enabled => enabled);
      fixture.offline(true);
      const submitted = page.waitForResponse(response => response.url().endsWith(`/implementations/${id}/runs`) && response.request().method() === "POST");
      await start.click();
      const response = await submitted; assert.equal(response.status(), 202);
      const wait = await response.json(); assert.equal(wait.condition, "queued");
      const capacity = page.getByRole("region", { name: "Factory capacity", exact: true });
      const row = capacity.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Retrying owned Machine connection", exact: true }) });
      const reason = row.getByText(wait.reason, { exact: true });
      await reason.waitFor();
      assert.equal(await reason.getAttribute("role"), "alert", "Retrying Machine failures are alerts even while queued");
      assert.equal(wait.reason_is_error, true);
      const board = page.locator(".factory-detail > .factory-section").first().locator(".factory-board-status");
      await board.getByRole("alert").filter({ hasText: wait.reason }).waitFor();
      await page.reload();
      await reason.waitFor(); assert.equal(await reason.getAttribute("role"), "alert");
      const retained = await fixture.api(`/implementations/${id}?view=current`).then(r => r.json());
      assert.equal(retained.capacity_waiting.find((entry: { id: string }) => entry.id === wait.id).reason_is_error, true);
      fixture.offline(false);
      const ordinary = await until(() => fixture.api("").then(r => r.json()), value => value.capacity.waiting.some((entry: { id: string; reason_is_error?: boolean }) => entry.id === wait.id && entry.reason_is_error === false));
      const ordinaryWait = ordinary.capacity.waiting.find((entry: { id: string }) => entry.id === wait.id);
      assert.equal(ordinaryWait.created_at, wait.created_at);
      await row.getByRole("status").filter({ hasText: ordinaryWait.reason }).waitFor();
      assert.equal(await row.getByRole("alert").count(), 0, "A healthy capacity wait clears the retained Machine fault");
      await board.getByRole("status").filter({ hasText: ordinaryWait.reason }).waitFor();
      await fixture.api(`/runs/${holder.id}/stop`, {});
      await until(() => fixture.api(`/implementations/${id}`).then(r => r.json()), value => value.runs.some((run: { condition: string }) => run.condition === "working"));
      await row.waitFor({ state: "detached" });
      assert.equal(fixture.launches.length, 2);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}px queued Machine fault alert, reload, ordinary capacity recovery and automatic dispatch`);
    } finally { await context.close(); fixture.close(); }
  }
}
