/** Disposable public HTTP/browser fixture; the CLI never contacts GitHub. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../server/index.ts";

export function githubQueueFixture() {
  const root = mkdtempSync(join(tmpdir(), "queue-fixture-"));
  const repo = join(root, "repo"); execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "Fictional Project\n");
  for (const args of [["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], ["remote", "add", "origin", "https://github.com/fictional/project.git"]]) execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const responses = join(root, "responses.json");
  const cli = join(root, "gh.mjs");
  const issue = { repository_url: "https://api.github.com/repos/fictional/project", number: 1, node_id: "fictional-contract-issue", title: "Fictional scope", body: "## Scope\nShow a greeting.\n## Acceptance criteria\nShow hello.\n## Dependencies\nNone.\n## Testing seams\nPublic HTTP and real browser journeys.", labels: [{ name: "ready-for-agent" }], state: "open", updated_at: "2026-10-01T12:00:00Z", html_url: "https://github.com/fictional/project/issues/1" };
  const save = (issues = [issue], fail = false, dependencies: Record<string, typeof issue[]> = {}) => writeFileSync(responses, JSON.stringify({ issues, fail, dependencies }));
  save();
  writeFileSync(cli, `import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(${JSON.stringify(responses)}, "utf8")); const endpoint = process.argv[3];
const number = Number(process.argv.find(arg => arg.startsWith("query="))?.match(/issue[(]number:([0-9]+)/)?.[1] ?? endpoint.match(/issues[/]([0-9]+)/)?.[1]);
const issue = data.issues.find(issue => issue.number === number) ?? data.issues[0];
console.log(JSON.stringify(endpoint === "user" ? {login:"fictional-owner",id:1042} : endpoint.includes("/dependencies/blocked_by") ? data.dependencies[number] ?? [] : endpoint.includes("/issues?") ? data.fail ? {} : data.issues : endpoint.includes("/events?") ? [] : endpoint.includes("/issues/") ? issue : endpoint === "graphql" ? {data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}},issue:{id:issue.node_id,title:issue.title,body:issue.body,state:issue.state.toUpperCase(),createdAt:"2026-09-30T12:00:00Z",updatedAt:issue.updated_at,lastEditedAt:null}}}} : {full_name:"fictional/project"}));`);
  let app = createServer({ port: 0, stateDir: root, machines: false, token: "fixture-owner", factory: { accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [cli] } } } });
  let origin = `http://localhost:${app.port}`;
  const headers = { authorization: "Bearer fixture-owner", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  const post = (path: string, body: unknown, extra: Record<string, string> = headers) => fetch(origin + "/api/factory" + path, { method: "POST", headers: extra, body: JSON.stringify(body) });
  const get = (path: string) => fetch(origin + "/api/factory" + path, { headers });
  async function json(path: string, body?: unknown): Promise<any> {
    const response = body === undefined ? await get(path) : await post(path, body);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
  async function setup() {
    const account = await json("/machines/local/accounts", { name: "Fictional", service: "github", expected_login: "fictional-owner" });
    await json(`/machines/local/accounts/${account.id}/verify`, { expected_revision: account.revision });
    const project = await json("/projects", { name: "Queue fixture Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" });
    const route = `/projects/${project.id}/github`;
    const configuration = { expected_revision: null, repository: "fictional/project", account_profile_id: account.id, sync_enabled: false, import_issues: true, import_fixes: false, auto_update: false, auto_merge: false, trusted_reviewers: [], required_checks: [], review_context: "Fictional standards", poll_minutes: 5 };
    await json(route + "/configure", configuration);
    const readiness = await json(route + "/readiness", { expected_revision: null, account_profile_id: account.id, triage_labels: {}, blocked_label: "blocked" });
    return { account, project, route, readiness, configuration };
  }
  function restart() { app.stop(); app = createServer({ port: 0, stateDir: root, machines: false, token: "fixture-owner", factory: { accountDiscoveryHome: root, accountTools: { github: { executable: process.execPath, args: [cli] } } } }); origin = `http://localhost:${app.port}`; }
  return { root, issue, save, post, get, json, setup, restart, headers, get origin() { return origin; }, close() { app.stop(); rmSync(root, { recursive: true, force: true }); } };
}
