/** Waiting conversations through the real client, on owned Machine HTTP fixtures. */
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
      const id = await f.assignment("Retained conversation");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "waiting" }).then(r => r.json());
      await f.api(`/implementations/${id}/questions`, { run_id: run.id, question: "Which owned result?" });
      f.runs.get(run.id)!.condition = "ready";
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#factory/${id}`);
      const capacity = page.getByRole("region", { name: "Factory capacity", exact: true });
      const conversations = capacity.getByRole("region", { name: "Waiting conversations", exact: true });
      await conversations.getByText("Execution capacity released", { exact: true }).waitFor();
      await capacity.getByText("Agent contexts: 0/1", { exact: true }).waitFor();
      const other = await f.assignment("Other executing work");
      const holder = await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      await page.getByRole("textbox", { name: "Your answer", exact: true }).fill("The retained approved scope");
      const sent = page.waitForResponse(r => r.url().endsWith(`/runs/${run.id}/send-answers`));
      await page.getByRole("button", { name: "Save answer", exact: true }).click();
      assert.equal((await (await sent).json()).condition, "queued");
      await conversations.getByText("Waiting to resume", { exact: true }).waitFor();
      assert.equal(await page.getByRole("alert").filter({ hasText: "Delivery was not confirmed" }).count(), 0);
      await page.reload();
      await page.getByText("The retained approved scope", { exact: true }).waitFor();
      await conversations.getByText("Waiting to resume", { exact: true }).waitFor();
      await f.api(`/runs/${holder.id}/stop`, {});
      await conversations.waitFor({ state: "detached" });
      await capacity.getByText("Agent contexts: 1/1", { exact: true }).waitFor();
      assert.equal(f.prompts.length, 1);
      assert.equal(f.prompts[0]!.run_id, run.id);
      assert.equal(f.launches.length, 2);
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  console.log("PASS safely parked owner questions, queued answers, reload and same-conversation resumption on desktop/mobile");
} finally { await browser.close(); }
