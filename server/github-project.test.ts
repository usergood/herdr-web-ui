import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "./index.ts";

const roots: string[] = []; const apps: ReturnType<typeof createServer>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "saurons-github-http-")); roots.push(root);
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
if (endpoint === "user") result = { login: "fictional-owner", id: 1042 };
else if (endpoint?.includes("/issues?")) result = endpoint.includes("page=1&") ? data.issues : [];
else if (endpoint?.includes("/comments?")) result = endpoint.includes("page=1&") ? data.comments ?? [] : [];
else if (endpoint?.includes("/issues/") && !endpoint.includes("?")) result = data.issues.find(issue => endpoint.endsWith("/" + issue.number));
else if (endpoint === "graphql") result = { data: { repository: { viewerPermission: "ADMIN", pullRequests: { nodes: data.pulls, pageInfo: { hasNextPage: false, endCursor: null } }, pullRequest: data.pull ?? data.pulls[0] } } };
else if (endpoint?.endsWith("/merge")) result = { merged: !data.fail_merge, sha: "fictional-merged" };
else if (endpoint?.endsWith("/update-branch")) result = { message: "Updating pull request branch", url: "https://api.github.com/fictional/update" };
else if (endpoint?.endsWith("/rerequest")) result = { requested_reviewers: [{ login: "fictional-reviewer" }] };
else if (endpoint?.includes("/files?")) result = [{ filename: "src/example.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\\n-old\\n+new" }];
else result = {};
process.stdout.write(JSON.stringify(result));
`);
  const app = createServer({ port: 0, stateDir: root, token: "github-test-owner", machines: false, factory: { accountTools: { github: { executable: process.execPath, args: [tool] } } } }); apps.push(app);
  const headers = { authorization: "Bearer github-test-owner", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  const origin = `http://localhost:${app.port}`;
  const post = async (path: string, body: unknown) => { const response = await fetch(origin + "/api/factory" + path, { method: "POST", headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const get = async (path: string) => (await fetch(origin + "/api/factory" + path, { headers })).json();
  const profile = (await post("/machines/local/accounts", { name: "Fixture", service: "github", expected_login: "fictional-owner" })).body;
  expect((await post(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision })).status).toBe(200);
  const project = (await post("/projects", { name: "Fixture", path: repo, machine_id: "local", provider: "codex", tracker: "app" })).body;
  const policy = { expected_revision: null, repository: "fictional/project", account_profile_id: profile.id, sync_enabled: false, import_issues: true, import_fixes: true, auto_update: false, auto_merge: false, trusted_reviewers: ["fictional-reviewer"], required_checks: ["Fast checks"], review_context: "Follow Project standards and testing seams.", poll_minutes: 5 };
  return { app, root, state, log, project, policy, post, get, origin, headers };
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


test("Project triage roles inherit defaults, override individually and keep implementation opt-in separate", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  let saved = await f.post(route + "/configure", f.policy);
  expect(saved.status).toBe(200);
  expect(saved.body.triage_labels).toEqual({ "needs-triage": "needs-triage", "needs-info": "needs-info", "ready-for-agent": "ready-for-agent", "ready-for-human": "ready-for-human", wontfix: "wontfix" });
  expect(saved.body.auto_implement).toBe(false);
  expect(saved.body.trusted_issue_approvers).toEqual([]);
  saved = await f.post(route + "/configure", { ...f.policy, expected_revision: saved.body.revision, triage_labels: { "ready-for-agent": "factory-ready" }, auto_implement: true, trusted_issue_approvers: ["fictional-maintainer", "fictional-bot[bot]"] });
  expect(saved.status).toBe(200);
  expect(saved.body.triage_labels["ready-for-agent"]).toBe("factory-ready");
  expect(saved.body.triage_labels["needs-info"]).toBe("needs-info");
  expect(saved.body.auto_implement).toBe(true);
  expect(saved.body.auto_merge).toBe(false);
  const rejected = await f.post(route + "/configure", { ...f.policy, expected_revision: saved.body.revision, triage_labels: { "ready-for-agent": "needs-info" } });
  expect(rejected.status).toBe(400);
  expect(rejected.body.error.code).toBe("invalid_github_policy");
});


test("mapped triage roles expose why imported issues need planning or approval without starting agents", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", { ...f.policy, triage_labels: { "ready-for-agent": "factory-ready" }, auto_implement: true });
  const base = JSON.parse(readFileSync(f.state, "utf8")).issues[0];
  for (const [labels, roles, reason] of [
    [[], [], "start_planning"],
    [["ready-for-agent"], [], "start_planning"],
    [["needs-info"], ["needs-info"], "start_planning"],
    [["ready-for-human"], ["ready-for-human"], "human_only"],
    [["wontfix"], ["wontfix"], "wontfix"],
    [["factory-ready", "needs-triage"], ["needs-triage", "ready-for-agent"], "conflicting_triage"],
    [["factory-ready"], ["ready-for-agent"], "approval_required"],
  ] as const) {
    writeFileSync(f.state, JSON.stringify({ issues: [{ ...base, labels: labels.map(name => ({ name })) }], pulls: [] }));
    const synced = await f.post(route + "/sync", {}); expect(synced.status).toBe(200);
    const source = synced.body.sources[0];
    expect(source.triage_roles).toEqual(roles);
    expect(source.readiness.eligible).toBe(false);
    expect(source.readiness.reasons).toContain(reason);
  }
  const overview = await f.get(""); expect(overview.implementations).toHaveLength(1);
  expect(overview.implementations[0].stage).toBe("inbox");
  expect((await f.get(`/implementations/${overview.implementations[0].id}`)).runs).toHaveLength(0);
});


