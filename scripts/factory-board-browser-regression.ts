/** Real board progress and passive presentation through public owned fixtures. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import type { FactoryActivity, FactoryBoardItem, FactoryDetail, FactoryOverview, FactoryRun } from "../shared/protocol.ts";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { boardRepair, boardScenario } from "./factory-board-fixture.ts";
import { routeDrained } from "./drained-route.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });

async function failedProgressBoard(): Promise<void> {
  const observed: { width: number; check: number; first: number; second: number }[] = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    const f = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await f.api("/settings", { max_agents: 4 });
      const id = await f.assignment("Concurrent failed Tickets"); const prefix = `/implementations/${id}`;
      const detail = await f.api(prefix).then(r => r.json());
      await f.api(`/projects/${detail.implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned unpaid fixtures" });
      const spec = await f.api(prefix + "/specifications", { content: "Two independent owned Tickets" }).then(r => r.json());
      for (const kind of ["specification", "testing_seams"]) await f.api(prefix + "/approvals", { kind, revision: spec.id, scope: "Public HTTP and browser" });
      const graph = await f.api(prefix + "/tickets", { specification_id: spec.id, tickets: [{ key: "transport", title: "Transport progress", acceptance: "Transport", dependencies: [] }, { key: "view", title: "View progress", acceptance: "View", dependencies: [] }] }).then(r => r.json());
      await f.api(prefix + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Independent Tickets" });
      const run = await f.api(prefix + "/runs", { action: "implement-spec", idempotency_key: "failures" }).then(r => r.json());
      const reasons = ["Transport compiler failed", "View compiler failed"]; const workers = [];
      for (const [index, ticket] of graph.tickets.entries()) workers.push(await f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: ticket.id, shared_paths: [], idempotency_key: `independent-${index}` }).then(r => r.json()));
      for (const [index, worker] of workers.entries()) { Object.assign(f.workers.get(worker.id)!, { condition: "failed", waiting_reason: reasons[index] }); await f.api(`/runs/${run.id}/workers/${worker.id}/reconcile`, {}); }
      const checkedId = await f.assignment("Failed validation result");
      const checkedRun = await f.api(`/implementations/${checkedId}/runs`, { action: "work", idempotency_key: "check" }).then(r => r.json());
      f.failNextCheck(); assert.equal((await f.api(`/runs/${checkedRun.id}/checks`, {}).then(r => r.json())).condition, "failed");
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/#assignments`);
      const failedCheck = page.getByRole("article", { name: "Failed validation result", exact: true });
      await failedCheck.getByText("Checks failed: bun test (exit 1)", { exact: true }).waitFor();
      const card = page.getByRole("article", { name: "Concurrent failed Tickets", exact: true });
      await card.getByText("All Tickets (2)", { exact: true }).click();
      await card.getByText(reasons[1]!, { exact: true }).first().waitFor();
      observed.push({ width: viewport.width, check: await failedCheck.getByRole("alert").filter({ hasText: "Checks failed: bun test (exit 1)" }).count(), first: await card.getByRole("alert").filter({ hasText: reasons[0] }).count(), second: await card.getByRole("alert").filter({ hasText: reasons[1] }).count() });
      console.log("Owned failed progress alerts", JSON.stringify(observed.at(-1)));
      // Matching owner-attention text remains polite, but cannot hide the worker's typed failure.
      await f.api(prefix + "/questions", { run_id: run.id, question: reasons[0] });
      await page.reload();
      await card.getByRole("status").filter({ hasText: reasons[0] }).waitFor();
      assert.equal(await card.getByRole("alert").filter({ hasText: reasons[0] }).count(), 1);
      assert.equal(await card.getByRole("alert").filter({ hasText: reasons[1] }).count(), 1);
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  assert.deepEqual(observed, [{ width: 390, check: 1, first: 1, second: 1 }, { width: 1440, check: 1, first: 1, second: 1 }], "Each failed check and concurrent Ticket error is announced exactly once");
}

async function ticketProgressBoard(): Promise<void> {
  const cleanupFailures: string[] = [];
  const cleanupAlert = async (card: import("playwright-core").Locator, reason: string, label: string): Promise<void> => {
    console.log("Owned cleanup role observation", JSON.stringify({ label, reason, alerts: await card.locator('.factory-progress > [role="alert"]').filter({ hasText: reason }).count(), ordinary: await card.locator('.factory-progress > p:not([role="alert"])').filter({ hasText: reason }).count() }));
    await card.getByText(reason, { exact: true }).first().waitFor();
    const alerts = await card.locator('.factory-progress > [role="alert"]').filter({ hasText: reason }).count();
    const ordinary = await card.locator('.factory-progress > p:not([role="alert"])').filter({ hasText: reason }).count();
    if (alerts !== 1 || ordinary !== 0) cleanupFailures.push(`${label}: expected one cleanup alert and no ordinary duplicate; got ${alerts} alerts and ${ordinary} ordinary reasons`);
  };
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    const f = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    const gate = f.holdNextCheck(); let check: Promise<Response> | undefined;
    try {
      const { id, run, worker, graph } = await boardScenario(f);
      const finished = await f.assignment("Finished research");
      const finishedRun = await f.api(`/implementations/${finished}/runs`, { action: "work", idempotency_key: "finished" }).then(r => r.json());
      f.runs.get(finishedRun.id)!.workspace_id = "owned-finished";
      f.runs.get(finishedRun.id)!.pane_id = "owned-finished:p1";
      f.researchReady(finishedRun.id);
      assert.equal((await f.api(`/runs/${finishedRun.id}/reconcile`, {})).status, 200);
      const completion = await f.api(`/implementations/${finished}/completion-evidence`).then(r => r.json());
      assert.deepEqual({ changes: completion.repository_changes, quiescent: completion.quiescent }, { changes: "none", quiescent: true });
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
      assert.equal(await page.getByRole("article", { name: "Unstarted idea", exact: true }).getByText("0 waiting · 0 running · 0 completed", { exact: true }).count(), 0);
      const card = page.getByRole("article", { name: "Named child progress", exact: true });
      await card.getByRole("status").filter({ hasText: "Implementing" }).waitFor();
      await card.getByRole("status").filter({ hasText: "Testing" }).waitFor();
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
      const queuedCard = page.getByRole("article", { name: "Queued for capacity", exact: true });
      await queuedCard.getByRole("status").filter({ hasText: "capacity" }).first().waitFor();
      assert.equal(await queuedCard.getByRole("alert").count(), 0, "Ordinary capacity waits stay polite");
      await page.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: "Finished research", exact: true }).waitFor();
      await page.getByRole("region", { name: "Needs you", exact: true }).getByRole("button", { name: "Failed work needs you", exact: true }).waitFor();
      const failedCard = page.getByRole("article", { name: "Failed work needs you", exact: true });
      await failedCard.getByRole("alert").filter({ hasText: /^Failed$/ }).waitFor();
      assert.equal(await failedCard.getByRole("status").filter({ hasText: /^Failed$/ }).count(), 0);
      gate.release(); await check;
      await f.api(`/runs/${run.id}/workers/${worker.id}/refresh`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/check`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/integrate`, {});
      await page.getByRole("button", { name: "Refresh factory", exact: true }).click();
      await card.getByText("1 waiting · 0 running · 1 completed", { exact: true }).waitFor();
      assert.equal(await card.locator("details[open]").count(), 1);
      const countsBeforeReview = await card.locator(".factory-progress-counts").textContent();
      const reviewCheckGate = f.holdNextCheck("integration");
      const reviewCheck = f.api(`/runs/${run.id}/checks`, {});
      try {
        await reviewCheckGate.started;
        await page.getByRole("button", { name: "Refresh factory", exact: true }).click();
        await card.getByRole("status").filter({ hasText: "Testing" }).waitFor();
        assert.equal(await card.locator(".factory-progress-counts").textContent(), countsBeforeReview);
      } finally { reviewCheckGate.release(); await reviewCheck; }
      await f.api("/settings", { max_agents: 6 });
      const reviewer = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "board-standards" }).then(r => r.json());
      await page.getByRole("button", { name: "Refresh factory", exact: true }).click();
      await card.getByRole("status").filter({ hasText: "Auto-Review" }).waitFor();
      assert.equal(await card.locator(".factory-progress-counts").textContent(), countsBeforeReview);
      await f.api(`/runs/${run.id}/workers/${reviewer.id}/stop`, {});
      await boardRepair(f, id, run.id, graph.tickets[0].id);
      await page.getByRole("button", { name: "Refresh factory", exact: true }).click();
      await card.getByText("Fixing", { exact: true }).waitFor();
      f.offline(true);
      const pause = await f.api(`/implementations/${id}/pause`, {}).then(r => r.json());
      await page.reload();
      assert.equal(pause.pause.condition, "pending");
      assert.ok(pause.pause.reasons.length > 0, "The owned offline Machine retains an actual Pause failure");
      await card.getByRole("status").filter({ hasText: /^Pause pending$/ }).waitFor();
      for (const reason of new Set<string>(pause.pause.reasons)) await cleanupAlert(card, reason, `${viewport.width} Pause`);
      f.offline(false);
      await page.getByRole("button", { name: "Refresh factory", exact: true }).click();
      await card.getByRole("status").filter({ hasText: /^Paused$/ }).waitFor();
      assert.equal(await card.locator(".factory-activity").count(), 0);
      await summary.focus(); await page.keyboard.press("Enter");
      await card.getByText("Assignment is paused", { exact: true }).first().waitFor();
      assert.equal(await page.locator(".factory-card").count(), 6);
      f.offline(true);
      const deleted = await f.api(`/implementations/${id}/delete`, {}).then(r => r.json());
      assert.equal(deleted.condition, "pending");
      assert.ok(deleted.reasons.length > 0, "The owned offline Machine retains an actual Delete failure");
      await page.reload();
      await card.getByRole("status").filter({ hasText: /^Delete pending$/ }).waitFor();
      for (const reason of new Set<string>(deleted.reasons)) await cleanupAlert(card, reason, `${viewport.width} Delete`);
      // Cleanup authority and errors survive even when the optional progress projection is absent.
      const restore = await routeDrained(page, "**/api/factory?navigation=1", async route => {
        const response = await route.fetch(); const overview: FactoryOverview = await response.json();
        overview.progress = overview.progress?.filter(progress => progress.implementation_id !== id);
        await route.fulfill({ response, json: overview });
      });
      try {
        await page.reload();
        await card.getByRole("status").filter({ hasText: /^Delete pending$/ }).waitFor();
        for (const reason of new Set<string>(deleted.reasons)) await cleanupAlert(card, reason, `${viewport.width} Delete without progress`);
      } finally { await restore(); }
      assert.deepEqual(errors, []);
    } finally { gate.release(); await check; await context.close(); f.close(); }
  }
  assert.deepEqual(cleanupFailures, [], "Pause/Delete failures are announced once as alerts on desktop/mobile");
  console.log("PASS named Ticket progress, live activity changes with unchanged counts, all activity tags, five populated lanes, keyboard expansion and pending/verified Pause on desktop/mobile");
}

