/** Owner Pause/Resume through the real desktop/mobile client and owned Machine HTTP. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const f = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Pause all owned work");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "active" }).then(r => r.json());
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#factory/${id}`);
      const controls = page.getByRole("region", { name: "Assignment execution", exact: true });
      await controls.getByRole("button", { name: "Pause Assignment", exact: true }).waitFor();
      f.offline(true);
      await controls.getByRole("button", { name: "Pause Assignment", exact: true }).click();
      await controls.getByText("Pause pending", { exact: true }).waitFor();
      assert.equal(await controls.getByRole("button", { name: "Resume Assignment", exact: true }).isDisabled(), true);
      await controls.getByText(/owned-a/).waitFor();
      await page.reload();
      await controls.getByText("Pause pending", { exact: true }).waitFor();
      f.offline(false);
      await controls.getByText("Paused", { exact: true }).waitFor();
      await page.reload();
      await controls.getByText("Paused", { exact: true }).waitFor();
      const other = await f.assignment("Capacity during Pause");
      const holder = await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      await controls.getByRole("button", { name: "Resume Assignment", exact: true }).click();
      const capacity = page.getByRole("region", { name: "Factory capacity", exact: true });
      const queued = capacity.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Pause all owned work", exact: true }) });
      await queued.getByText(/Waiting for (capacity to continue unfinished work|agent capacity: normal 1\/1)/).waitFor();
      const waiting = await f.api(`/implementations/${id}`).then(r => r.json());
      assert(waiting.capacity_waiting.some((w: any) => w.continuation && w.run_id === run.id && w.condition === "queued"));
      assert.equal(waiting.runs[0].suspension.condition, "stopped");
      assert.equal(f.resumptions.length, 0);
      await page.reload();
      await f.api(`/runs/${holder.id}/stop`, {});
      await controls.getByRole("button", { name: "Pause Assignment", exact: true }).waitFor();
      await page.waitForFunction(async assignmentId => {
        const detail = await fetch(`/api/factory/implementations/${assignmentId}`).then(r => r.json());
        return !detail.runs[0].suspension;
      }, id);
      const detail = await f.api(`/implementations/${id}`).then(r => r.json());
      assert.equal(detail.runs[0].id, run.id); assert.equal(detail.runs[0].worktree, run.worktree);
      assert.equal(f.launches.length, 2); assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  console.log("PASS Assignment Pause pending, reconnect, reload and queued Resume on desktop/mobile");
} finally { await browser.close(); }
