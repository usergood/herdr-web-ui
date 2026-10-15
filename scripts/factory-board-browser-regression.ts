/** Real board, authenticated disposable state and unpaid Machine evidence. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { boardRepair, boardScenario } from "./factory-board-fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const f = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    const gate = f.holdNextCheck(); let check: Promise<Response> | undefined;
    try {
      const { id, run, worker, graph } = await boardScenario(f);
      const finished = await f.assignment("Finished research");
      const finishedRun = await f.api(`/implementations/${finished}/runs`, { action: "work", idempotency_key: "finished" }).then(r => r.json());
      f.runs.get(finishedRun.id)!.workspace_id = "owned-finished";
      f.runs.get(finishedRun.id)!.pane_id = "owned-finished:p1";
      assert.equal((await f.api(`/runs/${finishedRun.id}/reconcile`, {})).status, 200);
      assert.equal((await f.api(`/implementations/${finished}/complete-work`, { run_id: finishedRun.id })).status, 200);
      const failed = await f.assignment("Failed work needs you");
      const failedRun = await f.api(`/implementations/${failed}/runs`, { action: "work", idempotency_key: "failed" }).then(r => r.json());
      f.runs.get(failedRun.id)!.condition = "failed";
      f.runs.get(failedRun.id)!.waiting_reason = "Owned compiler failed";
      await f.api(`/runs/${failedRun.id}/reconcile`, {});
      const interview = await f.assignment("Specification interview");
      assert.equal((await f.api(`/implementations/${interview}/runs`, { action: "grill-with-docs", idempotency_key: "interview" })).status, 202);
      await f.assignment("Unstarted idea");
      await f.api("/settings", { max_agents: 2 });
      const queued = await f.assignment("Queued for capacity");
      await f.api(`/implementations/${queued}/runs`, { action: "work", idempotency_key: "queued" });
      check = f.api(`/runs/${run.id}/checks`, {}); await gate.started;
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#assignments`);
      await page.getByRole("heading", { name: "Assignments", exact: true }).waitFor();
      assert.deepEqual(await page.locator(".factory-lane h2").allTextContents(), ["Inbox", "Queued", "Running", "Needs you", "Done"]);
      const card = page.getByRole("article", { name: "Named child progress", exact: true });
      await card.getByText("Implementing", { exact: true }).waitFor();
      await card.getByText("Testing", { exact: true }).waitFor();
      await card.getByRole("list", { name: "Active Tickets", exact: true }).getByText("Transport progress", { exact: true }).waitFor();
      await card.getByText("1 waiting · 1 running · 0 completed", { exact: true }).waitFor();
      await page.getByRole("article", { name: "Specification interview", exact: true }).getByText("Specifying", { exact: true }).waitFor();
      assert.equal(await page.locator(".factory-card[draggable=true]").count(), 0);
      assert.equal(await page.getByRole("button", { name: /Move earlier|Move later/ }).count(), 0);
      const summary = card.getByText("All Tickets (2)", { exact: true });
      await summary.focus(); await page.keyboard.press("Enter");
      await card.getByText("Waiting for dependencies: Transport progress", { exact: true }).waitFor();
      await page.getByRole("region", { name: "Inbox", exact: true }).getByRole("button", { name: "Unstarted idea", exact: true }).waitFor();
      await page.getByRole("region", { name: "Queued", exact: true }).getByRole("button", { name: "Queued for capacity", exact: true }).waitFor();
      await page.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: "Finished research", exact: true }).waitFor();
      await page.getByRole("region", { name: "Needs you", exact: true }).getByRole("button", { name: "Failed work needs you", exact: true }).waitFor();
      gate.release(); await check;
      await f.api(`/runs/${run.id}/workers/${worker.id}/refresh`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/check`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/integrate`, {});
      await page.getByRole("button", { name: "Refresh factory", exact: true }).click();
      await card.getByText("1 waiting · 0 running · 1 completed", { exact: true }).waitFor();
      assert.equal(await card.locator("details[open]").count(), 1);
      await f.api("/settings", { max_agents: 6 });
      const reviewer = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "board-standards" }).then(r => r.json());
      await page.getByRole("button", { name: "Refresh factory", exact: true }).click();
      await card.getByText("Auto-Review", { exact: true }).waitFor();
      await f.api(`/runs/${run.id}/workers/${reviewer.id}/stop`, {});
      await boardRepair(f, id, run.id, graph.tickets[0].id);
      await page.getByRole("button", { name: "Refresh factory", exact: true }).click();
      await card.getByText("Fixing", { exact: true }).waitFor();
      f.offline(true);
      const pause = await f.api(`/implementations/${id}/pause`, {}).then(r => r.json());
      await page.reload();
      await card.getByText("Pause pending", { exact: true }).waitFor();
      await card.getByText(pause.pause.reasons[0], { exact: true }).first().waitFor();
      f.offline(false);
      await page.getByRole("button", { name: "Refresh factory", exact: true }).click();
      await card.getByText("Paused", { exact: true }).waitFor();
      assert.equal(await card.locator(".factory-activity").count(), 0);
      await summary.focus(); await page.keyboard.press("Enter");
      await card.getByText("Assignment is paused", { exact: true }).first().waitFor();
      assert.equal(await page.locator(".factory-card").count(), 6);
      assert.deepEqual(errors, []);
    } finally { gate.release(); await check; await context.close(); f.close(); }
  }
  console.log("PASS named Ticket progress, all activity tags, five populated lanes, keyboard expansion and pending/verified Pause on desktop/mobile");
} finally { await browser.close(); }
