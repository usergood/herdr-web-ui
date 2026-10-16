/** Specification acceptance to inspectable planning, through the real desktop/mobile client. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import type { FactoryDetail } from "../shared/factory.ts";

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
        const controls = page.getByRole("region", { name: "Assignment execution", exact: true });
        if (source === "owner_chat") {
          await controls.getByRole("button", { name: "Pause Assignment", exact: true }).click();
          await controls.getByText("Paused", { exact: true }).waitFor();
        }
        const history = page.getByRole("region", { name: "Specifications", exact: true });
        if (source === "button") await history.getByRole("button", { name: "Accept specification", exact: true }).click();
        else {
          await history.getByRole("textbox", { name: "Specification reply", exact: true }).fill("accepted");
          await history.getByRole("button", { name: "Send reply", exact: true }).click();
        }
        await history.getByText("Specification accepted", { exact: true }).waitFor();
        const steps = page.getByRole("region", { name: "Next step", exact: true });
        assert.equal(await steps.getByRole("button", { name: "Confirm testing seams", exact: true }).count(), 0);
        if (source === "button") {
          await page.getByText("Queued work starts automatically when capacity is available.", { exact: true }).first().waitFor();
          await controls.getByRole("button", { name: "Pause Assignment", exact: true }).click();
          await controls.getByText("Paused", { exact: true }).waitFor();
        }
        await page.getByText("Advanced controls", { exact: true }).first().click();
        assert.equal(await page.getByRole("button", { name: "Plan tickets", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Propose Tickets", exact: true }).count(), 0);
        await page.reload();
        f.restart();
        const resumedOrigin = `http://localhost:${f.app.port}`;
        assert.equal((await context.request.post(`${resumedOrigin}/api/auth`, { data: { token: f.token } })).status(), 204);
        await page.goto(`${resumedOrigin}/#factory/${id}`);
        await controls.getByText("Paused", { exact: true }).waitFor();
        await f.api(`/runs/${holder.id}/stop`, {});
        const pausedDeadline = Date.now() + 700;
        do {
          const paused = await detail();
          assert(["pending", "queued"].includes(paused.automatic_planning[0].condition));
          assert.equal(paused.runs.length, 0);
          assert.equal(f.launches.length, 1);
          await Bun.sleep(20);
        } while (Date.now() < pausedDeadline);
        await controls.getByRole("button", { name: "Resume Assignment", exact: true }).click();
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
        if (source === "button") {
          assert.deepEqual(run.manifest.tickets, []);
          f.setTranscript({ source_id: "original-orchestrator-decisions", version: "v1", cursor: null, turns: [{ role: "assistant", ts: "2026-01-01T00:00:00Z", parts: [{ kind: "text", text: "Retained decisions for the original accepted plan" }] }] });
          assert.equal((await f.api(`/runs/${run.id}/import-conversation`, {})).status, 200);
          f.runs.get(run.id)!.condition = "ready";
          const waitForDetail = async (ready: (value: FactoryDetail) => boolean) => {
            const deadline = Date.now() + 10_000;
            for (;;) {
              const value: FactoryDetail = await detail();
              if (ready(value)) return value;
              if (Date.now() > deadline) throw new Error(`Retained Ticket history did not progress: ${JSON.stringify({ workers: value.workers, execution: value.automatic_execution })}`);
              await Bun.sleep(20);
            }
          };
          const running = await waitForDetail(d => d.workers.some(w => w.role === "implementer" && w.condition === "working" && f.workers.has(w.id)));
          const worker = running.workers.find(w => w.role === "implementer")!;
          f.workers.get(worker.id)!.condition = "ready";
          await waitForDetail(d => d.workers.find(w => w.id === worker.id)?.condition === "completed");
          assert.equal((await f.api(`${prefix}/pause`, {})).status, 200);
          const before = (await detail()).conversations.find((c: { kind: string }) => c.kind === "implementation");
          const revision = await f.api(`${prefix}/specifications`, { content: "A later Specification must preserve the earlier execution history." }).then(r => r.json());
          assert.deepEqual((await detail()).tickets, []);
          await page.reload();
          const panel = page.getByRole("region", { name: "Workflow conversations", exact: true });
          const selectTicket = async () => {
            await panel.getByRole("navigation", { name: "Workflow history", exact: true }).getByRole("button", { name: "Implementation: Build the accepted result", exact: true }).click();
            const retained = panel.getByRole("region", { name: "Implementation: Build the accepted result", exact: true });
            await retained.getByText("Native context", { exact: true }).click();
            await retained.getByText(`${run.id} · ${worker.id}`, { exact: true }).waitFor();
            assert.deepEqual((await detail()).conversations.find((c: { id: string }) => c.id === before.id), before);
          };
          await selectTicket();
          await panel.getByRole("button", { name: "Specifications", exact: true }).click();
          await history.getByText(revision.content, { exact: true }).waitFor();
          await history.getByRole("button", { name: "Accept specification", exact: true }).click();
          await history.getByText("Specification accepted", { exact: true }).waitFor();
          await panel.getByRole("button", { name: "Orchestrator", exact: true }).click();
          await panel.getByText("Retained decisions for the original accepted plan", { exact: true }).waitFor();
          f.restart();
          const restarted = `http://localhost:${f.app.port}`;
          assert.equal((await context.request.post(`${restarted}/api/auth`, { data: { token: f.token } })).status(), 204);
          await page.goto(`${restarted}/#factory/${id}`);
          await selectTicket();
        }

        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
      } finally { await context.close(); f.close(); }
    }
  }
  console.log("PASS button/chat acceptance while Paused or queued, restart and automatic Resume, retained Ticket names and execution history across later drafts, acceptance and restart on desktop/mobile at cap one");
} finally { await browser.close(); }
