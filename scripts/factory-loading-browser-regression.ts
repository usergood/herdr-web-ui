import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { factoryLoadingFixture } from "../server/factory-loading.fixture.ts";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";

const fixture = factoryLoadingFixture();
const workspace = await workspaceCreate({ label: "herdr-web-ui-test-loading", cwd: fixture.root });
const pane = workspace.root_pane;
assert(pane);
fixture.restart(store => {
  const run = store.get<any>("runs", "run-0-3");
  store.put("runs", { ...run, pane_id: pane.pane_id, worktree: pane.cwd, workspace_id: workspace.workspace.workspace_id }, fixture.id);
});
fixture.stop();
const app = createServer({ port: 0, token: "", stateDir: fixture.root, factory: { accountDiscoveryHome: fixture.root } });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }); page.setDefaultTimeout(15_000);
    const requests: { view: string; at: number }[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname === `/api/factory/implementations/${fixture.id}`) requests.push({ view: url.searchParams.get("view") ?? "full", at: Date.now() }); });
    await page.goto(`http://localhost:${app.port}/#factory/${fixture.id}`);
    await page.getByRole("heading", { name: "Assignment 0", exact: true }).waitFor();
    assert(requests.some(r => r.view === "current")); assert(!requests.some(r => r.view === "full" || r.view === "review" || r.view === "report" || r.view === "snapshot"));
    let failedSnapshot = false;
    await page.route("**/api/factory/implementations/*?view=snapshot&*", async route => {
      if (!failedSnapshot) { failedSnapshot = true; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Fixture snapshot retry" } }) }); }
      else await route.continue();
    });
    await page.locator("summary").filter({ hasText: /^Review changes$/ }).click();
    await page.getByRole("alert").filter({ hasText: "Fixture snapshot retry" }).getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("heading", { name: "Review changes", exact: true }).waitFor();
    await page.locator(".factory-diff").first().waitFor();
    assert(requests.some(r => r.view === "review")); assert(requests.some(r => r.view === "snapshot")); assert(!requests.some(r => r.view === "report" || r.view === "full"));
    let failedReport = false;
    await page.route("**/api/factory/implementations/*?view=report&*", async route => {
      if (!failedReport) { failedReport = true; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Fixture report retry" } }) }); }
      else await route.continue();
    });
    const reportToggle = page.locator("summary").filter({ hasText: "Review finding · report-0-0" });
    await reportToggle.click(); await page.getByRole("alert").filter({ hasText: "Fixture report retry" }).waitFor();
    await reportToggle.evaluate(element => new Promise<void>(resolve => { const details = element.parentElement as HTMLDetailsElement; details.addEventListener("toggle", () => resolve(), { once: true }); details.open = false; }));
    await reportToggle.click();
    await reportToggle.locator("..").locator("pre").waitFor();
    assert.equal(requests.filter(r => r.view === "report").length, 2);
    await page.locator("summary").filter({ hasText: /^Advanced controls$/ }).first().click();
    await page.getByRole("heading", { name: "Retained native conversations", exact: true }).waitFor();
    assert.equal(requests.filter(r => r.view === "full").length, 1);
    const nextPoll = page.waitForResponse(response => new URL(response.url()).searchParams.get("view") === "current"); await nextPoll;
    assert.equal(requests.filter(r => r.view === "full").length, 1, "unchanged history is not refetched on polling");
    const refreshedHistory = page.waitForResponse(response => response.url().endsWith(`/api/factory/implementations/${fixture.id}`));
    const saved = await page.request.post(`http://localhost:${app.port}/api/factory/implementations/${fixture.id}/chats`, { headers: { origin: `http://localhost:${app.port}`, "x-herdr-factory": "1" }, data: { title: `Retained ${width}` } });
    assert.equal(saved.status(), 201); await refreshedHistory;
    assert.equal(requests.filter(r => r.view === "full").length, 2, "expanded history refreshes after a retained write");
    await page.goto(`http://localhost:${app.port}/?ws=${workspace.workspace.workspace_id}&pane=${pane.pane_id}`);
    try { await page.getByRole("button", { name: "Workflow", exact: true }).click(); } catch (error) { console.error("Navigation fixture", JSON.stringify({ pane, workspace: workspace.workspace, url: page.url(), text: (await page.locator("body").innerText()).slice(0, 2500) })); throw error; }
    const dialog = page.getByRole("dialog", { name: "Workflow", exact: true });
    await dialog.getByRole("heading", { name: "Assignment 0", exact: true }).waitFor();
    const priorFull = requests.filter(r => r.view === "full").length;
    const workflowPoll = page.waitForResponse(response => new URL(response.url()).searchParams.get("view") === "current"); await workflowPoll;
    assert.equal(requests.filter(r => r.view === "full").length, priorFull);
    assert.deepEqual(errors, []); await page.close();
  }
  console.log("Workflow and board: compact polls, lazy review/report/snapshot/history, unchanged-history reuse, desktop and phone passed");
} finally { await browser.close(); app.stop(); await workspaceClose(workspace.workspace.workspace_id); fixture.close(); }
