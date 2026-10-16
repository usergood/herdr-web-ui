/** Specification acceptance to repaired, checked PR through the desktop/mobile client. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const f = await capacityFixture({ advancingHeads: true, workerTranscript: (worker, before) => ({ source_id: `owned-browser-history:${worker.id}`, version: "fixture-v1", cursor: before ? null : "earlier", turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: `${before ? "Earlier" : "Final"} ${worker.role} reasoning for ${worker.id}` }] }] }) });
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Checked PR result"); const prefix = `/implementations/${id}`;
      const detail = () => f.api(prefix).then(r => r.json());
      const until = async (ready: (d: any) => boolean) => {
        const deadline = Date.now() + 15000;
        for (;;) { const d = await detail(); if (ready(d)) return d; if (Date.now() > deadline) throw new Error(`Review stalled: ${JSON.stringify(d.automatic_review)}`); await Bun.sleep(20); }
      };
      await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixtures only", pull_request: { repository: "fictional/project", base_branch: "main" } });
      await f.api(`${prefix}/specifications`, { content: "Keep the owner's draft on reload" });
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#factory/${id}`);
      await page.getByRole("region", { name: "Specifications", exact: true }).getByRole("button", { name: "Accept specification", exact: true }).click();
      const run = (await until(d => d.runs.length === 1)).runs[0];
      const specification = (await detail()).specifications[0];
      assert.equal((await f.agent(run.id, "tickets", { specification_id: specification.id, testing_plan: "Public HTTP and desktop/mobile browser journeys", tickets: [{ key: "one", title: "Retain the draft", acceptance: "Draft survives reload", dependencies: [] }] })).status, 201);
      f.runs.get(run.id)!.condition = "ready";
      const worker = (await until(d => d.workers.some((w: any) => w.role === "implementer" && w.condition === "working"))).workers[0];
      f.workers.get(worker.id)!.condition = "ready";
      const review = page.getByRole("region", { name: "Automatic review and PR", exact: true });
      await review.waitFor();
      const standards = (await until(d => d.workers.some((w: any) => w.role === "standards" && w.condition === "working"))).workers.find((w: any) => w.role === "standards");
      f.reviewOutcomes.set(standards.id, "failed"); f.workers.get(standards.id)!.condition = "ready";
      const spec = (await until(d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"))).workers.find((w: any) => w.role === "spec");
      f.workers.get(spec.id)!.condition = "ready";
      const repair = (await until(d => d.workers.some((w: any) => w.rework_batch_id && w.condition === "working"))).workers.find((w: any) => w.rework_batch_id);
      await review.getByText("Fixing", { exact: true }).waitFor();
      await review.getByRole("group").filter({ hasText: "failed" }).locator("summary").click();
      await review.locator("pre").filter({ hasText: "The accepted result loses the owner's draft on reload" }).waitFor();
      await page.reload(); await review.getByText("Fixing", { exact: true }).waitFor();
      f.workers.get(repair.id)!.condition = "ready";
      for (const axis of ["standards", "spec"]) {
        const next = (await until(d => d.workers.filter((w: any) => w.role === axis).length === 2 && d.workers.some((w: any) => w.role === axis && w.condition === "working"))).workers.filter((w: any) => w.role === axis).at(-1);
        f.workers.get(next.id)!.condition = "ready";
      }
      await review.getByText("PR published", { exact: true }).waitFor();
      assert.equal(await review.getByRole("link", { name: "Open PR", exact: true }).getAttribute("href"), "https://github.com/fictional/project/pull/27");
      const done = await detail(); const pr = done.pull_requests[0];
      assert.equal(done.checks.find((c: any) => c.id === pr.check_id).head, pr.head);
      assert(done.review_evidence.filter((r: any) => pr.evidence_ids.includes(r.id)).every((r: any) => r.head === pr.head));
      assert(await page.getByRole("region", { name: "Automatic execution", exact: true }).locator("summary").filter({ hasText: pr.head.slice(0, 12) }).count() >= 3);
      assert.equal(done.implementation.outcome, "pr_open"); assert.equal(done.approvals.length, 1);
      await page.reload(); await review.getByText("PR published", { exact: true }).waitFor();
      const history = page.getByRole("region", { name: "Workflow conversations", exact: true });
      const tree = history.getByRole("navigation", { name: "Workflow history", exact: true });
      for (const entry of [
        { label: "Implementation: Retain the draft", workers: done.workers.filter((w: any) => w.role === "implementer" && !w.rework_batch_id) },
        { label: "Standards", workers: done.workers.filter((w: any) => w.role === "standards") },
        { label: "Spec", workers: done.workers.filter((w: any) => w.role === "spec") },
        { label: "Review-fixes", workers: done.workers.filter((w: any) => w.rework_batch_id) },
      ]) {
        await tree.getByRole("button", { name: entry.label, exact: true }).click();
        for (const worker of entry.workers) {
          assert(f.closedWorkers.has(worker.id));
          for (const age of ["Earlier", "Final"]) await history.getByText(`${age} ${worker.role} reasoning for ${worker.id}`, { exact: true }).waitFor();
        }
        assert.equal(await history.getByText("Native history has not been retained.", { exact: true }).count(), 0);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  console.log("PASS approval, independent reviews, retained findings, repair and checked PR on desktop/mobile");
} finally { await browser.close(); }
