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
let app = createServer({ port: 0, stateDir: state, token: "", factory: { accountDiscoveryHome: state, native: { version: async () => null } } });
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
  app.stop(); app = createServer({ port: 0, stateDir: state, token: "", factory: { accountDiscoveryHome: state, native: { version: async () => null } } });
  await page.goto(`http://localhost:${app.port}/${route}`);
  await panel.getByText("Retained human-fix-context decisions", { exact: true }).waitFor();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await panel.getByRole("button", { name: "Specifications", exact: true }).click();
    await panel.getByText("Retained interview-context decisions", { exact: true }).waitFor();
    assert(await panel.getByRole("heading", { name: "Specifications", exact: true }).isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const prefix = `/api/factory/implementations/${f.assignment.id}`;
    const post = (path: string, data: object) => page.request.post(`http://localhost:${app.port}${prefix}/${path}`, { headers: { "x-herdr-factory": "1" }, data });
    const revision = await post("specifications", { content: `Presented Specification for ${viewport.width}` }).then(r => r.json());
    await page.reload();
    const history = panel.getByRole("region", { name: "Specifications", exact: true });
    await history.getByText(revision.content, { exact: true }).waitFor();
    await history.getByRole("button", { name: "Accept specification", exact: true }).click();
    await history.getByText("Specification accepted", { exact: true }).waitFor();
    let accepted = await page.request.get(`http://localhost:${app.port}${prefix}`).then(r => r.json());
    assert.equal(accepted.approvals.filter((a: { revision: string }) => a.revision === revision.id).length, 1);
    const staleSpec = await post("specifications", { content: `Soon superseded Specification ${viewport.width}` }).then(r => r.json());
    await page.reload();
    await history.getByText(staleSpec.content, { exact: true }).waitFor();
    await page.route(`**${prefix}/specification-acceptance`, async route => {
      await post("specifications", { content: `Replacement Specification ${viewport.width}` });
      await route.continue();
    });
    await history.getByRole("button", { name: "Accept specification", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Accept the presented current Specification revision" }).waitFor();
    await page.unroute(`**${prefix}/specification-acceptance`);
    const staleResult = await page.request.get(`http://localhost:${app.port}${prefix}`).then(r => r.json());
    assert(!staleResult.approvals.some((a: { revision: string }) => a.revision === staleSpec.id));
    const chatSpec = await post("specifications", { content: `Chat Specification for ${viewport.width}` }).then(r => r.json());
    await page.reload();
    await history.getByText(chatSpec.content, { exact: true }).waitFor();
    await history.getByRole("textbox", { name: "Specification reply", exact: true }).fill('> accepted');
    await history.getByRole("button", { name: "Send reply", exact: true }).click();
    await history.getByRole("textbox", { name: "Specification reply", exact: true }).waitFor();
    await page.waitForFunction(async ({ prefix, spec }) => { const d = await fetch(prefix).then(r => r.json()); return d.messages.some((m: { content: string }) => m.content === '> accepted') && !d.approvals.some((a: { revision: string }) => a.revision === spec); }, { prefix, spec: chatSpec.id });
    await history.getByRole("textbox", { name: "Specification reply", exact: true }).fill("accepted");
    await history.getByRole("button", { name: "Send reply", exact: true }).click();
    await history.getByText("Specification accepted", { exact: true }).waitFor();
    await page.reload();
    await history.getByText("Specification accepted", { exact: true }).waitFor();
    accepted = await page.request.get(`http://localhost:${app.port}${prefix}`).then(r => r.json());
    assert.equal(accepted.approvals.find((a: { revision: string }) => a.revision === chatSpec.id).provenance.kind, "owner_chat");

    await post("questions", { question: `Earlier confirmation ${viewport.width}`, answer_kind: "confirmation" });
    await post("questions", { question: `Final owner question ${viewport.width}` });
    await page.reload();
    // Replacing an accepted but unstarted Specification now asks the owner which
    // execution scope to retain. Resolve those actual questions through the UI.
    await page.waitForFunction(async prefix => {
      const detail = await fetch(prefix).then(r => r.json());
      return detail.automatic_planning.every((request: { specification_id: string; condition: string }) => request.specification_id === detail.specifications.at(-1).id || ["blocked", "started"].includes(request.condition));
    }, prefix);
    const pending = await page.request.get(`http://localhost:${app.port}${prefix}`).then(r => r.json());
    for (const entry of pending.questions.filter((q: { answer: string | null; question: string }) => q.answer === null && q.question.includes("Which Specification and execution settings"))) {
      const scopeQuestion = page.locator(".assignment-proposal article").filter({ hasText: entry.question });
      await scopeQuestion.getByRole("textbox", { name: "Your answer", exact: true }).fill("Use the latest explicitly accepted Specification and preserve older frozen contracts.");
      await scopeQuestion.getByRole("button", { name: "Save answer", exact: true }).click();
      await scopeQuestion.getByRole("textbox", { name: "Your answer", exact: true }).waitFor({ state: "detached" });
    }
    const question = page.locator(".assignment-proposal article").filter({ hasText: `Final owner question ${viewport.width}` });
    await question.getByRole("textbox", { name: "Your answer", exact: true }).fill("Keep the accepted scope");
    await question.getByRole("button", { name: "Save answer", exact: true }).click();
    await question.getByText("Keep the accepted scope", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Confirm shared understanding", exact: true }).first().click();
    await page.waitForFunction(async prefix => { const d = await fetch(prefix).then(r => r.json()); return d.questions.every((q: { answer: string | null }) => q.answer !== null); }, prefix);
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
