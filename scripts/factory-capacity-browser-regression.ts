/** Authenticated desktop/touch journeys with owned public Machine HTTP fixtures. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const fixture = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await fixture.api("/settings", { max_agents: 1, max_builds: 2 });
      const workId = await fixture.assignment("Occupied implementation", "codex", "owned-a");
      const work = await fixture.api(`/implementations/${workId}/runs`, { action: "work", idempotency_key: "work" }).then(r => r.json());
      const waitingId = await fixture.assignment("Waiting work", "opencode", "owned-c");
      const origin = `http://localhost:${fixture.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: fixture.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#factory/${waitingId}`);
      const start = page.getByRole("button", { name: "Start work", exact: true });
      const submitted = page.waitForResponse(r => r.url().endsWith(`/implementations/${waitingId}/runs`) && r.request().method() === "POST");
      await start.click(); assert.equal((await submitted).status(), 202);
      const capacity = page.getByRole("region", { name: "Factory capacity", exact: true });
      await capacity.getByRole("link", { name: "Waiting work", exact: true }).waitFor();
      await capacity.getByRole("listitem").filter({ hasText: "Waiting for agent capacity" }).waitFor();
      await page.getByText("Queued work starts automatically when capacity is available.", { exact: true }).waitFor();
      assert.equal(await start.isDisabled(), true);
      await page.reload();
      await page.getByText("Queued work starts automatically when capacity is available.", { exact: true }).waitFor();
      await fixture.api(`/runs/${work.id}/stop`, {});
      await capacity.getByRole("link", { name: "Waiting work", exact: true }).waitFor({ state: "detached" });
      await capacity.getByText("Waiting work", { exact: true }).waitFor();
      await capacity.getByText("Agent contexts: 1/1", { exact: true }).waitFor();
      assert.match(await capacity.innerText(), /working/);
      assert.equal(fixture.launches.length, 2);
      assert.deepEqual(errors, []);
    } finally { await context.close(); fixture.close(); }
  }
  console.log("PASS automatic queued-to-running dispatch and reload on desktop/mobile");
} finally { await browser.close(); }
