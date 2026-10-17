/** Specification acceptance to repaired, checked PR through the desktop/mobile client. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import type { Browser } from "playwright-core";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { machinePublicationFixture } from "../server/factory-publication.fixture.ts";

/** The UI and real Machine candidates are separate owned fixtures; only the raw error crosses their operation boundary. */
export async function publicationRoutingJourney(browser: Browser, viewport: { width: number; height: number }) {
  const machine = await machinePublicationFixture();
  let verified = false; let recovering = false;
  let release!: () => void;
  const recovered = new Promise<void>(resolve => { release = resolve; });
  const pending = new Set<Promise<Response>>();
  const failures: { status: number; body: any }[] = [];
  let retained: Response | null = null;
  const f = await capacityFixture({ advancingHeads: true, publicationFailure: async () => {
    if (verified) return null;
    if (recovering) { await recovered; return verified ? null : retained!.clone(); }
    const request = machine.post(machine.route + "publish", machine.body); pending.add(request);
    try {
      const response = await request;
      failures.push({ status: response.status, body: await response.clone().json() });
      retained = response.clone(); return response;
    } finally { pending.delete(request); }
  } });
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
  try {
    machine.rewrite(viewport.width < 640 ? "pushInsteadOf" : "insteadOf");
    await f.api("/settings", { max_agents: 1 });
    const id = await f.assignment("Scoped publication routing"); const prefix = `/implementations/${id}`;
    const detail = () => f.api(prefix).then(response => response.json());
    const until = async (ready: (d: any) => boolean) => {
      const deadline = Date.now() + 15000;
      for (;;) { const d = await detail(); if (ready(d)) return d; if (Date.now() > deadline) throw new Error(`Publication routing stalled: ${JSON.stringify(d.automatic_review)}`); await Bun.sleep(20); }
    };
    await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixtures only", pull_request: { repository: "fictional/project", base_branch: "main" } });
    const specification = await f.api(`${prefix}/specifications`, { content: "Publish only to the frozen repository without changing the approved candidate" }).then(response => response.json());
    const origin = `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/#factory/${id}`);
    await page.getByRole("region", { name: "Specifications", exact: true }).getByRole("button", { name: "Accept specification", exact: true }).click();
    const accepted = await until(d => d.runs.length === 1);
    const authority = accepted.approvals; assert.equal(authority.length, 1);
    const run = accepted.runs[0];
    assert.equal((await f.agent(run.id, "tickets", { specification_id: specification.id, testing_plan: "Public HTTP and desktop/mobile browser", tickets: [{ key: "one", title: "Publish scoped result", acceptance: "Frozen repository only", dependencies: [] }] })).status, 201);
    f.runs.get(run.id)!.condition = "ready";
    for (const role of ["implementer", "standards", "spec"]) {
      const state = await until(d => d.workers.some((worker: any) => worker.role === role && worker.condition === "working"));
      f.workers.get(state.workers.find((worker: any) => worker.role === role && worker.condition === "working").id)!.condition = "ready";
    }
    const blocked = await until(d => failures.length > 0 && d.automatic_review[0]?.reason_is_error === true);
    const progress = blocked.automatic_review[0];
    const review = page.getByRole("region", { name: "Automatic review and PR", exact: true });
    const alert = review.getByRole("alert").filter({ hasText: progress.reason }); await alert.waitFor();
    console.log(JSON.stringify({ viewport: viewport.width, composed_machine_failure: failures, central_review: progress, authority, redirected_refs: machine.redirectedRefs(), rendered_role: await alert.getAttribute("role") }));
    assert(failures.every(failure => failure.status === 409 && failure.body.error.code === "publication_routing_changed"));
    const reason = "Remove Git URL rewrite routing before scoped publication";
    assert.equal(progress.reason, reason, "The owner needs the actionable routing correction rather than a generic Machine failure");
    assert.equal(progress.condition, "waiting"); assert(progress.attempts < 6); assert(progress.next_attempt_at > 0);
    assert.equal(machine.redirectedRefs(), ""); assert.equal(f.publications.size, 0);
    assert.deepEqual(blocked.approvals, authority); assert.equal(blocked.pull_requests.length, 0);
    assert.equal(blocked.specifications[0].id, specification.id);
    for (const unsafe of [machine.root, ".gitconfig", "redirected.git", "insteadOf", "pushInsteadOf"]) assert.equal((await alert.innerText()).includes(unsafe), false);
    assert.equal(await review.getByRole("status").filter({ hasText: reason }).count(), 0);
    await page.reload(); await review.getByRole("alert").filter({ hasText: reason }).waitFor();
    assert.deepEqual((await detail()).approvals, authority); assert.equal(machine.redirectedRefs(), "");
    recovering = true; await Promise.all([...pending]);
    machine.clearRewrites();
    const sent = await machine.post(machine.route + "publish", machine.body); const uncertain = await sent.json();
    assert.equal(sent.status, 409); assert.equal(uncertain.error.code, "publication_uncertain");
    const observed = await machine.post(machine.route + "publish", machine.body); const published = await observed.json();
    assert.equal(observed.status, 200); assert.equal(published.head, machine.head); assert.equal(published.run_id, machine.id);
    assert.equal(execFileSync("git", ["--git-dir", machine.bare, "rev-parse", `refs/heads/${machine.branch}`], { encoding: "utf8" }).trim(), machine.head);
    assert.equal(machine.redirectedRefs(), "");
    const mutations = readFileSync(machine.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(mutations.filter(args => args.includes("POST")).length, 1, "Lost acknowledgment reconciles the same real host publication");
    verified = true; release();
    const done = await until(d => d.automatic_review[0]?.condition === "published");
    await review.getByText("PR published", { exact: true }).waitFor();
    assert.deepEqual(done.approvals, authority); assert.equal(done.runs.length, 1); assert.equal(done.runs[0].id, run.id);
    assert.equal(done.pull_requests.length, 1); assert.equal(done.implementation.outcome, "pr_open");
    assert.equal(done.pull_requests[0].head, progress.head); assert.equal(done.automatic_review[0].check_id, progress.check_id);
    assert.deepEqual(done.automatic_review[0].evidence_ids, progress.evidence_ids);
    assert.equal(await review.getByRole("alert").count(), 0); assert.equal(machine.redirectedRefs(), "");
    await page.reload(); await review.getByText("PR published", { exact: true }).waitFor();
    assert.deepEqual((await detail()).approvals, authority); assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log(`PASS actual host rewrite refusal propagated safely, reload and real host reconciliation before same-authority UI publication (${viewport.width})`);
  } finally { release(); await context.close(); f.close(); machine.close(); }
}

