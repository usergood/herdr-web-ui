import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { seedWorkflowConversations } from "./fixtures/workflow-conversations.ts";
import { FactoryStore } from "../server/factory-store.ts";
import { herdrRpc, workspaceClose, type WorkspaceCreateResult } from "../server/herdr/client.ts";

const state = mkdtempSync(join(tmpdir(), "workflow-browser-"));
const f = seedWorkflowConversations(state);
const native = await herdrRpc<WorkspaceCreateResult>("workspace.create", { cwd: state, label: "herdr-web-ui-test-workflow-history", focus: false });
const fixtureStore = new FactoryStore(state);
fixtureStore.put("workers", { ...f.implementation, worktree: state, workspace_id: native.workspace.workspace_id, pane_id: native.root_pane.pane_id }, f.orchestrator.id);
fixtureStore.close();
let app = createServer({ port: 0, stateDir: state, token: "", factory: { accountDiscoveryHome: state } });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  let launches = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/(runs|workers|continue)$/.test(new URL(request.url()).pathname)) launches++; });
  await page.goto(`http://localhost:${app.port}/#factory/${f.assignment.id}`);
  const nativeRow = page.locator(".project-navigation .project-pane-row").getByRole("button", { name: /Keep the approved Ticket name/ });
  await nativeRow.click();
  await page.locator(`[data-pane-owner="${native.root_pane.pane_id}"]`).waitFor();
  await page.goto(`http://localhost:${app.port}/#factory/${f.assignment.id}`);
  const panel = page.getByRole("region", { name: "Workflow conversations", exact: true });
  await panel.getByRole("button", { name: "Specifications", exact: true }).click();
  await panel.getByText("Retained interview-context decisions", { exact: true }).waitFor();
  await panel.getByText("Retained specification-context decisions", { exact: true }).waitFor();
  const tree = panel.getByRole("navigation", { name: "Workflow history", exact: true });
  await tree.getByRole("button", { name: "Implementation: Keep the approved Ticket name", exact: true }).click();
  await panel.getByText("Retained implementation-context decisions", { exact: true }).waitFor();
  const reviewer = tree.locator('[data-conversation-kind="reviewer"]');
  assert.equal(await reviewer.getByRole("button").count(), 2);
  await reviewer.getByRole("button", { name: "Standards", exact: true }).click();
  await panel.getByText("Retained standards-context decisions", { exact: true }).waitFor();
  await reviewer.getByRole("button", { name: "Spec", exact: true }).click();
  await panel.getByText("Retained spec-review-context decisions", { exact: true }).waitFor();
  const fixes = tree.getByRole("button", { name: "Review-fixes", exact: true });
  assert.equal(await fixes.count(), 2);
  await fixes.nth(0).click();
  await panel.getByText("Retained automatic-fix-context decisions", { exact: true }).waitFor();
  assert.equal(await panel.getByText("Retained human-fix-context decisions", { exact: true }).count(), 0);
  await fixes.nth(1).click();
  await panel.getByText("Retained human-fix-context decisions", { exact: true }).waitFor();
  const route = new URL(page.url()).hash;
  app.stop(); app = createServer({ port: 0, stateDir: state, token: "", factory: { accountDiscoveryHome: state } });
  await page.goto(`http://localhost:${app.port}/${route}`);
  await panel.getByText("Retained human-fix-context decisions", { exact: true }).waitFor();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await panel.getByRole("button", { name: "Specifications", exact: true }).click();
    await panel.getByText("Retained interview-context decisions", { exact: true }).waitFor();
    assert(await panel.getByRole("heading", { name: "Specifications", exact: true }).isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (viewport.width === 390) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    await page.locator(".project-navigation").getByRole("button", { name: "Human Review", exact: true }).click();
    await panel.getByText("Retained human-context decisions", { exact: true }).waitFor();
  }
  const detail = await page.request.get(`http://localhost:${app.port}/api/factory/implementations/${f.assignment.id}`).then(r => r.json());
  assert.equal(detail.runs.length, 4); assert.equal(detail.workers.length, 5);
  assert.equal(launches, 0); assert.deepEqual(errors, []);
  // An unreadable imported message must not take down the Assignment's history.
  await page.route(`**/api/factory/implementations/${f.assignment.id}`, async route => {
    const response = await route.fetch(); const body = await response.json();
    body.native_snapshots.find((snapshot: { id: string }) => snapshot.id === "interview-context-history").turns[0].parts = [{ kind: "tool", name: "owned-unreadable-tool", summary: { unreadable: "fixture" }, input: "", output: "" }];
    await route.fulfill({ response, json: body });
  });
  await page.goto(`http://localhost:${app.port}/#factory/${f.assignment.id}`);
  await panel.getByText("This preview can't be shown.", { exact: true }).waitFor();
  await panel.getByText("Retained specification-context decisions", { exact: true }).waitFor();
  console.log("workflow conversations: desktop/mobile hierarchy, provenance, restart and navigation passed");
} finally { await browser.close(); app.stop(); await workspaceClose(native.workspace.workspace_id); rmSync(state, { recursive: true, force: true }); }
