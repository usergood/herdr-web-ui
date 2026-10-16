/** Owned HTTP fixtures and real desktop/mobile Assignment journeys. Build first. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { factoryBrowserPost, issueBrowserCli } from "./fixtures/issue-browser-transport.ts";

const root = mkdtempSync(join(tmpdir(), "saurons-planning-browser-"));
const repo = join(root, "repo");
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
writeFileSync(join(repo, "README.md"), "# Fictional issue source\n");
for (const args of [["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], ["remote", "add", "origin", "https://github.com/fictional/project.git"]]) execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
const responses = join(root, "issues.json");
const issue = { repository_url: "https://api.github.com/repos/fictional/project", number: 12, node_id: "fictional-issue", title: "Fictional source title", body: "## Scope\nShow a greeting.\n\n## Acceptance criteria\nShow hello.\n\n## Dependencies\nNone.", labels: [{ name: "ready-for-agent" }], state: "open", updated_at: "2026-10-01T12:00:00Z", html_url: "https://github.com/fictional/project/issues/12" };
const issues = new Map<number, typeof issue>();
function saveIssues(dependencies: Record<string, unknown[]> = {}) {
  issues.set(issue.number, structuredClone(issue));
  writeFileSync(responses, JSON.stringify({ issues: [...issues.values()], dependencies }));
}
saveIssues();
const cli = issueBrowserCli(root, responses);
const app = createServer({ port: 0, stateDir: root, machines: false, factory: { accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [cli] } } } });
const origin = `http://localhost:${app.port}`;
const post = factoryBrowserPost(origin);
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const profile = await post("/machines/local/accounts", { name: "Fictional", service: "github", expected_login: "fictional-owner" });
  await post(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision });
  const project = await post("/projects", { name: "Planning fixture Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" });
  const route = `/projects/${project.id}/github`;
  await post(route + "/configure", { expected_revision: null, repository: "fictional/project", account_profile_id: profile.id, sync_enabled: false, import_issues: true, import_fixes: false, auto_update: false, auto_merge: false, trusted_reviewers: [], required_checks: [], review_context: "Fictional rules", poll_minutes: 5 });
  const policy = await post(route + "/readiness", { expected_revision: null, account_profile_id: profile.id, triage_labels: {}, blocked_label: "blocked" });
  const errors: string[] = [];
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) mkdirSync(evidence, { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    issue.body = "## Scope\nShow a greeting.\n\n## Acceptance criteria\nShow hello.\n\n## Dependencies\nNone.";
    issue.updated_at = viewport.width === 1440 ? "2026-10-01T12:00:00Z" : "2026-10-03T12:00:00Z";
    saveIssues();
    let view = await post(route + "/sync", {}); let source = view.sources[0];
    await post(route + `/issues/${issue.number}/approve`, { source_revision: source.revision, policy_revision: policy.revision });
    const page = await browser.newPage({ viewport }); page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(origin + `/#factory/${source.implementation_id}`);
      await page.getByRole("heading", { name: "Fictional source title", exact: true }).first().waitFor();
      await page.getByRole("button", { name: "Prepare issue plan", exact: true }).click();
      const planning = page.getByRole("region", { name: "Issue planning", exact: true });
      await planning.getByText("Needs you", { exact: true }).waitFor();
      const actions = page.getByRole("region", { name: "Next step", exact: true });
      const pendingQuestion = actions.locator("article").filter({ has: page.getByLabel("Your answer", { exact: true }) });
      await pendingQuestion.getByText(/Resolve only these planning decisions:.*testing seams/).waitFor();
      await pendingQuestion.getByLabel("Your answer", { exact: true }).fill("Use public HTTP and real browser journeys. I will update the issue and renew readiness.");
      await pendingQuestion.getByRole("button", { name: "Save answer", exact: true }).click();
      await pendingQuestion.waitFor({ state: "detached" });
      await actions.getByText("Use public HTTP and real browser journeys. I will update the issue and renew readiness.", { exact: true }).last().waitFor();
      if (evidence) await page.screenshot({ path: join(evidence, `issue-plan-needs-you-${viewport.width}.png`), fullPage: true });
      issue.body += "\n\n## Testing seams\nPublic HTTP and real browser journeys.";
      issue.updated_at = viewport.width === 1440 ? "2026-10-02T12:00:00Z" : "2026-10-04T12:00:00Z";
      saveIssues(); view = await post(route + "/sync", {}); source = view.sources[0];
      await post(route + `/issues/${issue.number}/approve`, { source_revision: source.revision, policy_revision: policy.revision });
      await page.reload();
      await page.getByRole("button", { name: "Prepare issue plan", exact: true }).click();
      await planning.getByText("Planning prepared", { exact: true }).waitFor();
      const reusedPlanning = planning.locator("details").filter({ has: page.locator("summary", { hasText: "Reused planning" }) });
      await reusedPlanning.locator("summary").click();
      await reusedPlanning.getByText("Show hello.", { exact: true }).waitFor();
      await planning.getByText("Approved by fictional-owner", { exact: false }).waitFor();
      await planning.getByText("Required checks and independent Standards and Spec reviews still apply.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Accept specification", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Approve Ticket graph", exact: true }).count(), 0);
      assert(await planning.evaluate(element => element.scrollWidth <= element.clientWidth));
      if (evidence) await page.screenshot({ path: join(evidence, `issue-plan-prepared-${viewport.width}.png`), fullPage: true });
      const detail = await fetch(origin + `/api/factory/implementations/${source.implementation_id}`).then(response => response.json());
      assert.deepEqual(detail.runs, []); assert.deepEqual(detail.approvals, []);
      assert.equal(detail.github_sources[0].planning.consumed_question_revision, detail.question_revision);
    } catch (error) {
      if (evidence) await page.screenshot({ path: join(evidence, `issue-plan-failure-${viewport.width}.png`), fullPage: true });
      throw error;
    } finally { await page.close(); }
  }
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    issue.number = viewport.width === 1440 ? 21 : 22;
    issue.node_id = `fictional-app-plan-${issue.number}`;
    issue.html_url = `https://github.com/fictional/project/issues/${issue.number}`;
    issue.body = "## Scope\nShow a greeting.\n\n## Acceptance criteria\nShow hello.\n\n## Dependencies\nNone.\n\n## Testing seams\nPublic HTTP and real browser journeys.";
    saveIssues();
    const original = (await post(route + "/sync", {})).sources.find((source: any) => source.number === issue.number);
    const prefix = `/implementations/${original.implementation_id}`;
    const specification = await post(prefix + "/specifications", { content: issue.body });
    const oldScope = { source_id: original.id, source_revision: original.revision };
    for (const kind of ["specification", "testing_seams"]) await post(prefix + "/approvals", { kind, revision: specification.id, scope: "Hello through HTTP", issue_scope: oldScope });
    const graph = await post(prefix + "/tickets", { specification_id: specification.id, tickets: [{ key: "hello", title: "Retained Hello Ticket", acceptance: "Show hello via HTTP", dependencies: [] }] });
    await post(prefix + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Hello graph", issue_scope: oldScope });
    issue.body = issue.body.replaceAll("hello", "goodbye").replace("Public HTTP", "Public CLI");
    saveIssues();
    const changed = (await post(route + "/sync", {})).sources.find((source: any) => source.number === issue.number);
    await post(route + `/issues/${issue.number}/approve`, { source_revision: changed.revision, policy_revision: policy.revision });
    assert.equal((await post(route + "/preview", {})).entries.find((entry: any) => entry.source_id === changed.id).eligible, false);
    const page = await browser.newPage({ viewport }); page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(origin + `/#factory/${changed.implementation_id}`);
      const planning = page.getByRole("region", { name: "Issue planning", exact: true });
      await planning.getByText("Needs you", { exact: true }).waitFor();
      assert.equal(await planning.getByRole("button", { name: "Start prepared issue", exact: true }).count(), 0);
      const actions = page.getByRole("region", { name: "Next step", exact: true });
      await actions.getByLabel("Your answer", { exact: true }).fill("yes");
      await actions.getByRole("button", { name: "Save answer", exact: true }).click();
      await actions.getByLabel("Your answer", { exact: true }).waitFor({ state: "detached" });
      await planning.getByRole("button", { name: "Prepare issue plan", exact: true }).click();
      await actions.getByLabel("Your answer", { exact: true }).waitFor();
      await planning.getByText("Needs you", { exact: true }).waitFor();
      const retained = planning.locator("details").filter({ has: page.locator("summary", { hasText: "Reused planning" }) });
      await retained.locator("summary").click();
      await retained.getByText("Show hello.", { exact: true }).waitFor();
      const approved = page.waitForResponse(response => response.url().endsWith(prefix + "/approvals") && response.request().postDataJSON().kind === "ticket_graph");
      await planning.getByRole("button", { name: "Approve retained app plan for this issue revision", exact: true }).click();
      assert.equal((await approved).status(), 201);
      await actions.getByLabel("Your answer", { exact: true }).fill("Retain the app plan I explicitly reviewed for this issue revision.");
      await actions.getByRole("button", { name: "Save answer", exact: true }).click();
      await actions.getByLabel("Your answer", { exact: true }).waitFor({ state: "detached" });
      await planning.getByRole("button", { name: "Prepare issue plan", exact: true }).click();
      await planning.getByText("Planning prepared", { exact: true }).waitFor();
      await planning.getByText("Retained Hello Ticket", { exact: true }).waitFor();
      const detail = await fetch(origin + `/api/factory${prefix}`).then(response => response.json());
      assert.equal(detail.github_sources[0].planning.graph_hash, graph.hash);
      assert.deepEqual(detail.approvals.slice(-3).map((approval: any) => ({ source_id: approval.issue_scope.source_id, source_revision: approval.issue_scope.source_revision })), Array(3).fill({ source_id: changed.id, source_revision: changed.revision }));
      assert.deepEqual(detail.runs, []);
      assert(await planning.evaluate(element => element.scrollWidth <= element.clientWidth));
      if (evidence) await page.screenshot({ path: join(evidence, `issue-app-plan-renewed-${viewport.width}.png`), fullPage: true });
    } finally { await page.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile targeted Needs you, actual answer, renewed scope, prepared graph and provenance without starts or synthetic approvals");
} finally { await browser.close(); app.stop(); rmSync(root, { recursive: true, force: true }); }
