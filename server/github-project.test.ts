import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "./index.ts";

const roots: string[] = []; const apps: ReturnType<typeof createServer>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(remoteOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "saurons-github-http-")); roots.push(root);
  const repo = join(root, "repo"); execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# Fictional Project\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/fictional/project.git"]);
  const state = join(root, "responses.json"); const log = join(root, "calls.jsonl");
  writeFileSync(state, JSON.stringify({ issues: [{ number: 12, node_id: "fictional-issue-12", title: "Import this ticket", body: "Acceptance: keep my notes", html_url: "https://github.com/fictional/project/issues/12", state: "open", labels: [{ name: "needs-plan" }], updated_at: "2026-10-01T12:00:00Z" }], pulls: [] }));
  const tool = join(root, "gh.mjs");
  writeFileSync(tool, `import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2); const data = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, scoped: Boolean(process.env.GH_CONFIG_DIR), token: process.env.GITHUB_TOKEN ?? null}) + "\\n");
let result; const endpoint = args[1];
const issue = Array.isArray(data.issues) ? data.issues[0] : null;
const issueProof = issue ? { id: issue.node_id, title: issue.title, body: issue.body ?? "", state: issue.state.toUpperCase(), createdAt: "2026-09-30T12:00:00Z", updatedAt: issue.updated_at, lastEditedAt: data.last_edited_at ?? null } : null;
const users = readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").map((line) => JSON.parse(line)).filter((call) => call.args[1] === "user").length;
if (endpoint === "graphql" && data.pause || endpoint === "user" && data.pause_user === users) {
  writeFileSync(${JSON.stringify(join(root, "reading"))}, "reading");
  const deadline = Date.now() + 5000;
  while (!existsSync(${JSON.stringify(join(root, "continue"))}) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}
if (endpoint === "user") result = { login: "fictional-owner", id: 1042 };
else if (endpoint?.includes("/events?")) result = data.events ?? [];
else if (endpoint?.match(/issues[/][0-9]+$/)) result = data.issues.find(issue => endpoint.endsWith("/" + issue.number));
else if (endpoint?.includes("/issues?")) result = data.pages ? data.pages[Number(new URL("https://api.github.invalid/" + endpoint).searchParams.get("page")) - 1] : endpoint.includes("page=1&") ? data.issues : [];
else if (endpoint === "repos/fictional/project") result = { full_name: "fictional/project" };
else if (endpoint === "graphql") result = { data: { repository: { issue: issueProof, viewerPermission: "ADMIN", pullRequests: { nodes: data.pulls, pageInfo: { hasNextPage: false, endCursor: null } }, pullRequest: data.pull ?? data.pulls[0] } } };
else if (endpoint?.endsWith("/merge")) result = { merged: !data.fail_merge, sha: "fictional-merged" };
else if (endpoint?.endsWith("/update-branch")) result = { message: "Updating pull request branch", url: "https://api.github.com/fictional/update" };
else if (endpoint?.endsWith("/rerequest")) result = { requested_reviewers: [{ login: "fictional-reviewer" }] };
else if (endpoint?.includes("/files?")) result = [{ filename: "src/example.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\\n-old\\n+new" }];
else result = {};
process.stdout.write(JSON.stringify(result));
`);
  const remote = remoteOnly ? createServer({ port: 0, stateDir: join(root, "remote-state"), machines: false, token: "fixture-remote", factory: { accountDiscoveryHome: root } }) : null;
  if (remote) apps.push(remote);
  const options: Parameters<typeof createServer>[0] = { port: 0, stateDir: root, token: "github-test-owner", machines: false, factory: { accountDiscoveryHome: root, machineEndpoint: (id) => id === "fixture-remote" && remote ? { url: `http://localhost:${remote.port}`, token: "fixture-remote" } : undefined, accountTools: { github: { executable: process.execPath, args: [tool] } } } };
  let app = createServer(options); apps.push(app);
  const headers = { authorization: "Bearer github-test-owner", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  let origin = `http://localhost:${app.port}`;
  const post = async (path: string, body: unknown) => { const response = await fetch(origin + "/api/factory" + path, { method: "POST", headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const get = async (path: string) => (await fetch(origin + "/api/factory" + path, { headers })).json();
  const profile = (await post("/machines/local/accounts", { name: "Fixture", service: "github", expected_login: "fictional-owner" })).body;
  expect((await post(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision })).status).toBe(200);
  const project = (await post("/projects", { name: "Fixture", path: repo, machine_id: remoteOnly ? "fixture-remote" : "local", provider: "codex", tracker: "app" })).body;
  const policy = { expected_revision: null, repository: "fictional/project", account_profile_id: profile.id, sync_enabled: false, import_issues: true, import_fixes: true, auto_update: false, auto_merge: false, trusted_reviewers: ["fictional-reviewer"], required_checks: ["Fast checks"], review_context: "Follow Project standards and testing seams.", poll_minutes: 5 };
  return { app, root, repo, state, log, project, policy, post, get, origin, headers, restart() { app.stop(); apps.splice(apps.indexOf(app), 1); app = createServer(options); apps.push(app); origin = `http://localhost:${app.port}`; } };
}

test("scoped GitHub tickets arrive once in Inbox while owner notes survive later synchronization", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  expect((await f.post(route + "/configure", f.policy)).status).toBe(200);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const overview = await f.get(""); expect(overview.implementations).toHaveLength(1);
  const idea = overview.implementations[0]; expect(idea.project_id).toBe(f.project.id); expect(idea.stage).toBe("inbox");
  expect(idea.description).toContain("Acceptance: keep my notes");
  const detail = await f.get(`/implementations/${idea.id}`);
  expect((await f.post(`/implementations/${idea.id}/messages`, { chat_id: detail.chats[0].id, role: "owner", content: "My local decision" })).status).toBe(201);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  expect((await f.get("")).implementations).toHaveLength(1);
  expect((await f.get(`/implementations/${idea.id}`)).messages.some((message: { content: string }) => message.content === "My local decision")).toBe(true);
});

function connection<T>(nodes: T[]) { return { nodes, pageInfo: { hasNextPage: false, endCursor: null } }; }
function pull(state = "APPROVED") {
  return { number: 27, id: "fictional-pr-27", title: "Improve imports", body: "Fictional patch", url: "https://github.com/fictional/project/pull/27", state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), headRefName: "feature", baseRefName: "main", author: { login: "fictional-owner" }, headRepository: { nameWithOwner: "fictional/project" }, viewerCanUpdate: true, mergeStateStatus: "CLEAN", reviewDecision: state === "APPROVED" ? "APPROVED" : "CHANGES_REQUESTED",
    reviews: connection([{ id: "review-1", state, body: "Please validate the acceptance cases", submittedAt: "2026-10-11T12:00:00Z", author: { login: "fictional-reviewer" }, commit: { oid: "a".repeat(40) } }]), reviewRequests: connection([]), reviewThreads: connection([]),
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: connection([{ name: "Fast checks", status: "COMPLETED", conclusion: "SUCCESS" }]) } } }] },
    baseRef: { branchProtectionRule: { isAdminEnforced: true, requiresApprovingReviews: true, requiredApprovingReviewCount: 1, requiresStatusChecks: true, requiresStrictStatusChecks: true, requiresConversationResolution: true, requiredStatusCheckContexts: ["Fast checks"] } } };
}
test("requested changes queue one factory Implementation with Project rules; pending review creates no fixes", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const pending = pull("PENDING"); writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pending] }));
  expect((await f.post(route + "/configure", f.policy)).status).toBe(200);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  expect((await f.get("")).implementations).toHaveLength(0);
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pull("CHANGES_REQUESTED")] }));
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const ideas = (await f.get("")).implementations; expect(ideas).toHaveLength(1);
  expect(ideas[0].description).toContain("Please validate the acceptance cases"); expect(ideas[0].description).toContain("Follow Project standards and testing seams.");
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  expect((await f.get("")).implementations).toHaveLength(1);
});
test("guarded merges require current approval and validators, and never retry an already confirmed head", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const pr = pull(); writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr] }));
  const policy = (await f.post(route + "/configure", f.policy)).body;
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const proof = { head: pr.headRefOid, base: pr.baseRefOid, policy_revision: policy.revision };
  pr.reviewThreads.nodes = [{ id: "unresolved", isResolved: false, isOutdated: true, comments: connection([{ body: "Fix this", path: "src/file.ts", author: { login: "fictional-reviewer" } }]) }] as never;
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr] }));
  expect((await f.post(route + "/pulls/27/merge", proof)).status).toBe(409);
  expect(readFileSync(f.log, "utf8")).not.toContain('"PUT"');
  pr.reviewThreads.nodes = []; writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr] }));
  expect((await f.post(route + "/pulls/27/merge", proof)).status).toBe(200);
  expect((await f.post(route + "/pulls/27/merge", proof)).status).toBe(200);
  const calls = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const merges = calls.filter((call) => call.args[1]?.endsWith("/merge")); expect(merges).toHaveLength(1);
  expect(merges[0].args).toContain("sha=" + pr.headRefOid);
  expect(merges[0].scoped).toBe(true); expect(merges[0].token).toBeNull();
});
test("behind branches use a guarded update and re-review requires a new head", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const pr = pull("CHANGES_REQUESTED"); pr.mergeStateStatus = "BEHIND";
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr] }));
  const policy = (await f.post(route + "/configure", { ...f.policy, auto_update: true })).body;
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const updates = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((call) => call.args[1]?.endsWith("/update-branch"));
  expect(updates).toHaveLength(1); expect(updates[0].args).toContain("expected_head_sha=" + pr.headRefOid);
  const proof = { head: pr.headRefOid, base: pr.baseRefOid, policy_revision: policy.revision };
  expect((await f.post(route + "/pulls/27/rerequest", proof)).status).toBe(409);
  pr.headRefOid = "c".repeat(40); pr.mergeStateStatus = "BLOCKED";
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr] }));
  expect((await f.post(route + "/pulls/27/rerequest", { ...proof, head: pr.headRefOid })).status).toBe(200);
});
test("closed historical issues do not create new work, while imported issue closures remain visible", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.issues[0].state = "closed";
  writeFileSync(f.state, JSON.stringify(data)); expect((await f.post(route + "/configure", f.policy)).status).toBe(200);
  expect((await f.post(route + "/sync", {})).status).toBe(200); expect((await f.get("")).implementations).toHaveLength(0);
  data.issues[0].state = "open"; writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  data.issues[0].state = "closed"; writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  expect((await f.get("")).implementations).toHaveLength(1); expect((await f.get(route)).sources[0].state).toBe("closed");
});
test("a Project account change interrupts an in-flight synchronization before importing or merging", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  expect((await f.post(route + "/configure", { ...f.policy, auto_merge: true })).status).toBe(200);
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pull()], pause: true }));
  const pending = f.post(route + "/sync", {});
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.root, "reading")) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(join(f.root, "reading"))).toBe(true);
  expect((await f.post(`/projects/${f.project.id}/configure`, { account_bindings: { local: { github: f.policy.account_profile_id } } })).status).toBe(200);
  writeFileSync(join(f.root, "continue"), "continue");
  expect((await pending).status).toBe(409);
  expect((await f.get("")).implementations).toHaveLength(0); expect(readFileSync(f.log, "utf8")).not.toContain('"PUT"');
});
test("uncertain merge intent survives a policy edit and cannot be retried blindly", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`; const pr = pull();
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr], fail_merge: true }));
  let policy = (await f.post(route + "/configure", f.policy)).body;
  expect((await f.post(route + "/pulls/27/merge", { head: pr.headRefOid, base: pr.baseRefOid, policy_revision: policy.revision })).status).toBe(409);
  expect((await f.get(route)).mutations[0].condition).toBe("uncertain");
  policy = (await f.post(route + "/configure", { ...f.policy, expected_revision: policy.revision, review_context: "Updated rules" })).body;
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr] }));
  expect((await f.post(route + "/pulls/27/merge", { head: pr.headRefOid, base: pr.baseRefOid, policy_revision: policy.revision })).status).toBe(409);
  const merges = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((call) => call.args[1]?.endsWith("/merge")); expect(merges).toHaveLength(1);
});
test("normal GitHub descriptions larger than an identity response can be imported", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`; const data = JSON.parse(readFileSync(f.state, "utf8"));
  data.issues[0].body = "Documented acceptance. ".repeat(4000); writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(route + "/configure", f.policy)).status).toBe(200);
  expect((await f.post(route + "/sync", {})).status).toBe(200); expect((await f.get("")).implementations[0].description).toContain("Documented acceptance.");
});
test("stale approvals, missing admin protection, failing checks and incomplete snapshots all block merge", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`; const policy = (await f.post(route + "/configure", f.policy)).body;
  for (const change of [
    (pr: ReturnType<typeof pull>) => { pr.reviews.nodes[0]!.commit.oid = "c".repeat(40); },
    (pr: ReturnType<typeof pull>) => { pr.baseRef.branchProtectionRule.isAdminEnforced = false; },
    (pr: ReturnType<typeof pull>) => { pr.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes[0]!.conclusion = "FAILURE"; },
    (pr: ReturnType<typeof pull>) => { pr.reviewThreads.pageInfo.hasNextPage = true; },
  ]) {
    const pr = pull(); change(pr); writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr] }));
    expect((await f.post(route + "/pulls/27/merge", { head: pr.headRefOid, base: pr.baseRefOid, policy_revision: policy.revision })).status).toBe(409);
  }
  expect(readFileSync(f.log, "utf8")).not.toContain('"PUT"');
});
test("account drift during the last native identity check cannot send a remote merge", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`; const pr = pull();
  const policy = (await f.post(route + "/configure", f.policy)).body;
  const users = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((call) => call.args[1] === "user").length;
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr], pause_user: users + 4 }));
  const pending = f.post(route + "/pulls/27/merge", { head: pr.headRefOid, base: pr.baseRefOid, policy_revision: policy.revision });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.root, "reading")) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(join(f.root, "reading"))).toBe(true);
  expect((await f.post(`/projects/${f.project.id}/configure`, { account_bindings: { local: { github: f.policy.account_profile_id } } })).status).toBe(200);
  writeFileSync(join(f.root, "continue"), "continue");
  expect((await pending).status).toBe(409); expect(readFileSync(f.log, "utf8")).not.toContain('"PUT"');
});
test("the owner can read a foreign PR patch centrally, bound to the displayed head", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`; const pr = pull(); pr.author.login = "fictional-contributor";
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr] })); expect((await f.post(route + "/configure", f.policy)).status).toBe(200);
  const response = await fetch(f.origin + "/api/factory" + route + "/pulls/27/files?head=" + pr.headRefOid, { headers: f.headers });
  expect(response.status).toBe(200); expect((await response.json()).files[0].patch).toContain("+new");
  const stale = await fetch(f.origin + "/api/factory" + route + "/pulls/27/files?head=" + "c".repeat(40), { headers: f.headers }); expect(stale.status).toBe(409);
  expect(readFileSync(f.log, "utf8")).not.toContain('"PUT"');
});
test("GitHub settings work behind the owner's HTTPS proxy and reject a foreign origin", async () => {
  const f = await fixture(); const url = f.origin + `/api/factory/projects/${f.project.id}/github/configure`;
  const proxy = { ...f.headers, origin: f.origin.replace("http:", "https:"), "x-forwarded-proto": "https" };
  const accepted = await fetch(url, { method: "POST", headers: proxy, body: JSON.stringify(f.policy) }); expect(accepted.status).toBe(200);
  const refused = await fetch(url, { method: "POST", headers: { ...proxy, origin: "https://unrelated.invalid" }, body: JSON.stringify(f.policy) }); expect(refused.status).toBe(403);
});


test("Assignment source history retains edited issue scope separately from owner notes", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  expect((await f.post(route + "/configure", f.policy)).status).toBe(200);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const first = (await f.get(route)).sources[0];
  const detail = await f.get(`/implementations/${first.implementation_id}`);
  await f.post(`/implementations/${first.implementation_id}/messages`, { chat_id: detail.chats[0].id, role: "owner", content: "Keep my personal decision" });
  const data = JSON.parse(readFileSync(f.state, "utf8"));
  Object.assign(data.issues[0], { title: "Revised source title", body: "Acceptance: revised scope", labels: [{ name: "ready-for-agent" }], updated_at: "2026-10-02T12:00:00Z" });
  writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const current = (await f.get(`/implementations/${first.implementation_id}`)).github_sources[0];
  expect(current.id).toBe(first.id);
  expect(current.current).toMatchObject({ title: "Revised source title", body: "Acceptance: revised scope", labels: ["ready-for-agent"], state: "open", source_updated_at: "2026-10-02T12:00:00Z", repository: "fictional/project", account_profile_id: f.policy.account_profile_id });
  expect(current.history.map((entry: { title: string }) => entry.title)).toEqual(["Import this ticket", "Revised source title"]);
  expect(current.history[0].revision).not.toBe(current.current.revision);
  expect(Number.isFinite(Date.parse(current.current.fetched_at))).toBe(true);
  const after = await f.get(`/implementations/${first.implementation_id}`);
  expect(after.implementation.description).toBe(detail.implementation.description);
  expect(after.messages.some((message: { content: string }) => message.content === "Keep my personal decision")).toBe(true);
  expect(after.runs).toEqual([]);
});


test("an incomplete or malformed issue inventory preserves the last complete source state", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const before = await f.get(route); const original = JSON.parse(readFileSync(f.state, "utf8")).issues[0];
  for (const pages of [
    [Array.from({ length: 30 }, (_, index) => ({ ...original, number: index + 100, node_id: `fictional-${index}` })), { error: "Incomplete page" }],
    [[{ ...original, title: "Uncommitted source change" }, { ...original, number: 900, node_id: "fictional-broken", labels: null }]],
  ]) {
    writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [], pages }));
    expect((await f.post(route + "/sync", {})).status).toBe(409);
    const after = await f.get(route);
    expect(after.sources).toEqual(before.sources);
    expect(after.last_sync).toBe(before.last_sync);
    expect(after.problem).toBeTruthy();
    expect((await f.get("")).implementations).toHaveLength(1);
  }
  writeFileSync(f.state, JSON.stringify({ issues: [original], pulls: [] }));
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  expect((await f.get(route)).problem).toBeNull();
});


test("concurrent sync and restart retain one Assignment through closure and reopening", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.pause = true; writeFileSync(f.state, JSON.stringify(data));
  const pending = f.post(route + "/sync", {}); const deadline = Date.now() + 5000;
  while (!existsSync(join(f.root, "reading")) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(join(f.root, "reading"))).toBe(true);
  expect((await f.post(route + "/sync", {})).status).toBe(409);
  writeFileSync(join(f.root, "continue"), "continue"); expect((await pending).status).toBe(200);
  const source = (await f.get(route)).sources[0];
  f.restart();
  data.pause = false; data.issues[0].state = "closed"; writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const closed = (await f.get(`/implementations/${source.implementation_id}`));
  expect(closed.implementation.stage).toBe("inbox"); expect(closed.implementation.outcome).toBe("none");
  expect(closed.github_sources[0].history.map((entry: { state: string }) => entry.state)).toEqual(["open", "closed"]);
  data.issues[0].state = "open"; writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const reopened = (await f.get(route)).sources[0];
  expect(reopened.id).toBe(source.id); expect(reopened.implementation_id).toBe(source.implementation_id);
  expect(reopened.history.map((entry: { state: string }) => entry.state)).toEqual(["open", "closed", "open"]);
  expect((await f.get("")).implementations).toHaveLength(1);
});


test("remote-only Projects retain issue sources and refuse checkout drift", async () => {
  const f = await fixture(true); const route = `/projects/${f.project.id}/github`;
  expect((await f.post(route + "/configure", f.policy)).status).toBe(200);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const before = await f.get(route);
  expect(before.sources[0].current.repository).toBe("fictional/project");
  execFileSync("git", ["-C", f.repo, "remote", "set-url", "origin", "https://github.com/fictional/different.git"]);
  expect((await f.post(route + "/sync", {})).status).toBe(409);
  const after = await f.get(route);
  expect(after.sources).toEqual(before.sources);
  expect(after.last_sync).toBe(before.last_sync); expect(after.problem).toBeTruthy();
});

test("readiness trusts only the owner's explicitly selected account independently of PR reviewers", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  expect((await f.get(route)).readiness_policy).toBeNull();
  const configured = await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  expect(configured.status).toBe(200);
  expect(configured.body.owner).toEqual({ login: "fictional-owner", account_id: "1042", auth_method: "oauth" });
  expect(configured.body.triage_labels).toEqual({ "needs-triage": "needs-triage", "needs-info": "needs-info", "ready-for-agent": "ready-for-agent", "ready-for-human": "ready-for-human", wontfix: "wontfix" });
  f.restart();
  const view = await f.get(route);
  expect(view.readiness_policy.owner.login).toBe("fictional-owner");
  expect(view.policy.trusted_reviewers).toEqual(["fictional-reviewer"]);
  expect((await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" })).status).toBe(409);
});

test("Project triage mappings explain non-ready, conflicting and blocked issue scopes", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  const labels = { "needs-triage": "evaluate", "needs-info": "question", "ready-for-agent": "agent", "ready-for-human": "human", wontfix: "declined" };
  const configured = await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: labels, blocked_label: "waiting" });
  expect(configured.status).toBe(200);
  const data = JSON.parse(readFileSync(f.state, "utf8"));
  for (const [names, roles, reasons] of [
    [["evaluate"], ["needs-triage"], ["role_not_ready"]],
    [["question"], ["needs-info"], ["role_not_ready"]],
    [["human"], ["ready-for-human"], ["role_not_ready"]],
    [["declined"], ["wontfix"], ["role_not_ready"]],
    [["agent", "question"], ["needs-info", "ready-for-agent"], ["triage_conflict"]],
    [["agent", "waiting"], ["ready-for-agent"], ["blocked"]],
  ]) {
    data.issues[0].labels = names!.map(name => ({ name })); writeFileSync(f.state, JSON.stringify(data));
    const result = await f.post(route + "/sync", {}); expect(result.status).toBe(200);
    const source = result.body.sources[0];
    expect(source.readiness.roles).toEqual(roles);
    expect(source.readiness.eligible).toBe(false);
    for (const reason of reasons!) expect(source.readiness.blockers).toContain(reason);
    expect((await f.get(`/implementations/${source.implementation_id}`)).github_sources[0].readiness).toEqual(source.readiness);
  }
  await f.post(route + "/readiness", { expected_revision: configured.body.revision, account_profile_id: f.policy.account_profile_id, triage_labels: { ...labels, "needs-info": "agent" }, blocked_label: "waiting" });
  expect((await f.get(route)).sources[0].readiness.blockers).toContain("mapping_conflict");
});

function readinessEvent(id = 1, login = "fictional-owner", at = "2026-10-01T12:00:00Z") {
  return { id, event: "labeled", actor: { login, id: login === "fictional-owner" ? 1042 : 9999 }, label: { name: "ready-for-agent" }, created_at: at };
}

test("only current-scope trusted label evidence authorizes readiness and retains its provenance", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  const configured = await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.issues[0].labels = [{ name: "ready-for-agent" }]; data.events = [readinessEvent(1, "fictional-reviewer")];
  writeFileSync(f.state, JSON.stringify(data));
  let source = (await f.post(route + "/sync", {})).body.sources[0];
  expect(source.readiness.eligible).toBe(false); expect(source.readiness.blockers).toContain("untrusted");
  data.events = []; writeFileSync(f.state, JSON.stringify(data));
  source = (await f.post(route + "/sync", {})).body.sources[0];
  expect(source.readiness.blockers).toContain("evidence_missing");
  data.events = [readinessEvent()]; writeFileSync(f.state, JSON.stringify(data));
  source = (await f.post(route + "/sync", {})).body.sources[0];
  expect(source.readiness).toMatchObject({ eligible: true, blockers: [], roles: ["ready-for-agent"] });
  expect(source.readiness.approval).toMatchObject({ source_revision: source.revision, policy_revision: configured.body.revision, provenance: "github_label", actor: { login: "fictional-owner", account_id: "1042" }, event_id: "1" });
  f.restart(); expect((await f.get(route)).sources[0].readiness.approval).toEqual(source.readiness.approval);
  data.issues[0].body = "Scope: changed plan, acceptance, dependencies and testing seams"; data.issues[0].updated_at = "2026-10-02T12:00:00Z";
  writeFileSync(f.state, JSON.stringify(data));
  const changed = (await f.post(route + "/sync", {})).body.sources[0];
  expect(changed.readiness.eligible).toBe(false); expect(changed.readiness.blockers).toContain("stale");
  expect(changed.readiness_approvals).toContainEqual(source.readiness.approval);
  data.events.push(readinessEvent(2, "fictional-owner", "2026-10-02T12:00:00Z")); writeFileSync(f.state, JSON.stringify(data));
  const renewed = (await f.post(route + "/sync", {})).body.sources[0];
  expect(renewed.readiness.eligible).toBe(true); expect(renewed.readiness.approval.source_revision).toBe(changed.revision);
});

test("owner approval is explicit, revision-scoped and cannot bypass triage or stale evidence", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  const configured = await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.issues[0].labels = [{ name: "ready-for-agent" }]; data.events = [];
  writeFileSync(f.state, JSON.stringify(data));
  const source = (await f.post(route + "/sync", {})).body.sources[0];
  const proof = { source_revision: source.revision, policy_revision: configured.body.revision };
  expect((await f.post(route + "/issues/12/approve", { ...proof, source_revision: "old" })).status).toBe(409);
  expect((await f.post(route + "/issues/12/approve", proof)).status).toBe(200);
  let view = await f.get(route);
  expect(view.sources[0].readiness).toMatchObject({ eligible: true, approval: { provenance: "app_owner", actor: { login: "fictional-owner" }, source_revision: source.revision } });
  // Changed on GitHub after the displayed approval form loaded, before another sync.
  data.issues[0].body = "Different acceptance"; data.issues[0].updated_at = "2026-10-03T12:00:00Z";
  writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(route + "/issues/12/approve", proof)).status).toBe(409);
  view = (await f.post(route + "/sync", {})).body;
  expect(view.sources[0].readiness.eligible).toBe(false);
  const next = { ...proof, source_revision: view.sources[0].revision };
  expect((await f.post(route + "/issues/12/approve", next)).status).toBe(200);
  data.issues[0].labels = []; writeFileSync(f.state, JSON.stringify(data));
  view = (await f.post(route + "/sync", {})).body;
  expect(view.sources[0].readiness.blockers).toContain("role_not_ready");
  expect((await f.post(route + "/issues/12/approve", { ...next, source_revision: view.sources[0].revision })).status).toBe(409);
  data.issues[0].labels = [{ name: "ready-for-agent" }]; data.issues[0].state = "closed"; writeFileSync(f.state, JSON.stringify(data));
  view = (await f.post(route + "/sync", {})).body;
  expect(view.sources[0].readiness.blockers).toContain("closed");
  expect((await f.get(`/implementations/${source.implementation_id}`)).implementation.outcome).toBe("none");
  data.issues[0].state = "open"; data.events = { partial: true }; writeFileSync(f.state, JSON.stringify(data));
  view = (await f.post(route + "/sync", {})).body;
  expect(view.sources[0].readiness.blockers).toContain("evidence_incomplete");
  expect((await f.post(route + "/issues/12/approve", { ...next, source_revision: view.sources[0].revision })).status).toBe(409);
  expect((await f.get(`/implementations/${source.implementation_id}`)).runs).toHaveLength(0);
});

test("readiness fails closed through outages, policy changes and withdrawn label evidence", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  let configured = (await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" })).body;
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.issues[0].labels = [{ name: "ready-for-agent" }]; data.events = [readinessEvent()]; writeFileSync(f.state, JSON.stringify(data));
  let source = (await f.post(route + "/sync", {})).body.sources[0]; expect(source.readiness.eligible).toBe(true);
  data.events = []; writeFileSync(f.state, JSON.stringify(data));
  source = (await f.post(route + "/sync", {})).body.sources[0]; expect(source.readiness.eligible).toBe(false);
  data.events = [readinessEvent()]; writeFileSync(f.state, JSON.stringify(data));
  source = (await f.post(route + "/sync", {})).body.sources[0]; expect(source.readiness.eligible).toBe(true);
  data.issues = { partial: true }; writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(route + "/sync", {})).status).toBe(409);
  source = (await f.get(route)).sources[0]; expect(source.readiness.eligible).toBe(false); expect(source.readiness.blockers).toContain("sync_required");
  data.issues = [{ number: 12, node_id: source.external_id, title: source.current.title, body: source.current.body, labels: [{ name: "ready-for-agent" }], updated_at: source.current.source_updated_at, html_url: source.url, state: "open" }];
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  configured = (await f.post(route + "/readiness", { expected_revision: configured.revision, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "waiting" })).body;
  source = (await f.get(route)).sources[0]; expect(source.readiness.eligible).toBe(false); expect(source.readiness.blockers).toContain("sync_required");
  expect((await f.get(`/implementations/${source.implementation_id}`)).runs).toHaveLength(0);
});

test("an edit in the label's timestamp second cannot reuse its approval", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.issues[0].labels = [{ name: "ready-for-agent" }]; data.events = [readinessEvent()]; writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(route + "/sync", {})).body.sources[0].readiness.eligible).toBe(true);
  data.issues[0].body = "A later edit in the same second"; data.last_edited_at = "2026-10-01T12:00:00Z"; writeFileSync(f.state, JSON.stringify(data));
  const source = (await f.post(route + "/sync", {})).body.sources[0];
  expect(source.readiness.eligible).toBe(false); expect(source.readiness.blockers).toContain("stale");
});

test("later edit evidence invalidates retained approvals even when the visible issue text was restored", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  const readiness = (await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" })).body;
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.issues[0].labels = [{ name: "ready-for-agent" }]; data.events = [readinessEvent()]; writeFileSync(f.state, JSON.stringify(data));
  const approved = (await f.post(route + "/sync", {})).body.sources[0]; expect(approved.readiness.eligible).toBe(true);
  data.last_edited_at = "2026-10-01T12:00:00Z"; writeFileSync(f.state, JSON.stringify(data));
  const restored = (await f.post(route + "/sync", {})).body.sources[0];
  expect(restored.readiness.eligible).toBe(false); expect(restored.readiness.blockers).toContain("stale");
  expect((await f.post(route + "/issues/12/approve", { source_revision: restored.revision, policy_revision: readiness.revision })).status).toBe(200);
  data.events.push({ id: 2, event: "unlabeled", actor: { login: "fictional-owner", id: 1042 }, label: { name: "ready-for-agent" }, created_at: "2026-10-01T12:00:00Z" });
  data.events.push(readinessEvent(3, "fictional-reviewer")); writeFileSync(f.state, JSON.stringify(data));
  const relabeled = (await f.post(route + "/sync", {})).body.sources[0];
  expect(relabeled.readiness.eligible).toBe(false); expect(relabeled.readiness.blockers).toContain("untrusted");
});
