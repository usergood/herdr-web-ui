/** Board presentation through the real browser, public API and owned response fixtures. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import type { FactoryActivity, FactoryBoardItem, FactoryDetail, FactoryOverview, FactoryRun } from "../shared/protocol.ts";

const state = mkdtempSync(join(tmpdir(), "saurons-eye-board-browser-"));
const app = createServer({ port: 0, token: "", stateDir: state, machines: false, factory: { accountDiscoveryHome: state } });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
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
} finally { await browser.close(); app.stop(); rmSync(state, { recursive: true, force: true }); }
