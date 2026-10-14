/** Changed issue scope through real desktop/mobile controls and owned native fixtures. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { githubScheduleFixture } from "../server/github-schedules.fixture.ts";
import { herdrRpc, workspaceClose, type WorkspaceCreateResult } from "../server/herdr/client.ts";
import type { FactoryRun } from "../shared/protocol.ts";

const owned: string[] = []; let reachable = true;
const f = await githubScheduleFixture({
  version: async () => "owned-scope-browser-fixture",
  createWorkspace: async options => { const result = await herdrRpc<WorkspaceCreateResult>("workspace.create", { ...options, focus: false }); owned.push(result.workspace.workspace_id); return result; },
  startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); },
  closeWorkspace: async id => { if (!reachable) throw new Error("Owned Machine stop receipt unavailable"); return workspaceClose(id); },
});
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
const errors: string[] = [];
try {
  const policy = (await f.request(f.route + "/configure", { ...f.policy, auto_implement: true })).body;
  for (const width of [1440, 390]) {
    reachable = true;
    const issue = { number: width, node_id: `fictional-scope-${width}`, title: `Retained scope ${width}`, body: "Original approved scope", html_url: `https://github.com/fictional/schedules/issues/${width}`, state: "open", labels: [{ name: "ready-for-agent" }] };
    writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
    const source = (await f.request(f.route + "/sync", {})).body.sources.find((source: { number: number }) => source.number === width);
    const plan = { acceptance_criteria: "Keep the approved notes and repository work", testing_seams: ["Public HTTP", "Real browser journeys"], dependencies: [], planning_decisions: [] };
    assert.equal((await f.request(`${f.route}/issues/${width}/approve`, { policy_revision: policy.revision, issue_revision: source.revision, plan })).status, 200);
    const prefix = `/implementations/${source.implementation_id}`;
    const started = await f.request(prefix + "/runs", { action: "work", idempotency_key: `browser-scope-${width}` }); assert.equal(started.status, 202);
    const run: FactoryRun = started.body; assert.equal(run.condition, "working");
    const detail = (await f.request(prefix)).body;
    assert.equal((await f.request(prefix + "/artifacts", { chat_id: detail.chats[0].id, name: `Retained notes ${width}.md`, media_type: "text/markdown", content_base64: Buffer.from("Produced before the scope changed").toString("base64") })).status, 201);
    reachable = width !== 390;
    issue.body = "Different unapproved requirements"; writeFileSync(f.responses, JSON.stringify({ issues: [issue] }));
    await f.request(f.route + "/sync", {});
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    page.setDefaultTimeout(10_000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(f.origin() + `/#projects/${f.route.split("/")[2]}`);
    const card = page.getByRole("region", { name: "Needs you", exact: true }).locator(".factory-card").filter({ has: page.getByRole("button", { name: issue.title, exact: true }) });
    await card.waitFor(); await card.getByText(/approved issue scope changed/).waitFor();
    await card.getByRole("button", { name: issue.title, exact: true }).click();
    await page.getByRole("heading", { name: issue.title, exact: true }).waitFor();
    await page.getByText("Advanced controls", { exact: true }).click();
    const evidence = page.locator("section.factory-section").filter({ has: page.getByRole("heading", { name: "Execution evidence", exact: true }) });
    await evidence.getByText(width === 390 ? "Issue scope pause pending" : "Issue scope paused", { exact: true }).waitFor();
    await evidence.getByText("Accepted issue scope", { exact: true }).click();
    await evidence.getByText(plan.acceptance_criteria, { exact: true }).waitFor();
    assert.equal(await evidence.getByRole("button", { name: "Start Standards review", exact: true }).isDisabled(), true);
    await page.getByText(`Retained notes ${width}.md`, { exact: false }).first().waitFor();
    if (width === 390) {
      reachable = true;
      await evidence.getByRole("button", { name: "Reconcile Run", exact: true }).click();
      await evidence.getByText("Issue scope paused", { exact: true }).waitFor();
    }
    const retained = (await f.request(prefix)).body;
    assert.equal(retained.runs.length, 1); assert.deepEqual(retained.runs[0].manifest, run.manifest);
    assert.equal(retained.runs[0].scope_pause.condition, "paused");
    assert(await page.locator(".factory-panel").evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("GitHub scope browser: desktop/mobile revocation, pause, retained scope/evidence and repair passed");
} finally { await browser.close(); for (const id of owned) await workspaceClose(id).catch(() => {}); f.close(); }