if (import.meta.main) {
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    let historyAvailable = true;
    const f = await capacityFixture({ advancingHeads: true, workerTranscript: (worker, before) => !historyAvailable && worker.role === "standards" ? null : ({ source_id: `owned-browser-history:${worker.id}`, version: "fixture-v1", cursor: before ? null : "earlier", turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: `${before ? "Earlier" : "Final"} ${worker.role} reasoning for ${worker.id}` }] }] }) });
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Checked PR result"); const prefix = `/implementations/${id}`;
      const detail = () => f.api(prefix).then(r => r.json());
      const until = async (ready: (d: any) => boolean, timeout = 15000) => {
        const deadline = Date.now() + timeout;
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
      historyAvailable = false;
      f.reviewOutcomes.set(standards.id, "failed"); f.workers.get(standards.id)!.condition = "ready";
      await review.getByRole("alert").filter({ hasText: "automatic recovery exhausted after six observations" }).waitFor({ timeout: 45_000 });
      const exhausted = await detail();
      assert.equal(exhausted.automatic_review[0].attempts, 6);
      assert.equal(exhausted.review_evidence.length, 1);
      const controls = page.getByRole("region", { name: "Assignment execution", exact: true });
      f.offline(true);
      await controls.getByRole("button", { name: "Pause Assignment", exact: true }).click();
      await controls.getByText("Pause pending", { exact: true }).waitFor();
      historyAvailable = true; f.offline(false);
      await controls.getByText("Paused", { exact: true }).waitFor();
      await page.reload();
      await controls.getByRole("button", { name: "Resume Assignment", exact: true }).click();
      await until(d => !d.workers.find((w: any) => w.id === standards.id).suspension);
      f.workers.get(standards.id)!.condition = "ready";
      await until(d => !d.runs[0].suspension);
      f.runs.get(run.id)!.condition = "ready";
      const spec = (await until(d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"))).workers.find((w: any) => w.role === "spec");
      assert.deepEqual((await detail()).review_evidence, exhausted.review_evidence);
      f.workers.get(spec.id)!.condition = "ready";
      const repair = (await until(d => d.workers.some((w: any) => w.rework_batch_id && w.condition === "working"))).workers.find((w: any) => w.rework_batch_id);
      await review.getByText("Fixing", { exact: true }).waitFor();
      await review.getByRole("group").filter({ hasText: "Failed" }).locator("summary").click();
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
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) await publicationRoutingJourney(browser, viewport);
  console.log("PASS approval, exhausted native review recovery through Pause/Resume, retained findings, repair and checked PR on desktop/mobile");
} finally { await browser.close(); }
}