async function activityAndHistoryBoard(): Promise<void> {
const state = mkdtempSync(join(tmpdir(), "saurons-eye-board-browser-"));
const app = createServer({ port: 0, token: "", stateDir: state, machines: false, factory: { accountDiscoveryHome: state, native: { version: async () => null } } });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
try {
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  const created = await page.request.post(`http://localhost:${app.port}/api/factory/implementations`, { headers: { "x-herdr-factory": "1" }, data: { title: "Untouched browser idea", description: "Owned board fixture" } });
  assert.equal(created.status(), 201);
  await page.goto(`http://localhost:${app.port}/#assignments`);
  await page.getByRole("button", { name: "Untouched browser idea", exact: true }).waitFor();
  assert.deepEqual(await page.locator(".factory-lane > h2").allTextContents(), ["Inbox", "Queued", "Running", "Needs you", "Done"]);
  assert.equal(await page.locator(".factory-card").getByText(/0\/0/).count(), 0);
  const activities: [FactoryActivity, string][] = [["specifying", "Specifying"], ["implementing", "Implementing"], ["validating", "Validating"], ["reviewing", "Reviewing"]];
  const board: FactoryBoardItem[] = [];
  for (const [activity, label] of activities) {
    const response = await page.request.post(`http://localhost:${app.port}/api/factory/implementations`, { headers: { "x-herdr-factory": "1" }, data: { title: `Browser ${label}`, description: "Owned public response fixture" } });
    const idea = await response.json(); assert.equal(response.status(), 201);
    board.push({ implementation_id: idea.id, lane: activity === "reviewing" ? "needs_you" : "running", activity, condition: activity === "reviewing" ? "needs_you" : "working", run_id: `owned-${activity}`, busy: true, waiting_reason: activity === "reviewing" ? "One reviewer needs an answer while another continues" : null, ticket_progress: activity === "implementing" ? { completed: 0, total: 2 } : null });
  }
  // API contracts separately exercise the real native records. These owned responses
  // verify presentation without launching a paid provider from a browser test.
  await page.route("**/api/factory?navigation=1", async route => {
    const response = await route.fetch(); const overview: FactoryOverview = await response.json();
    overview.board = [...(overview.board ?? []).filter(entry => !board.some(fixture => fixture.implementation_id === entry.implementation_id)), ...board];
    overview.activity = [...overview.activity.filter(entry => !board.some(fixture => fixture.implementation_id === entry.implementation_id)), ...board.flatMap((entry): FactoryOverview["activity"] => entry.run_id && entry.condition ? [{ implementation_id: entry.implementation_id, run_id: entry.run_id, condition: entry.condition, action: entry.activity === "specifying" ? "to-spec" : "work", waiting_reason: entry.waiting_reason, completed_tickets: entry.ticket_progress?.completed ?? 0, total_tickets: entry.ticket_progress?.total ?? 0 }] : [])];
    await route.fulfill({ response, json: overview });
  });
  await page.reload();
  for (const [activity, label] of activities) {
    const lane = page.getByRole("region", { name: activity === "reviewing" ? "Needs you" : "Running", exact: true });
    const card = lane.locator(".factory-card").filter({ has: page.getByRole("button", { name: `Browser ${label}`, exact: true }) });
    await card.getByRole("status", { name: label, exact: true }).waitFor();
    assert.equal(await card.getByRole("status", { name: label, exact: true }).locator('svg[aria-hidden="true"]').count(), 1);
    assert.equal(await card.getByText("Tickets: 0/2", { exact: true }).count(), activity === "implementing" ? 1 : 0);
    assert.equal(await card.getByText(/0\/0/).count(), 0);
  }
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const attention = page.getByRole("article", { name: "Browser Reviewing", exact: true });
    await attention.getByRole("status").filter({ hasText: /^Needs you$/ }).waitFor();
    assert.equal(await attention.getByRole("alert").count(), 0, "Ordinary owner attention remains a status");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("combobox", { name: "Run condition", exact: true }).selectOption("needs_you");
  await page.getByRole("button", { name: "Browser Reviewing", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Browser Implementing", exact: true }).count(), 0);
  await page.getByRole("combobox", { name: "Run condition", exact: true }).selectOption("all");
  const waits: [FactoryActivity, string][] = [["awaiting_checks", "Awaiting checks"], ["awaiting_release", "Awaiting release"]];
  for (const [activity, label] of waits) {
    const response = await page.request.post(`http://localhost:${app.port}/api/factory/implementations`, { headers: { "x-herdr-factory": "1" }, data: { title: `Browser ${label}`, description: "Owned passive wait" } });
    const idea = await response.json(); assert.equal(response.status(), 201);
    board.push({ implementation_id: idea.id, lane: "running", activity, condition: "ready", run_id: `owned-${activity}`, busy: false, waiting_reason: null, ticket_progress: null });
  }
  await page.reload();
  for (const [activity, label] of waits) {
    const card = page.getByRole("region", { name: "Running", exact: true }).locator(".factory-card").filter({ has: page.getByRole("button", { name: `Browser ${label}`, exact: true }) });
    const status = card.getByRole("status", { name: label, exact: true });
    await status.waitFor();
    assert.equal(await status.evaluate(element => element.getAnimations({ subtree: true }).length), 0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(await page.locator(".factory-lane > h2").allTextContents(), ["Inbox", "Queued", "Running", "Needs you", "Done"]);
  assert(await page.locator(".factory-panel").evaluate(element => element.scrollWidth <= element.clientWidth));
  const title = page.getByRole("button", { name: "Untouched browser idea", exact: true });
  await title.focus(); await title.press("Enter");
  await page.getByRole("heading", { name: "Untouched browser idea", exact: true }).waitFor();
  await page.getByText("Advanced controls", { exact: true }).click();
  await page.getByRole("heading", { name: "History", exact: true }).waitFor();
  await page.getByText("implementation_created", { exact: false }).waitFor();
  const review = board.find(entry => entry.activity === "reviewing")!;
  await page.route(new RegExp(`/api/factory/implementations/${review.implementation_id}(?:\\?.*)?$`), async route => {
    const response = await route.fetch(); const detail: FactoryDetail = await response.json();
    const old: FactoryRun = { id: "owned-past-attempt", implementation_id: review.implementation_id, created_at: "2026-01-01T10:00:00Z", updated_at: "2026-01-01T10:05:00Z", action: "to-spec", provider: "codex", machine_id: "local", condition: "completed", waiting_reason: null, idempotency_key: "owned-past", specification_id: null, graph_hash: null, base: null, checkout: null, worktree: null, branch: null, workspace_id: null, pane_id: null, manifest: {} };
    detail.runs = [old, { ...old, id: "owned-current-attempt", action: "work", condition: "needs_you", created_at: "2026-01-02T10:00:00Z", updated_at: "2026-01-02T10:05:00Z" }];
    detail.board = review;
    await route.fulfill({ response, json: detail });
  });
  await page.goto(`http://localhost:${app.port}/#assignments`);
  const reviewTitle = page.getByRole("button", { name: "Browser Reviewing", exact: true });
  await reviewTitle.focus(); await reviewTitle.press("Enter");
  await page.getByRole("heading", { name: "Browser Reviewing", exact: true }).waitFor();
  await page.locator(".factory-detail").getByRole("status", { name: "Reviewing", exact: true }).waitFor();
  await page.getByText("Advanced controls", { exact: true }).click();
  const history = page.getByRole("region", { name: "Past attempts", exact: true });
  await history.getByRole("status", { name: "Specifying", exact: true }).waitFor();
  await history.getByText("Finished attempt", { exact: false }).waitFor();
  await history.getByRole("status", { name: "Implementing", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("factory board: desktop/mobile lanes, activity, progress, passive waits and keyboard history passed");
} catch (error) {
  console.error("Board browser errors:", errors);
  console.error("Board browser location:", page.url());
  console.error(await page.locator(".factory-panel").innerText().catch(() => "Factory panel unavailable"));
  throw error;
} finally { app.stop(); rmSync(state, { recursive: true, force: true }); }
}

try {
  await failedProgressBoard();
  await ticketProgressBoard();
  await activityAndHistoryBoard();
} finally { await browser.close(); }
