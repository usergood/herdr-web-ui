/** Accepted plan to named worker/check progress through the real desktop/mobile client. */
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
      const id = await f.assignment("Automatic result"); const prefix = `/implementations/${id}`;
      const detail = () => f.api(prefix).then(r => r.json());
      await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixtures only" });
      await f.api(`${prefix}/specifications`, { content: "Implement the accepted result" });
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#factory/${id}`);
      await page.getByRole("region", { name: "Specifications", exact: true }).getByRole("button", { name: "Accept specification", exact: true }).click();
      let run;
      const deadline = Date.now() + 10000;
      while (!run) {
        const observed = await detail(); run = observed.runs.find((r: { condition: string }) => r.condition === "working");
        if (Date.now() > deadline) throw new Error(`Orchestrator did not start: ${JSON.stringify(observed.automatic_planning)}`);
        if (!run) await Bun.sleep(20);
      }
      const spec = (await detail()).specifications[0];
      assert.equal((await f.agent(run.id, "tickets", { specification_id: spec.id, testing_plan: "Public API and desktop/mobile browser journeys", tickets: [
        { key: "one", title: "Implement the accepted result", acceptance: "Return the accepted behavior", dependencies: [] },
      ] })).status, 201);
      f.runs.get(run.id)!.condition = "ready";
      const progress = page.getByRole("region", { name: "Automatic execution", exact: true });
      await progress.getByText("Implement the accepted result", { exact: true }).waitFor();
      assert.equal(await progress.getByRole("button", { name: "Start Ticket worker", exact: true }).count(), 0);
      await page.waitForFunction(async prefix => (await fetch(`/api/factory${prefix}`).then(r => r.json())).workers.some((w: { condition: string }) => w.condition === "working"), prefix);
      const worker = (await detail()).workers[0];
      const controls = page.getByRole("region", { name: "Assignment execution", exact: true });
      await controls.getByRole("button", { name: "Pause Assignment", exact: true }).click();
      await controls.getByText("Paused", { exact: true }).waitFor();
      await progress.getByText("Paused", { exact: true }).first().waitFor();
      await controls.getByRole("button", { name: "Resume Assignment", exact: true }).click();
      const resumeDeadline = Date.now() + 10000;
      for (;;) {
        const current = (await detail()).workers.find((w: { id: string }) => w.id === worker.id);
        if (!current.suspension && current.condition === "working") break;
        if (Date.now() > resumeDeadline) throw new Error("The retained Ticket did not resume");
        await Bun.sleep(20);
      }
      f.workers.get(worker.id)!.condition = "needs_you";
      f.workers.get(worker.id)!.waiting_reason = "Owned native permission required";
      await progress.getByText("Owned native permission required", { exact: true }).first().waitFor();
      f.workers.get(worker.id)!.condition = "ready";
      f.workers.get(worker.id)!.waiting_reason = null;
      await progress.getByText("checked", { exact: true }).waitFor();
      const checks = progress.locator("details").filter({ has: page.locator("summary", { hasText: "Checks" }) });
      assert.equal(await checks.count(), 2);
      await checks.first().locator("summary").click();
      await checks.first().getByText("Owned checks passed", { exact: true }).waitFor();
      await page.reload();
      await progress.getByText("checked", { exact: true }).waitFor();
      await progress.getByText("Implement the accepted result", { exact: true }).waitFor();
      assert.equal((await detail()).workers.filter((w: { role: string }) => w.role === "implementer").length, 1);
      assert.equal((await detail()).approvals.length, 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  console.log("PASS automatic execution, named workers, native gate, checks and reload on desktop/mobile at cap one");
} finally { await browser.close(); }
