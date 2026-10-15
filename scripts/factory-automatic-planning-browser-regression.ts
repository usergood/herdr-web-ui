/** Specification acceptance to inspectable planning, through the real desktop/mobile client. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const source of ["button", "owner_chat"]) {
      const f = await capacityFixture();
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
      try {
        await f.api("/settings", { max_agents: 1 });
        const occupied = await f.assignment("Existing work");
        const holder = await f.api(`/implementations/${occupied}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
        const id = await f.assignment("Approve and plan"); const prefix = `/implementations/${id}`;
        const detail = () => f.api(prefix).then(r => r.json());
        await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Edit owned files" });
        const spec = await f.api(`${prefix}/specifications`, { content: "The accepted result uses public HTTP and browser validation." }).then(r => r.json());
        const origin = `http://localhost:${f.app.port}`;
        assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
        const page = await context.newPage(); page.setDefaultTimeout(10_000);
        const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
        await page.goto(`${origin}/#factory/${id}`);
        const history = page.getByRole("region", { name: "Specifications", exact: true });
        if (source === "button") await history.getByRole("button", { name: "Accept specification", exact: true }).click();
        else {
          await history.getByRole("textbox", { name: "Specification reply", exact: true }).fill("accepted");
          await history.getByRole("button", { name: "Send reply", exact: true }).click();
        }
        await history.getByText("Specification accepted", { exact: true }).waitFor();
        const steps = page.getByRole("region", { name: "Next step", exact: true });
        assert.equal(await steps.getByRole("button", { name: "Confirm testing seams", exact: true }).count(), 0);
        await page.getByText("Queued work starts automatically when capacity is available.", { exact: true }).first().waitFor();
        await page.getByText("Advanced controls", { exact: true }).first().click();
        assert.equal(await page.getByRole("button", { name: "Plan tickets", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Propose Tickets", exact: true }).count(), 0);
        await page.reload();
        await f.api(`/runs/${holder.id}/stop`, {});
        await page.waitForFunction(async prefix => { const d = await fetch(`/api/factory${prefix}`).then(r => r.json()); return d.runs.some((r: { action: string }) => r.action === "implement-spec"); }, prefix);
        let run;
        const deadline = Date.now() + 10_000;
        while (!run) {
          const value = await detail();
          run = value.runs.find((r: { action: string; condition: string }) => r.action === "implement-spec" && r.condition === "working");
          if (Date.now() > deadline) throw new Error(`Planning did not launch: ${JSON.stringify(value.automatic_planning)}`);
          if (!run) await Bun.sleep(20);
        }
        const response = await f.agent(run.id, "tickets", { specification_id: spec.id, testing_plan: "Validate public HTTP with disposable state and desktop/mobile controls.", tickets: [
          { key: "first", title: "Build the accepted result", acceptance: "Public API serves the accepted result", dependencies: [] },
          { key: "next", title: "Validate the accepted result", acceptance: "Browser validation passes", dependencies: ["first"] },
        ] });
        assert.equal(response.status, 201);
        await steps.getByText("Build the accepted result", { exact: true }).waitFor();
        await steps.getByText("Validate public HTTP with disposable state and desktop/mobile controls.", { exact: true }).waitFor();
        assert.equal(await steps.getByRole("button", { name: "Approve Ticket graph", exact: true }).count(), 0);
        assert.equal(await steps.getByRole("button", { name: "Continue workflow", exact: true }).count(), 0);
        await page.reload();
        await steps.getByText("Build the accepted result", { exact: true }).waitFor();
        assert.equal((await detail()).approvals.length, 1);
        assert.equal((await detail()).frontier[0].title, "Build the accepted result");
        assert.equal(f.launches.length, 2);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
      } finally { await context.close(); f.close(); }
    }
  }
  console.log("PASS button/chat acceptance, queued planning, inspectable plan and reload on desktop/mobile at cap one");
} finally { await browser.close(); }