test("owner readiness freezes the current issue scope and planning decisions without dispatch", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.issues[0].labels = [{ name: "ready-for-agent" }];
  writeFileSync(f.state, JSON.stringify(data));
  const policy = (await f.post(route + "/configure", f.policy)).body;
  const source = (await f.post(route + "/sync", {})).body.sources[0];
  const plan = { acceptance_criteria: "Owner notes survive repeated import.", dependencies: [{ repository: "fictional/project", issue_number: 8, requires: "merge" }], testing_seams: ["Public HTTP with disposable native fixtures"], planning_decisions: ["Use one Assignment per issue"] };
  const proof = { policy_revision: policy.revision, issue_revision: source.revision, plan };
  const approved = await f.post(route + "/issues/12/approve", proof);
  expect(approved.status).toBe(200);
  const readiness = approved.body.sources[0].readiness;
  expect(readiness.approval.plan).toEqual(plan);
  expect(readiness.approval.issue_revision).toBe(source.revision);
  expect(readiness.approval.actor).toBe("owner");
  expect(readiness.approval.policy_revision).toBe(policy.revision);
  expect(readiness.eligible).toBe(false);
  expect(readiness.reasons).toEqual(["automatic_implementation_disabled"]);
  const resynced = (await f.post(route + "/sync", {})).body;
  expect(resynced.sources[0].readiness.approval.id).toBe(readiness.approval.id);
  expect((await f.get(`/implementations/${source.implementation_id}`)).runs).toHaveLength(0);
  data.issues[0].body = "Changed acceptance"; writeFileSync(f.state, JSON.stringify(data));
  const stale = await f.post(route + "/issues/12/approve", proof);
  expect(stale.status).toBe(409); expect(stale.body.error.code).toBe("github_issue_changed");
  expect((await f.get(route)).sources[0].readiness.eligible).toBe(false);
});


test("only a trusted GitHub actor approving the exact issue scope and complete plan grants eligibility", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const plan = { acceptance_criteria: "Keep owner notes", dependencies: [], testing_seams: ["Public HTTP"], planning_decisions: [] };
  const issue = { ...JSON.parse(readFileSync(f.state, "utf8")).issues[0], labels: [{ name: "ready-for-agent" }], updated_at: "2026-10-14T12:00:00Z" };
  const policy = (await f.post(route + "/configure", { ...f.policy, auto_implement: true, trusted_issue_approvers: ["fictional-maintainer"] })).body;
  writeFileSync(f.state, JSON.stringify({ issues: [issue], pulls: [] }));
  const source = (await f.post(route + "/sync", {})).body.sources[0];
  const comment = { id: 1234, user: { login: "fictional-maintainer" }, body: "```saurons-eye-readiness\n" + JSON.stringify({ issue_revision: source.revision, plan }) + "\n```" };
  for (const comments of [[{ ...comment, user: { login: "unknown-contributor" } }], [{ ...comment, body: "```saurons-eye-readiness\n" + JSON.stringify({ issue_revision: "another-scope", plan }) + "\n```" }]]) {
    writeFileSync(f.state, JSON.stringify({ issues: [issue], comments, pulls: [] }));
    const result = await f.post(route + "/sync", {}); expect(result.status).toBe(200);
    expect(result.body.sources[0].readiness.eligible).toBe(false);
  }
  writeFileSync(f.state, JSON.stringify({ issues: [issue], comments: [comment], pulls: [] }));
  const result = await f.post(route + "/sync", {}); expect(result.status).toBe(200);
  expect(result.body.sources[0].readiness.eligible).toBe(true);
  expect(result.body.sources[0].readiness.approval).toMatchObject({ actor: "fictional-maintainer", origin: "github_comment", evidence_id: "1234", issue_revision: source.revision, policy_revision: policy.revision, plan });
  expect((await f.get(`/implementations/${source.implementation_id}`)).runs).toHaveLength(0);
  // A source author can edit within GitHub's one-second timestamp resolution. The digest must change.
  issue.body = "Broader acceptance at the same timestamp";
  writeFileSync(f.state, JSON.stringify({ issues: [issue], comments: [comment], pulls: [] }));
  expect((await f.post(route + "/sync", {})).body.sources[0].readiness.eligible).toBe(false);
});

test("a ready label and external plan prose cannot substitute for trusted approval", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", { ...f.policy, auto_implement: true });
  const plan = { acceptance_criteria: "Preserve owner notes", dependencies: [], testing_seams: ["Public HTTP"], planning_decisions: [] };
  const block = "```saurons-eye-plan\n" + JSON.stringify(plan) + "\n```";
  const base = { ...JSON.parse(readFileSync(f.state, "utf8")).issues[0], labels: [{ name: "ready-for-agent" }], updated_at: "2026-10-14T12:00:00Z" };
  const event = { id: 1234, event: "labeled", label: { name: "ready-for-agent" }, actor: { login: "fictional-owner" }, created_at: "2026-10-14T12:00:00Z" };
  for (const body of ["Acceptance is not a testing approval", "```saurons-eye-plan\n{}\n```", block + "\n" + block]) {
    writeFileSync(f.state, JSON.stringify({ issues: [{ ...base, body }], events: [event], pulls: [] }));
    const result = await f.post(route + "/sync", {}); expect(result.status).toBe(200);
    expect(result.body.sources[0].readiness.eligible).toBe(false);
  }
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
