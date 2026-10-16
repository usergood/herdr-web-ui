/** Owned GitHub CLI/repository fixture shared by public HTTP and browser journeys. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "../server/index.ts";

export async function githubFixture() {
  const root = mkdtempSync(join(tmpdir(), "saurons-github-http-"));
  const repo = join(root, "repo"); execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# Fictional Project\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/fictional/project.git"]);
  const state = join(root, "responses.json"); const log = join(root, "calls.jsonl");
  writeFileSync(state, JSON.stringify({ issues: [{ number: 12, node_id: "fictional-issue-12", title: "Import this ticket", body: "Acceptance: keep my notes", html_url: "https://github.com/fictional/project/issues/12", state: "open" }], pulls: [] }));
  const tool = join(root, "gh.mjs");
  writeFileSync(tool, `import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2); const data = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, scoped: Boolean(process.env.GH_CONFIG_DIR), token: process.env.GITHUB_TOKEN ?? null}) + "\\n");
let result; const endpoint = args[1];
const users = readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").map((line) => JSON.parse(line)).filter((call) => call.args[1] === "user").length;
if (endpoint === "graphql" && data.pause || endpoint === "user" && data.pause_user === users) {
  writeFileSync(${JSON.stringify(join(root, "reading"))}, "reading");
  const deadline = Date.now() + 5000;
  while (!existsSync(${JSON.stringify(join(root, "continue"))}) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}
if (endpoint === "user" && data.offline_identity) process.exit(1);
if (endpoint === "user") result = { login: data.login ?? "fictional-owner", id: data.account_id ?? 1042 };
else if (endpoint?.includes("/issues?")) result = endpoint.includes("page=1&") ? data.issues : [];
else if (endpoint === "graphql" && args.some(a => a.includes("deleteIssue("))) {
  const query = args.find(a => a.startsWith("query="));
  if (data.deny_delete) {
    process.stdout.write(JSON.stringify({ data: { deleteIssue: null }, errors: [{ type: "FORBIDDEN", message: "untrusted diagnostic" }] })); process.exit(1);
  }
  const issueId = JSON.parse(query.match(/issueId:("[^" ]+")/)[1]);
  data.issues = data.issues.filter(issue => issue.node_id !== issueId);
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(data));
  if (data.lose_delete) process.exit(1);
  result = { data: { deleteIssue: { clientMutationId: data.ambiguous_delete ? "unrelated-receipt" : JSON.parse(query.match(/clientMutationId:("[^" ]+")/)?.[1] ?? 'null'), repository: { id: "fictional-repo", nameWithOwner: "fictional/project" } } } };
}
else if (endpoint === "graphql" && args.some(a => a.includes("issues(first:"))) result = { data: { repository: { id: "fictional-repo", nameWithOwner: "fictional/project", viewerPermission: data.permission ?? "ADMIN", issues: { nodes: (data.paginate ? args.some(a => a.includes('after:"older"')) ? data.issues.slice(100) : data.issues.slice(0, 100) : data.issues).map(i => data.incomplete_inventory ? {} : ({ id: i.node_id, number: i.number })), pageInfo: { hasNextPage: !!data.paginate && !args.some(a => a.includes('after:"older"')), endCursor: "older" } } } } };
else if (endpoint === "graphql") result = { data: { repository: { viewerPermission: "ADMIN", pullRequests: { nodes: data.pulls, pageInfo: { hasNextPage: false, endCursor: null } }, pullRequest: data.pull ?? data.pulls[0] } } };
else if (endpoint?.endsWith("/merge")) result = { merged: !data.fail_merge, sha: "fictional-merged" };
else if (endpoint?.endsWith("/update-branch")) result = { message: "Updating pull request branch", url: "https://api.github.com/fictional/update" };
else if (endpoint?.endsWith("/rerequest")) result = { requested_reviewers: [{ login: "fictional-reviewer" }] };
else if (endpoint?.includes("/files?")) result = [{ filename: "src/example.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\\n-old\\n+new" }];
else result = {};
process.stdout.write(JSON.stringify(result));
`);
  const options: Parameters<typeof createServer>[0] = { port: 0, stateDir: root, token: "github-test-owner", machines: false, factory: { accountTools: { github: { executable: process.execPath, args: [tool] } } } };
  let app = createServer(options);
  const headers = { authorization: "Bearer github-test-owner", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  let origin = `http://localhost:${app.port}`;
  const restart = () => { app.stop(); app = createServer(options); origin = `http://localhost:${app.port}`; };
  const post = async (path: string, body: unknown) => { const response = await fetch(origin + "/api/factory" + path, { method: "POST", headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const get = async (path: string) => (await fetch(origin + "/api/factory" + path, { headers })).json();
  const profile = (await post("/machines/local/accounts", { name: "Fixture", service: "github", expected_login: "fictional-owner" })).body;
  assert.equal((await post(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision })).status, 200);
  const project = (await post("/projects", { name: "Fixture", path: repo, machine_id: "local", provider: "codex", tracker: "app" })).body;
  const policy = { expected_revision: null, repository: "fictional/project", account_profile_id: profile.id, sync_enabled: false, import_issues: true, import_fixes: true, auto_update: false, auto_merge: false, trusted_reviewers: ["fictional-reviewer"], required_checks: ["Fast checks"], review_context: "Follow Project standards and testing seams.", poll_minutes: 5 };
  const close = () => { app.stop(); rmSync(root, { recursive: true, force: true }); };
  return { close, get app() { return app; }, root, state, log, project, policy, post, get, restart, get origin() { return origin; }, headers };
}
