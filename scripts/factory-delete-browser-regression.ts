/** Delete controls and truthful progress through the real desktop/mobile client. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { checkGitHubDelete } from "./factory-github-delete-browser.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const f = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Failed unfinished work to delete");
      const failed = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "active" }).then(r => r.json());
      f.runs.get(failed.id)!.condition = "failed";
      await f.api(`/runs/${failed.id}/reconcile`, {});
      const holderId = await f.assignment("Unrelated capacity holder");
      const holder = await f.api(`/implementations/${holderId}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      const backup = await f.api("/backups", {}).then(r => r.json());
      const obstacle = join(f.state, "factory", "backups", backup.id, "manifest.json.tmp");
      mkdirSync(obstacle);
      assert.equal((await f.api("").then(r => r.json())).capacity.normal.used, 1);
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(12_000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/#factory/${id}`);
      const controls = page.getByRole("region", { name: "Assignment deletion", exact: true });
      await controls.getByRole("button", { name: "Delete Assignment", exact: true }).click();
      await controls.getByText(/Exported copies and external provider history/).waitFor();
      f.offline(true);
      await controls.getByRole("button", { name: "Delete all owned work", exact: true }).click();
      await controls.getByText("Delete pending", { exact: true }).waitFor();
      await controls.getByText(/owned-a/).waitFor();
      await page.reload();
      await controls.getByText("Delete pending", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Resume Assignment", exact: true }).count(), 0);
      f.offline(false);
      await controls.getByText(/backup.*rewrite destination/).waitFor();
      assert.equal((await f.api(`/implementations/${id}`)).status, 200);
      await page.reload();
      await controls.getByText("Delete pending", { exact: true }).waitFor();
      await controls.getByText(/backup.*rewrite destination/).waitFor();
      rmSync(obstacle, { recursive: true });
      await page.waitForURL(url => !url.hash.includes(id));
      await page.getByText("Failed unfinished work to delete", { exact: true }).waitFor({ state: "hidden" });
      assert.equal((await f.api(`/implementations/${id}`)).status, 404);
      assert.equal((await f.api(`/backups/${backup.id}/restore`, {})).status, 201);
      await f.api(`/runs/${holder.id}/stop`, {});
      for (const condition of ["stopped", "paused", "finished", "unfinished"]) {
        const target = await f.assignment(`Delete ${condition} work`);
        if (condition !== "unfinished") {
          const run = await f.api(`/implementations/${target}/runs`, { action: "work", idempotency_key: condition }).then(r => r.json());
          if (condition === "paused") await f.api(`/implementations/${target}/pause`, {});
          else if (condition === "finished") {
            const native = f.runs.get(run.id)!;
            native.workspace_id = `owned-finished-${run.id}`; native.pane_id = `${native.workspace_id}:p1`;
            f.researchReady(run.id);
            assert.equal((await f.api(`/runs/${run.id}/reconcile`, {})).status, 200);
            assert.equal((await f.api(`/implementations/${target}/complete-work`, { run_id: run.id })).status, 200);
          }
          else await f.api(`/runs/${run.id}/stop`, {});
        }
        const before = await f.api(`/implementations/${target}`).then(r => r.json());
        if (condition === "finished") assert.equal(before.implementation.stage, "done");
        if (condition === "paused") assert.equal(before.implementation.pause.condition, "paused");
        if (condition === "stopped") assert.equal(before.runs[0].condition, "cancelled");
        await page.goto(`${origin}/#factory/${target}`);
        await controls.getByRole("button", { name: "Delete Assignment", exact: true }).click();
        await controls.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal((await f.api(`/implementations/${target}`)).status, 200);
        await controls.getByRole("button", { name: "Delete Assignment", exact: true }).click();
        await controls.getByRole("button", { name: "Delete all owned work", exact: true }).click();
        await page.waitForURL(url => !url.hash.includes(target));
        assert.equal((await f.api(`/implementations/${target}`)).status, 404);
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  console.log("PASS desktop/mobile Delete control, Machine/backup pending reasons, interrupted rewrite, reload, recovery and final removal");
  await checkGitHubDelete(browser);
} finally { await browser.close(); }
