/** Owned HTTP fixtures and real desktop/mobile Assignment journeys. Build first. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";

const root = mkdtempSync(join(tmpdir(), "saurons-source-browser-"));
const repo = join(root, "repo");
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
writeFileSync(join(repo, "README.md"), "# Fictional issue source\n");
for (const args of [["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], ["remote", "add", "origin", "https://github.com/fictional/project.git"]]) execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
const responses = join(root, "issues.json");
const issue = { repository_url: "https://api.github.com/repos/fictional/project", number: 12, node_id: "fictional-issue", title: "Fictional source title", body: "Original source acceptance", labels: [{ name: "needs-plan" }], state: "open", updated_at: "2026-10-01T12:00:00Z", html_url: "https://github.com/fictional/project/issues/12" };
const prerequisite = { ...issue, number: 24, node_id: "fictional-issue-24", title: "Prerequisite source", html_url: "https://github.com/fictional/project/issues/24" };
function saveIssues(dependencies: Record<string, unknown[]> = { 12: [prerequisite] }) { writeFileSync(responses, JSON.stringify({ issues: [issue, prerequisite], dependencies })); }
saveIssues();
const cli = join(root, "gh.mjs");
writeFileSync(cli, `import { readFileSync } from "node:fs";
const endpoint = process.argv[3];
const result = endpoint === "user" ? { login: "fictional-owner", id: 1042 } : endpoint?.includes("/dependencies/blocked_by") ? JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8")).dependencies?.[endpoint.split("/issues/")[1].split("/")[0]] ?? [] : endpoint?.includes("/issues?") ? JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8")).issues ?? { error: "Incomplete inventory" } : endpoint === "graphql" ? { data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } : {};
console.log(JSON.stringify(result));\n`);
const app = createServer({ port: 0, stateDir: root, machines: false, factory: { accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [cli] } } } });
const origin = `http://localhost:${app.port}`;
const headers = { "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
async function post(path: string, body: unknown) {
  const response = await fetch(origin + "/api/factory" + path, { method: "POST", headers, body: JSON.stringify(body) });
  assert(response.ok, await response.clone().text()); return response.json();
}
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const profile = await post("/machines/local/accounts", { name: "Fictional", service: "github", expected_login: "fictional-owner" });
  await post(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision });
  const project = await post("/projects", { name: "Source fixture Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" });
  const route = `/projects/${project.id}/github`;
  await post(route + "/configure", { expected_revision: null, repository: "fictional/project", account_profile_id: profile.id, sync_enabled: false, import_issues: true, import_fixes: false, auto_update: false, auto_merge: false, trusted_reviewers: [], required_checks: [], review_context: "Fictional Project rules", poll_minutes: 5 });
  const view = await post(route + "/sync", {}); const id = view.sources.find((source: { number: number }) => source.number === 12).implementation_id;
  const detail = await fetch(origin + `/api/factory/implementations/${id}`).then(response => response.json());
  await post(`/implementations/${id}/messages`, { chat_id: detail.chats[0].id, role: "owner", content: "My independent owner note" });
  Object.assign(issue, { title: "Updated source title", body: "Revised source acceptance", labels: [{ name: "ready-for-agent" }], updated_at: "2026-10-02T12:00:00Z" });
  saveIssues(); await post(route + "/sync", {});
  const errors: string[] = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport }); page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + `/#factory/${id}`);
    const source = page.getByRole("region", { name: "GitHub issue source", exact: true });
    await source.getByRole("heading", { name: "Updated source title", exact: true }).waitFor();
    await source.getByText("Revised source acceptance", { exact: true }).first().waitFor();
    await source.getByText("ready-for-agent", { exact: true }).first().waitFor();
    const dependencies = source.getByRole("region", { name: "Native GitHub dependencies", exact: true });
    await dependencies.getByRole("link", { name: "fictional/project #24", exact: true }).waitFor();
    await dependencies.getByText("Delivery has not been verified.", { exact: true }).waitFor();
    const assignmentLink = dependencies.getByRole("link", { name: "Open prerequisite Assignment", exact: true });
    assert.equal(await assignmentLink.getAttribute("href"), `#factory/${view.sources.find((source: { number: number }) => source.number === 24).implementation_id}`);
    saveIssues({ 12: [prerequisite], 24: [issue] }); await post(route + "/sync", {});
    await page.reload();
    await dependencies.getByText("Dependency cycle. Correct the native relationships on GitHub.", { exact: true }).waitFor();
    assert.equal(await assignmentLink.count(), 0);
    saveIssues(); await post(route + "/sync", {}); await page.reload();
    await source.getByText("Source history", { exact: true }).click();
    await source.getByText("Original source acceptance", { exact: true }).waitFor();
    await page.getByText("Advanced controls", { exact: true }).click();
    await page.locator(".factory-message").getByText("My independent owner note", { exact: true }).waitFor();
    issue.state = "closed"; saveIssues(); await post(route + "/sync", {});
    await page.reload(); await source.getByText("Issue is closed", { exact: true }).first().waitFor();
    await page.getByRole("heading", { name: "Fictional source title", exact: true }).waitFor();
    writeFileSync(responses, JSON.stringify({ error: "Incomplete inventory" }));
    const failed = await fetch(origin + "/api/factory" + route + "/sync", { method: "POST", headers, body: "{}" }); assert.equal(failed.status, 409);
    await page.reload(); await source.getByRole("alert").waitFor();
    await source.getByText("Revised source acceptance", { exact: true }).first().waitFor();
    await dependencies.getByText("Dependency evidence is stale or incomplete. Sync GitHub before starting work.", { exact: true }).waitFor();
    await dependencies.getByRole("link", { name: "fictional/project #24", exact: true }).waitFor();
    issue.state = "open"; saveIssues(); await post(route + "/sync", {});
    await page.reload(); await source.getByText("Issue is open", { exact: true }).first().waitFor();
    assert.equal(await source.getByRole("alert").count(), 0);
    assert(await source.evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile source history, native dependency links, cycles, unverified delivery and stale evidence");
} finally { await browser.close(); app.stop(); rmSync(root, { recursive: true, force: true }); }
