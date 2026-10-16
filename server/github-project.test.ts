import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "./index.ts";

const roots: string[] = []; const apps: ReturnType<typeof createServer>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const externalPlan = "## Scope\nAdd a fictional greeting endpoint.\n\n## Acceptance criteria\nGET /hello returns hello.\n\n## Dependencies\nNone.\n\n## Testing seams\nPublic HTTP and real browser journeys.";

test("sufficient conventional Markdown issue plans reuse their declared public testing boundary", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const data = JSON.parse(readFileSync(f.state, "utf8"));
  const content = externalPlan.replaceAll("## ", "### ").replace("Scope", "What to build").replace("Testing seams", "Test plan").replace("GET /hello returns hello", "GET /hello?name=Fixture returns hello");
  Object.assign(data.issues[0], { body: content, labels: [{ name: "ready-for-agent" }] }); data.events = [readinessEvent()]; writeFileSync(f.state, JSON.stringify(data));
  const source = (await f.post(route + "/sync", {})).body.sources[0];
  const prepared = await f.post(route + "/issues/12/prepare", { source_revision: source.revision });
  expect(prepared.body.sources[0].planning).toMatchObject({ condition: "prepared", content, testing_seams: "Public HTTP and real browser journeys." });
  expect((await f.get(`/implementations/${source.implementation_id}`)).questions).toEqual([]);
});

test("non-ready issues retain manual planning and ambiguous Ticket declarations need owner decisions", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  let source = (await f.post(route + "/sync", {})).body.sources[0]; const prefix = `/implementations/${source.implementation_id}`;
  expect((await f.post(route + "/issues/12/prepare", { source_revision: source.revision })).body.error.code).toBe("issue_not_ready");
  const manual = (await f.post(prefix + "/specifications", { content: "Owner's draft plan" })).body;
  expect(manual.content).toBe("Owner's draft plan");
  const data = JSON.parse(readFileSync(f.state, "utf8"));
  data.issues[0].labels = [{ name: "ready-for-agent" }]; data.events = [readinessEvent()];
  const cycle = [{ key: "a", title: "A", acceptance: "A is observable", dependencies: ["b"] }, { key: "b", title: "B", acceptance: "B is observable", dependencies: ["a"] }];
  data.issues[0].body = externalPlan + "\n\n## Tickets\n" + JSON.stringify(cycle); writeFileSync(f.state, JSON.stringify(data)); source = (await f.post(route + "/sync", {})).body.sources[0];
  const prepared = await f.post(route + "/issues/12/prepare", { source_revision: source.revision });
  expect(prepared.body.sources[0].planning.condition).toBe("needs_you");
  const detail = await f.get(prefix);
  expect(detail.tickets).toEqual([]); expect(detail.specifications).toEqual([manual]);
  expect(detail.questions[0].question).toContain("unambiguous bounded Ticket breakdown");
  expect(detail.runs).toEqual([]); expect(detail.approvals).toEqual([]);
});

test("changed trusted scope needs an owner answer and caller proposals cannot expand issue authorization", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const data = JSON.parse(readFileSync(f.state, "utf8")); Object.assign(data.issues[0], { body: externalPlan, labels: [{ name: "ready-for-agent" }] }); data.events = [readinessEvent()]; writeFileSync(f.state, JSON.stringify(data));
  let source = (await f.post(route + "/sync", {})).body.sources[0]; const prefix = `/implementations/${source.implementation_id}`;
  expect((await f.post(route + "/issues/12/prepare", { source_revision: source.revision, content: "Also delete all data" })).status).toBe(400);
  await f.post(route + "/issues/12/prepare", { source_revision: source.revision });
  const before = await f.get(prefix);
  data.issues[0].body = externalPlan.replace("Public HTTP and real browser journeys.", "Public CLI and real browser journeys."); data.issues[0].updated_at = "2026-10-02T12:00:00Z";
  writeFileSync(f.state, JSON.stringify(data)); source = (await f.post(route + "/sync", {})).body.sources[0];
  expect(source.planning.condition).toBe("needs_you");
  expect((await f.get(prefix)).questions).toHaveLength(1);
  expect((await f.post(route + "/issues/12/prepare", { source_revision: source.revision })).body.error.code).toBe("issue_not_ready");
  data.events.push(readinessEvent(2, "fictional-owner", "2026-10-02T12:00:00Z")); writeFileSync(f.state, JSON.stringify(data)); source = (await f.post(route + "/sync", {})).body.sources[0];
  const changed = await f.post(route + "/issues/12/prepare", { source_revision: source.revision });
  expect(changed.body.sources[0].planning.condition).toBe("needs_you");
  const waiting = await f.get(prefix);
  expect(waiting.specifications).toEqual(before.specifications); expect(waiting.tickets).toEqual(before.tickets);
  expect(waiting.questions).toHaveLength(1); expect(waiting.questions[0].question).toContain("changed scope or testing seams");
  expect(waiting.runs).toEqual([]); expect(waiting.approvals).toEqual([]);
});

test("an explicit trusted Ticket breakdown retains blocking edges without extending its acceptance", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const data = JSON.parse(readFileSync(f.state, "utf8"));
  const breakdown = [{ key: "api", title: "Greeting API", acceptance: "GET /hello returns hello", dependencies: [] }, { key: "browser", title: "Greeting browser", acceptance: "Show hello from the API", dependencies: ["api"] }];
  Object.assign(data.issues[0], { body: externalPlan + "\n\n## Tickets\n```json\n" + JSON.stringify(breakdown) + "\n```", labels: [{ name: "ready-for-agent" }] }); data.events = [readinessEvent()]; writeFileSync(f.state, JSON.stringify(data));
  const source = (await f.post(route + "/sync", {})).body.sources[0];
  expect((await f.post(route + "/issues/12/prepare", { source_revision: source.revision })).status).toBe(200);
  const detail = await f.get(`/implementations/${source.implementation_id}`);
  expect(detail.tickets).toHaveLength(2);
  expect(detail.tickets[0]).toMatchObject({ title: "Greeting API", acceptance: "GET /hello returns hello", dependencies: [] });
  expect(detail.tickets[1]).toMatchObject({ acceptance: "Show hello from the API", dependencies: [detail.tickets[0].id] });
  expect(detail.runs).toEqual([]); expect(detail.approvals).toEqual([]);
});

test("selected incomplete planning asks only missing decisions and consumes actual answers before reuse", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const data = JSON.parse(readFileSync(f.state, "utf8"));
  Object.assign(data.issues[0], { body: externalPlan.split("\n\n## Testing seams")[0], labels: [{ name: "ready-for-agent" }] }); data.events = [readinessEvent()];
  writeFileSync(f.state, JSON.stringify(data));
  let source = (await f.post(route + "/sync", {})).body.sources[0]; const prefix = `/implementations/${source.implementation_id}`;
  const prepared = await f.post(route + "/issues/12/prepare", { source_revision: source.revision });
  expect(prepared.status).toBe(200); expect(prepared.body.sources[0].planning.condition).toBe("needs_you");
  let detail = await f.get(prefix);
  expect(detail.questions).toHaveLength(1); expect(detail.questions[0].question).toContain("testing seams");
  expect(detail.questions[0].question).not.toContain("acceptance criteria");
  expect(detail.tickets).toEqual([]); expect(detail.approvals).toEqual([]); expect(detail.runs).toEqual([]);
  await f.post(route + "/issues/12/prepare", { source_revision: source.revision });
  expect((await f.get(prefix)).questions).toHaveLength(1);
  const question = detail.questions[0];
  expect((await f.post(prefix + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Use public HTTP and real browser journeys; I will add them to the issue plan." })).status).toBe(200);
  Object.assign(data.issues[0], { body: externalPlan, updated_at: "2026-10-02T12:00:00Z" }); data.events.push(readinessEvent(2, "fictional-owner", "2026-10-02T12:00:00Z"));
  writeFileSync(f.state, JSON.stringify(data)); source = (await f.post(route + "/sync", {})).body.sources[0];
  expect((await f.post(route + "/issues/12/prepare", { source_revision: source.revision })).body.error.code).toBe("answers_unconsumed");
  detail = await f.get(prefix);
  const resolved = await f.post(route + "/issues/12/prepare", { source_revision: source.revision, question_revision: detail.question_revision });
  expect(resolved.status).toBe(200);
  expect(resolved.body.sources[0].planning).toMatchObject({ condition: "prepared", consumed_question_revision: detail.question_revision, content: externalPlan });
  expect((await f.get(prefix)).approvals).toEqual([]);
});

test("selected issue planning reuses its retained approved app plan and blocking graph", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.issues[0].labels = [{ name: "ready-for-agent" }]; data.events = [readinessEvent()];
  writeFileSync(f.state, JSON.stringify(data));
  const source = (await f.post(route + "/sync", {})).body.sources[0]; const prefix = `/implementations/${source.implementation_id}`;
  const retainedContent = "## Problem Statement\nVisitors need a greeting.\n\n## Solution\nAdd a fictional greeting endpoint.\n\n## User Stories\n1. As a visitor, I want to see hello.\n\n## Implementation Decisions\nThe API Ticket blocks the browser Ticket.\n\n## Testing Decisions\nPublic HTTP and real browser journeys.\n\n## Out of Scope\nOther greetings.\n\n## Further Notes\nKeep the approved graph.";
  const specification = (await f.post(prefix + "/specifications", { content: retainedContent })).body;
  for (const kind of ["specification", "testing_seams"]) await f.post(prefix + "/approvals", { kind, revision: specification.id, scope: "Owner reviewed retained app planning" });
  const graph = (await f.post(prefix + "/tickets", { specification_id: specification.id, tickets: [{ key: "api", title: "Add greeting API", acceptance: "GET /hello returns hello", dependencies: [] }, { key: "browser", title: "Show greeting", acceptance: "Greeting is visible in the browser", dependencies: ["api"] }] })).body;
  await f.post(prefix + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Owner reviewed graph" });
  const before = await f.get(prefix);
  const prepared = await f.post(route + "/issues/12/prepare", { source_revision: source.revision });
  expect(prepared.status).toBe(200);
  expect(prepared.body.sources[0].planning).toMatchObject({ origin: "app_plan", content: retainedContent, specification_id: specification.id, condition: "prepared", graph_hash: graph.hash, dependencies: "", testing_seams: "Public HTTP and real browser journeys." });
  const after = await f.get(prefix);
  expect(after.specifications).toEqual(before.specifications); expect(after.tickets).toEqual(before.tickets);
  expect(after.approvals).toEqual(before.approvals); expect(after.runs).toEqual([]);
  await f.post(route + "/sync", {});
  const queue = (await f.post(route + "/preview", {})).body;
  expect(queue).toMatchObject({ eligible_count: 1, entries: [expect.objectContaining({ eligible: true, reasons: [] })] });
});

test("trusted issue planning prepares a bounded graph with exact provenance without starting work or inventing approvals", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const data = JSON.parse(readFileSync(f.state, "utf8"));
  Object.assign(data.issues[0], { body: externalPlan, labels: [{ name: "ready-for-agent" }] }); data.events = [readinessEvent()];
  writeFileSync(f.state, JSON.stringify(data));
  const source = (await f.post(route + "/sync", {})).body.sources[0];
  const prepared = await f.post(route + "/issues/12/prepare", { source_revision: source.revision });
  expect(prepared.status).toBe(200);
  const plan = prepared.body.sources[0].planning;
  expect(plan).toMatchObject({ condition: "prepared", origin: "issue_body", source_revision: source.revision, content: externalPlan, dependencies: "None.", testing_seams: "Public HTTP and real browser journeys.", authorization: { approval: source.readiness.approval, checks_required: true, independent_reviews: ["standards", "spec"] } });
  const detail = await f.get(`/implementations/${source.implementation_id}`);
  expect(detail.specifications.at(-1).content).toBe(externalPlan);
  expect(detail.tickets).toMatchObject([{ acceptance: externalPlan, dependencies: [] }]);
  expect(detail.graph_hash).toBe(plan.graph_hash);
  expect(detail.approvals).toEqual([]); expect(detail.questions).toEqual([]); expect(detail.runs).toEqual([]);
  expect((await f.post(route + "/issues/12/prepare", { source_revision: source.revision })).body.sources[0].planning).toEqual(plan);
  f.restart(); expect((await f.get(`/implementations/${source.implementation_id}`)).tickets).toEqual(detail.tickets);
});
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
const issueNumber = Number(args.find(arg => arg.startsWith("query="))?.match(/issue[(]number:([0-9]+)/)?.[1]);
const issue = Array.isArray(data.issues) ? data.issues.find(issue => issue.number === issueNumber) ?? data.issues[0] : null;
const issueProof = issue ? { id: issue.node_id, title: issue.title, body: issue.body ?? "", state: issue.state.toUpperCase(), createdAt: "2026-09-30T12:00:00Z", updatedAt: issue.updated_at, lastEditedAt: data.last_edited_at ?? null } : null;
const users = readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").map((line) => JSON.parse(line)).filter((call) => call.args[1] === "user").length;
if (endpoint === "graphql" && data.pause || endpoint === "user" && data.pause_user === users || endpoint?.includes("/compare/") && data.pause_compare) {
  writeFileSync(${JSON.stringify(join(root, "reading"))}, "reading");
  const deadline = Date.now() + 5000;
  while (!existsSync(${JSON.stringify(join(root, "continue"))}) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}
if (endpoint === "user") result = { login: "fictional-owner", id: 1042 };
else if (endpoint?.includes("/events?")) result = data.events ?? [];
else if (endpoint?.match(/issues[/][0-9]+$/)) result = data.issues.find(issue => endpoint.endsWith("/" + issue.number));
else if (endpoint?.includes("/issues?")) result = data.pages ? data.pages[Number(new URL("https://api.github.invalid/" + endpoint).searchParams.get("page")) - 1] : endpoint.includes("page=1&") ? data.issues : [];
else if (endpoint?.includes("/dependencies/blocked_by")) {
  const number = endpoint.split("/issues/")[1].split("/")[0];
  const page = Number(new URL("https://api.github.invalid/" + endpoint).searchParams.get("page"));
  result = data.dependency_pages?.[number]?.[page - 1] ?? (page === 1 ? data.dependencies?.[number] ?? [] : []);
}
else if (endpoint?.match(/pulls[/][0-9]+$/)) result = data.delivery_pulls?.[endpoint.split("/").at(-1)] ?? {};
else if (endpoint?.includes("/branches/")) result = data.branches?.[decodeURIComponent(endpoint.split("/branches/")[1])] ?? { name: "main", commit: { sha: "f".repeat(40) } };
else if (endpoint?.includes("/compare/")) result = data.comparisons?.[endpoint.split("/compare/")[1]] ?? {};
else if (endpoint?.includes("/git/ref/tags/")) result = data.tag_ref ?? {};
else if (endpoint?.includes("/git/tags/")) result = data.tag_object ?? {};
else if (endpoint?.includes("/releases/tags/")) result = data.releases?.[decodeURIComponent(endpoint.split("/releases/tags/")[1])] ?? {};
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
    expect(after.sources).toEqual(before.sources.map((source: { dependencies: object }) => ({ ...source, dependencies: { ...source.dependencies, fresh: false, satisfied: false } })));
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
  expect(after.sources).toEqual(before.sources.map((source: { dependencies: object }) => ({ ...source, dependencies: { ...source.dependencies, fresh: false, satisfied: false } })));
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

test("metadata timestamps preserve trusted scope approval and prepared app planning", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const data = JSON.parse(readFileSync(f.state, "utf8"));
  Object.assign(data.issues[0], { body: externalPlan, labels: [{ name: "ready-for-agent" }] }); data.events = [readinessEvent()];
  writeFileSync(f.state, JSON.stringify(data));
  const source = (await f.post(route + "/sync", {})).body.sources[0];
  await f.post(route + "/issues/12/prepare", { source_revision: source.revision });
  const before = await f.get(`/implementations/${source.implementation_id}`);
  data.issues[0].updated_at = "2026-10-03T12:00:00Z";
  writeFileSync(f.state, JSON.stringify(data));
  const updated = (await f.post(route + "/sync", {})).body.sources[0];
  expect(updated.current.source_updated_at).toBe("2026-10-03T12:00:00Z");
  expect(updated.revision).toBe(source.revision);
  expect(updated.readiness).toEqual(source.readiness);
  expect(updated.planning).toEqual(before.github_sources[0].planning);
  expect((await f.get(`/implementations/${source.implementation_id}`)).questions).toEqual([]);
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

function dependencyIssue(number: number, repository = "fictional/project") {
  return { number, node_id: `fictional-issue-${number}`, title: `Prerequisite ${number}`, body: "Acceptance: independent prerequisite", html_url: `https://github.com/${repository}/issues/${number}`, repository_url: `https://api.github.com/repos/${repository}`, state: "open", labels: [], updated_at: "2026-10-01T12:00:00Z" };
}

test("native issue dependencies link same-Project Assignments without claiming delivery or parsing prose", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issue = JSON.parse(readFileSync(f.state, "utf8")).issues[0];
  issue.body = "Blocked by #999. See #24 for context.";
  writeFileSync(f.state, JSON.stringify({ issues: [issue, dependencyIssue(24)], pulls: [], dependencies: { 12: [dependencyIssue(24)] } }));
  await f.post(route + "/configure", f.policy);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const sources = (await f.get(route)).sources;
  const source = sources.find((s: { number: number }) => s.number === 12);
  const target = sources.find((s: { number: number }) => s.number === 24);
  const evidence = (await f.get(`/implementations/${source.implementation_id}`)).github_sources[0].dependencies;
  expect(evidence).toMatchObject({ complete: true, source_revision: source.revision, account_profile_id: f.policy.account_profile_id });
  expect(evidence.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(Number.isFinite(Date.parse(evidence.fetched_at))).toBe(true);
  expect(evidence.edges).toMatchObject([{ external_id: "fictional-issue-24", repository: "fictional/project", number: 24, url: "https://github.com/fictional/project/issues/24", state: "open", source_updated_at: "2026-10-01T12:00:00Z", implementation_id: target.implementation_id, resolution: "resolved", blocker: "delivery_unverified" }]);
  expect(target.dependencies.edges).toEqual([]);
  expect(source.current.native_dependencies).toHaveLength(1);
  const before = source.revision;
  writeFileSync(f.state, JSON.stringify({ issues: [issue, dependencyIssue(24)], pulls: [], dependencies: {} }));
  await f.post(route + "/sync", {});
  const after = (await f.get(route)).sources.find((s: { number: number }) => s.number === 12);
  expect(after.dependencies.edges).toEqual([]);
  expect(after.revision).not.toBe(before);
});

test("native dependency cycles remain blocked with their issue identities visible", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24), dependencyIssue(36)];
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: { 12: [issues[1]], 24: [issues[2]], 36: [issues[0]] } }));
  await f.post(route + "/configure", f.policy);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const sources = (await f.get(route)).sources;
  expect(sources).toHaveLength(3);
  for (const source of sources) {
    expect(source.dependencies.edges).toHaveLength(1);
    expect(source.dependencies.edges[0]).toMatchObject({ resolution: "cyclic", blocker: "cyclic", implementation_id: null });
    expect(source.dependencies.edges[0].url).toMatch(/^https:\/\/github.com\/fictional\/project\/issues\//);
  }
});

test("missing, cross-repository and inconsistent native identities cannot resolve to executable Assignments", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issue = dependencyIssue(12); const own = dependencyIssue(24);
  writeFileSync(f.state, JSON.stringify({ issues: [issue, own], pulls: [], dependencies: { 12: [dependencyIssue(36), { ...dependencyIssue(24, "fictional/other"), node_id: "fictional-other-24" }, { ...own, number: 48, html_url: "https://github.com/fictional/project/issues/48" }] } }));
  await f.post(route + "/configure", f.policy);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const source = (await f.get(route)).sources.find((s: { number: number }) => s.number === 12);
  expect(source.dependencies.edges.map((edge: { repository: string; number: number; resolution: string; implementation_id: string | null; blocker: string }) => [edge.repository, edge.number, edge.resolution, edge.implementation_id, edge.blocker])).toEqual([
    ["fictional/other", 24, "cross_boundary", null, "cross_boundary"],
    ["fictional/project", 36, "missing", null, "missing"],
    ["fictional/project", 48, "ambiguous", null, "ambiguous"],
  ]);
});

test("partial dependency pages and unavailable native evidence preserve links while preventing admission", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: { 12: [issues[1]] } }));
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const before = await f.get(route); const source = before.sources.find((s: { number: number }) => s.number === 12);
  expect(source.dependencies.fresh).toBe(true);
  for (const pages of [
    [Array.from({ length: 30 }, (_, i) => dependencyIssue(100 + i)), { message: "Partial page unavailable" }],
    [{ message: "Not Found" }],
    [[null]],
  ]) {
    writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependency_pages: { 12: pages } }));
    const failed = await f.post(route + "/sync", {});
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({ error: { code: "github_dependencies_incomplete" } });
    const after = await f.get(route); const retained = after.sources.find((s: { number: number }) => s.number === 12);
    expect(after.last_sync).toBe(before.last_sync); expect(after.problem).toBeTruthy();
    expect(retained.current).toEqual(source.current);
    expect(retained.dependencies).toMatchObject({ fresh: false, revision: source.dependencies.revision, fetched_at: source.dependencies.fetched_at, edges: source.dependencies.edges });
    expect((await f.get(`/implementations/${source.implementation_id}`)).github_sources[0].dependencies.fresh).toBe(false);
  }
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: { 12: [issues[1]] } }));
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.fresh).toBe(true);
});

test("a native dependency in another Project remains an explicit cross-Project blocker", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const otherRepo = join(f.root, "other-checkout");
  execFileSync("git", ["clone", f.repo, otherRepo], { stdio: "ignore" });
  execFileSync("git", ["-C", otherRepo, "remote", "set-url", "origin", "https://github.com/fictional/project.git"]);
  const other = (await f.post("/projects", { name: "Other Project", path: otherRepo, machine_id: "local", provider: "codex", tracker: "app" })).body;
  const otherRoute = `/projects/${other.id}/github`;
  writeFileSync(f.state, JSON.stringify({ issues: [dependencyIssue(24)], pulls: [] }));
  expect((await f.post(otherRoute + "/configure", f.policy)).status).toBe(200);
  await f.post(otherRoute + "/sync", {});
  const issue = dependencyIssue(12);
  writeFileSync(f.state, JSON.stringify({ issues: [issue], pulls: [], dependencies: { 12: [dependencyIssue(24)] } }));
  await f.post(route + "/configure", f.policy);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  expect((await f.get(route)).sources[0].dependencies.edges[0]).toMatchObject({ number: 24, resolution: "cross_boundary", implementation_id: null, blocker: "cross_boundary" });
});

test("a dependency disappearing from the current inventory cannot reuse its historical resolved identity", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: { 12: [issues[1]] } }));
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  writeFileSync(f.state, JSON.stringify({ issues: [issues[0]], pulls: [], dependencies: { 12: [issues[1]] } }));
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const sources = (await f.get(route)).sources;
  expect(sources.find((s: { number: number }) => s.number === 12).dependencies.edges[0]).toMatchObject({ resolution: "missing", blocker: "missing", implementation_id: null });
  expect(sources.find((s: { number: number }) => s.number === 24).dependencies.fresh).toBe(false);
});

test("dependency closure refreshes delivery context without rewriting the dependent issue scope", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: { 12: [issues[1]] } }));
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const before = (await f.get(route)).sources.find((s: { number: number }) => s.number === 12);
  Object.assign(issues[1]!, { state: "closed", updated_at: "2026-10-02T12:00:00Z" });
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: { 12: [issues[1]] } }));
  await f.post(route + "/sync", {});
  const after = (await f.get(route)).sources.find((s: { number: number }) => s.number === 12);
  expect(after.current.revision).toBe(before.current.revision);
  expect(after.dependencies.edges[0]).toMatchObject({ state: "closed", resolution: "resolved", blocker: "delivery_unverified" });
  expect(after.history).toHaveLength(1);
});

test("Project scope changes invalidate dependency freshness before another sync", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const before = (await f.get(route)).sources[0];
  expect(before.dependencies.fresh).toBe(true);
  expect((await f.post(`/projects/${f.project.id}/configure`, { account_bindings: { local: { github: f.policy.account_profile_id } } })).status).toBe(200);
  const after = (await f.get(`/implementations/${before.implementation_id}`)).github_sources[0];
  expect(after.dependencies.fresh).toBe(false);
  expect(after.current).toEqual(before.current);
});

test("moving a prerequisite Assignment to another Project preserves source history and blocks the old Project edge", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: { 12: [issues[1]] } }));
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const target = (await f.get(route)).sources.find((s: { number: number }) => s.number === 24);
  const otherRepo = join(f.root, "other-checkout"); execFileSync("git", ["clone", f.repo, otherRepo], { stdio: "ignore" });
  const other = (await f.post("/projects", { name: "Other Project", path: otherRepo, machine_id: "local", provider: "codex", tracker: "app" })).body;
  expect((await f.post(`/implementations/${target.implementation_id}/configure`, { project_id: other.id })).status).toBe(200);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.edges[0]).toMatchObject({ resolution: "cross_boundary", implementation_id: null, blocker: "cross_boundary" });
  const detail = await f.get(`/implementations/${target.implementation_id}`);
  expect(detail.github_sources[0].id).toBe(target.id);
  expect(detail.github_sources[0].current).toMatchObject({ title: "Prerequisite 24" });
  expect(detail.github_sources[0].dependencies.fresh).toBe(false);
});

test("a native prerequisite already closed on initial sync remains accessible for verified delivery without importing unrelated history", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), { ...dependencyIssue(24), state: "closed" }, { ...dependencyIssue(36), state: "closed" }];
  const data = { issues, pulls: [], dependencies: { 12: [issues[1]] }, dependency_pages: { 36: [{ message: "Unrelated historical evidence unavailable" }] }, delivery_pulls: { 27: deliveryPull() }, comparisons: { ["c".repeat(40) + "..." + "f".repeat(40)]: { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } } } };
  writeFileSync(f.state, JSON.stringify(data));
  await f.post(route + "/configure", f.policy);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const sources = (await f.get(route)).sources;
  expect(sources.map((source: { number: number }) => source.number)).toEqual([12, 24]);
  const target = sources.find((source: { number: number }) => source.number === 24);
  expect((await f.get(`/implementations/${target.implementation_id}`)).github_sources[0]).toMatchObject({ id: target.id, state: "closed" });
  expect(sources[0].dependencies.edges[0]).toMatchObject({ implementation_id: target.implementation_id, resolution: "resolved", blocker: "delivery_unverified" });
  expect((await f.post(route + "/issues/24/delivery", { source_revision: target.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: null })).status).toBe(200);
  for (let index = 0; index < 2; index++) {
    expect((await f.post(route + "/sync", {})).status).toBe(200);
    const current = (await f.get(route)).sources;
    expect(current.map((source: { id: string }) => source.id)).toEqual(sources.map((source: { id: string }) => source.id));
    expect(current[0].dependencies).toMatchObject({ satisfied: true, edges: [{ blocker: null, delivery: { merges: [{ number: 27, merge_commit: "c".repeat(40) }] } }] });
    expect((await f.get(`/implementations/${target.implementation_id}`)).runs).toEqual([]);
  }
});

test("an approved plan can discover an already-closed prerequisite and require its containing release", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), { ...dependencyIssue(24), state: "closed" }];
  const comparison = { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } };
  const data = { issues, pulls: [], dependencies: {}, delivery_pulls: { 27: deliveryPull() }, comparisons: { ["c".repeat(40) + "..." + "f".repeat(40)]: comparison, ["c".repeat(40) + "..." + "d".repeat(40)]: comparison }, tag_ref: { ref: "refs/tags/v1", object: { type: "commit", sha: "d".repeat(40) } }, releases: { v1: { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, published_at: null as string | null } } };
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const source = (await f.get(route)).sources[0]; const prefix = `/implementations/${source.implementation_id}`;
  const specification = (await f.post(prefix + "/specifications", { content: externalPlan.replace("None.", JSON.stringify([{ repository: "fictional/project", number: 24, requires: "release" }])) })).body;
  for (const kind of ["specification", "testing_seams"]) await f.post(prefix + "/approvals", { kind, revision: specification.id, scope: "Fictional owner approved related release prerequisite" });
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  const sources = (await f.get(route)).sources;
  expect(sources.map((source: { number: number }) => source.number)).toEqual([12, 24]);
  const target = sources[1];
  expect((await f.post(route + "/issues/24/delivery", { source_revision: target.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: "v1" })).status).toBe(200);
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources[0].dependencies).toMatchObject({ satisfied: false, edges: [{ requires: "release", blocker: "release_unverified" }] });
  data.releases.v1.draft = false; data.releases.v1.published_at = "2026-10-04T12:00:00Z";
  writeFileSync(f.state, JSON.stringify(data));
  for (let index = 0; index < 2; index++) {
    expect((await f.post(route + "/sync", {})).status).toBe(200);
    expect((await f.get(route)).sources[0].dependencies).toMatchObject({ satisfied: true, edges: [{ requires: "release", blocker: null, delivery: { release: { tag: "v1", commit: "d".repeat(40) } } }] });
    expect((await f.get(`/implementations/${target.implementation_id}`)).runs).toEqual([]);
  }
});

test("the first backlog preview retains closed prerequisites from the newly prepared trusted issue plan", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [{ ...dependencyIssue(12), body: externalPlan.replace("None.", '[{"repository":"fictional/project","number":24,"requires":"merge"}]'), labels: [{ name: "ready-for-agent" }] }, { ...dependencyIssue(24), state: "closed" }, { ...dependencyIssue(36), state: "closed" }];
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], events: [readinessEvent()], dependencies: { 24: [issues[2]] } }));
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  expect((await f.post(route + "/preview", {})).status).toBe(200);
  const sources = (await f.get(route)).sources;
  expect(sources.map((source: { number: number }) => source.number)).toEqual([12, 24, 36]);
  expect(sources[0].planning.condition).toBe("prepared");
  expect(sources[0].dependencies.edges[0]).toMatchObject({ implementation_id: sources[1].implementation_id, resolution: "resolved", blocker: "delivery_unverified" });
  expect(sources[1].dependencies.edges[0]).toMatchObject({ implementation_id: sources[2].implementation_id, resolution: "resolved", blocker: "delivery_unverified" });
  for (const source of sources) expect((await f.get(`/implementations/${source.implementation_id}`)).runs).toEqual([]);
});

test("unrelated historical closed issues do not require dependency access for current imports", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const closed = { ...dependencyIssue(24), state: "closed" };
  writeFileSync(f.state, JSON.stringify({ issues: [dependencyIssue(12), closed], pulls: [], dependency_pages: { 24: [{ message: "Historical evidence unavailable" }] } }));
  await f.post(route + "/configure", f.policy);
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  expect((await f.get(route)).sources.map((source: { number: number }) => source.number)).toEqual([12]);
});

test("native relationship edits invalidate readiness and owner approval checks the displayed relationship scope", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy);
  const policy = (await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" })).body;
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.issues[0].labels = [{ name: "ready-for-agent" }]; data.issues.push(dependencyIssue(24)); data.events = [readinessEvent()];
  writeFileSync(f.state, JSON.stringify(data));
  let source = (await f.post(route + "/sync", {})).body.sources.find((source: { number: number }) => source.number === 12);
  expect(source.readiness.eligible).toBe(true); expect(source.dependencies.edges).toEqual([]);
  data.dependencies = { 12: [dependencyIssue(24)] }; writeFileSync(f.state, JSON.stringify(data));
  source = (await f.post(route + "/sync", {})).body.sources.find((source: { number: number }) => source.number === 12);
  expect(source.readiness.eligible).toBe(false); expect(source.readiness.blockers).toContain("stale");
  expect(source.dependencies.edges[0]).toMatchObject({ number: 24, blocker: "delivery_unverified" });
  expect((await f.post(route + "/issues/12/approve", { source_revision: source.revision, policy_revision: policy.revision })).status).toBe(200);
  expect((await f.get(route)).sources.find((source: { number: number }) => source.number === 12).readiness.eligible).toBe(true);
  // A relationship edited after the displayed source loaded must not be approved silently.
  data.dependencies = {}; writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(route + "/issues/12/approve", { source_revision: source.revision, policy_revision: policy.revision })).status).toBe(409);
  expect((await f.get(route)).sources.find((source: { number: number }) => source.number === 12).dependencies.fresh).toBe(false);
  data.events.push(readinessEvent(2, "fictional-owner", "2026-10-02T12:00:00Z")); data.issues[0].updated_at = "2026-10-02T12:00:00Z"; writeFileSync(f.state, JSON.stringify(data));
  source = (await f.post(route + "/sync", {})).body.sources.find((source: { number: number }) => source.number === 12);
  expect(source.readiness.eligible).toBe(true); expect(source.dependencies.edges).toEqual([]);
});


test("approved plan dependencies join native relationships and preserve stricter release provenance", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24), dependencyIssue(36)];
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: { 12: [issues[1]] } }));
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const source = (await f.get(route)).sources.find((s: { number: number }) => s.number === 12);
  const prefix = `/implementations/${source.implementation_id}`;
  const specification = (await f.post(prefix + "/specifications", { content: externalPlan.replace("None.", JSON.stringify([{ repository: "fictional/project", number: 24, requires: "release" }, { repository: "fictional/project", number: 36, requires: "merge" }])) })).body;
  // A draft cannot add executable dependencies.
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.edges).toHaveLength(1);
  for (const kind of ["specification", "testing_seams"]) await f.post(prefix + "/approvals", { kind, revision: specification.id, scope: "Fictional owner approved this plan" });
  await f.post(route + "/sync", {});
  const combined = (await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies;
  expect(combined.edges).toHaveLength(2);
  expect(combined.edges[0]).toMatchObject({ number: 24, requires: "release", provenance: [{ kind: "github_native" }, { kind: "app_plan", specification_id: specification.id }], blocker: "delivery_unverified" });
  expect(combined.edges[1]).toMatchObject({ number: 36, requires: "merge", provenance: [{ kind: "app_plan", specification_id: specification.id }] });
  expect((await f.get(prefix)).runs).toEqual([]);
});

test("a cycle spanning native and approved plan edges blocks both Assignments", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: { 12: [issues[1]] } }));
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const source = (await f.get(route)).sources.find((s: { number: number }) => s.number === 24);
  const prefix = `/implementations/${source.implementation_id}`;
  const specification = (await f.post(prefix + "/specifications", { content: externalPlan.replace("None.", JSON.stringify([{ repository: "fictional/project", number: 12, requires: "merge" }])) })).body;
  for (const kind of ["specification", "testing_seams"]) await f.post(prefix + "/approvals", { kind, revision: specification.id, scope: "Fictional approved cycle fixture" });
  await f.post(route + "/sync", {});
  const sources = (await f.get(route)).sources;
  expect(sources.map((s: { dependencies: { edges: unknown[] } }) => s.dependencies.edges)).toMatchObject([[{ resolution: "cyclic", blocker: "cyclic" }], [{ resolution: "cyclic", blocker: "cyclic" }]]);
});

test("unresolved approved declarations remain visible and plan changes invalidate prior dependency evidence", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const source = (await f.get(route)).sources[0]; const prefix = `/implementations/${source.implementation_id}`;
  const specification = (await f.post(prefix + "/specifications", { content: externalPlan.replace("None.", '[{"repository":"fictional/project","number":24,"requires":"unknown"}]') })).body;
  for (const kind of ["specification", "testing_seams"]) await f.post(prefix + "/approvals", { kind, revision: specification.id, scope: "Fictional unresolved declaration" });
  expect((await f.get(route)).sources[0].dependencies.fresh).toBe(false);
  await f.post(route + "/sync", {});
  const dependencies = (await f.get(route)).sources[0].dependencies;
  expect(dependencies).toMatchObject({ satisfied: false, conflicts: ["Approved plan dependencies need explicit repository, issue number and merge or release requirements."] });
});


test("linking intended PR coverage never fabricates delivery and only verified target-branch merges satisfy dependencies", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  const data = { issues, pulls: [], dependencies: { 12: [issues[1]] }, delivery_pulls: { 27: deliveryPull() }, comparisons: {} as Record<string, unknown> };
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  let sources = (await f.get(route)).sources; const target = sources.find((s: { number: number }) => s.number === 24);
  const linked = await f.post(route + "/issues/24/delivery", { source_revision: target.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: null });
  expect(linked.status).toBe(200);
  expect(linked.body.sources.find((s: { number: number }) => s.number === 12).dependencies.satisfied).toBe(false);
  // The issue is closed, but the intended PR is still open.
  data.issues[1]!.state = "closed"; data.delivery_pulls[27].merged = false; writeFileSync(f.state, JSON.stringify(data));
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.satisfied).toBe(false);
  // Renew the coverage link for the exact changed issue revision.
  sources = (await f.get(route)).sources; const changed = sources.find((s: { number: number }) => s.number === 24);
  await f.post(route + "/issues/24/delivery", { source_revision: changed.revision, expected_revision: changed.delivery.revision, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: null });
  data.delivery_pulls[27].merged = true; data.delivery_pulls[27].base.ref = "other"; writeFileSync(f.state, JSON.stringify(data));
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.edges[0].blocker).toBe("wrong_target");
  data.delivery_pulls[27].base.ref = "main"; data.comparisons["c".repeat(40) + "..." + "f".repeat(40)] = { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) }, commits: [], total_commits: 2 };
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  const satisfied = (await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies;
  expect(satisfied).toMatchObject({ satisfied: true, target_branch: "main", edges: [{ blocker: null, delivery: { merges: [{ number: 27, head: "a".repeat(40), merge_commit: "c".repeat(40), target_branch: "main" }] } }] });
  expect((await f.get(`/implementations/${target.implementation_id}`)).implementation).toMatchObject({ stage: "done", outcome: "merged" });
  const retainedTarget = (await f.get(route)).sources.find((s: { number: number }) => s.number === 24);
  expect(retainedTarget.delivery_history).toHaveLength(2);
  expect(retainedTarget.delivery_history[0]).toMatchObject({ source_revision: target.revision, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }] });
  f.restart(); expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.satisfied).toBe(true);
});

function deliveryPull() { return { number: 27, html_url: "https://github.com/fictional/project/pull/27", merged: true, merged_at: "2026-10-03T12:00:00Z", merge_commit_sha: "c".repeat(40), head: { sha: "a".repeat(40) }, base: { ref: "main", repo: { full_name: "fictional/project" } } }; }

test("an Assignment becomes Done only after all linked intended coverage is verified on its target branch", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const data = { issues: [dependencyIssue(24)], pulls: [], dependencies: {}, delivery_pulls: { 27: { ...deliveryPull(), merged: false } }, comparisons: { ["c".repeat(40) + "..." + "f".repeat(40)]: { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } } } };
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/configure", f.policy);
  await f.post(route + "/sync", {});
  const source = (await f.get(route)).sources[0]; const path = `/implementations/${source.implementation_id}`;
  await f.post(route + "/issues/24/delivery", { source_revision: source.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: null });
  await f.post(route + "/sync", {});
  expect((await f.get(path)).implementation.stage).not.toBe("done");
  data.delivery_pulls[27].merged = true; writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  expect((await f.get(path)).implementation).toMatchObject({ stage: "done", outcome: "merged", delivery_evidence: { source_id: source.id, source_revision: source.revision, requires: "merge", merges: [{ number: 27, head: "a".repeat(40), target_branch: "main" }] } });
}, 20_000);

test("a retained release requirement cannot become Done from a merge or a non-containing release", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const comparison = { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } };
  const data = { issues: [dependencyIssue(24)], pulls: [], dependencies: {}, delivery_pulls: { 27: deliveryPull() }, comparisons: { ["c".repeat(40) + "..." + "f".repeat(40)]: comparison, ["c".repeat(40) + "..." + "d".repeat(40)]: { ...comparison, status: "behind" } }, tag_ref: { ref: "refs/tags/v1", object: { type: "commit", sha: "d".repeat(40) } }, releases: { v1: { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: false, published_at: "2026-10-04T12:00:00Z" } } };
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const source = (await f.get(route)).sources[0]; const path = `/implementations/${source.implementation_id}`;
  const coverage = { source_revision: source.revision, expected_revision: null as string | null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: "v1" as string | null };
  await f.post(route + "/issues/24/delivery", coverage); await f.post(route + "/sync", {});
  expect((await f.get(path)).implementation.stage).not.toBe("done");
  coverage.expected_revision = (await f.get(route)).sources[0].delivery.revision; coverage.release_tag = null;
  await f.post(route + "/issues/24/delivery", coverage); await f.post(route + "/sync", {});
  expect((await f.get(path)).implementation.stage).not.toBe("done");
  coverage.expected_revision = (await f.get(route)).sources[0].delivery.revision; coverage.release_tag = "v1";
  await f.post(route + "/issues/24/delivery", coverage);
  data.comparisons["c".repeat(40) + "..." + "d".repeat(40)]!.status = "ahead";
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  expect((await f.get(path)).implementation).toMatchObject({ stage: "done", outcome: "released", delivery_evidence: { requires: "release", release: { tag: "v1", commit: "d".repeat(40) } } });
}, 20_000);

test("an explicit release dependency waits for a published release containing every intended merge", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  const comparison = { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } };
  const data = { issues, pulls: [], dependencies: {}, delivery_pulls: { 27: deliveryPull() }, comparisons: { ["c".repeat(40) + "..." + "f".repeat(40)]: comparison, ["c".repeat(40) + "..." + "d".repeat(40)]: { ...comparison, status: "behind" } }, tag_ref: { ref: "refs/tags/v1", object: { type: "commit", sha: "d".repeat(40) } }, releases: { v1: { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, published_at: null as string | null } } };
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const sources = (await f.get(route)).sources; const target = sources.find((s: { number: number }) => s.number === 24); const dependent = sources.find((s: { number: number }) => s.number === 12);
  const prefix = `/implementations/${dependent.implementation_id}`;
  const specification = (await f.post(prefix + "/specifications", { content: externalPlan.replace("None.", JSON.stringify([{ repository: "fictional/project", number: 24, requires: "release" }])) })).body;
  for (const kind of ["specification", "testing_seams"]) await f.post(prefix + "/approvals", { kind, revision: specification.id, scope: "Fictional released artifact requirement" });
  await f.post(route + "/issues/24/delivery", { source_revision: target.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: "v1" });
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies).toMatchObject({ satisfied: false, edges: [{ blocker: "release_unverified" }] });
  data.releases.v1.draft = false; data.releases.v1.published_at = "2026-10-04T12:00:00Z"; writeFileSync(f.state, JSON.stringify(data));
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.satisfied).toBe(false);
  data.comparisons["c".repeat(40) + "..." + "d".repeat(40)]!.status = "ahead"; writeFileSync(f.state, JSON.stringify(data));
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies).toMatchObject({ satisfied: true, edges: [{ blocker: null, requires: "release", delivery: { release: { tag: "v1", url: data.releases.v1.html_url } } }] });
  // A same-named branch is not the release tag; peel the annotated tag and verify its commit.
  Object.assign(data, { tag_ref: { ref: "refs/tags/v1", object: { type: "tag", sha: "e".repeat(40) } }, tag_object: { sha: "e".repeat(40), object: { type: "commit", sha: "d".repeat(40) } } });
  Object.assign(data.comparisons, { ["c".repeat(40) + "..." + "d".repeat(40)]: { ...comparison, status: "behind" } });
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.satisfied).toBe(false);
  data.comparisons["c".repeat(40) + "..." + "d".repeat(40)]!.status = "ahead"; writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies).toMatchObject({ satisfied: true, edges: [{ delivery: { release: { commit: "d".repeat(40) } } }] });
});

test("every intended PR head must be merged before coverage is satisfied", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  const second = { ...deliveryPull(), number: 28, html_url: "https://github.com/fictional/project/pull/28", merged: false, head: { sha: "b".repeat(40) } };
  const data = { issues, pulls: [], dependencies: { 12: [issues[1]] }, delivery_pulls: { 27: deliveryPull(), 28: second }, comparisons: { ["c".repeat(40) + "..." + "f".repeat(40)]: { status: "identical", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } } } };
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const target = (await f.get(route)).sources.find((s: { number: number }) => s.number === 24);
  await f.post(route + "/issues/24/delivery", { source_revision: target.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }, { number: 28, head: "b".repeat(40) }], release_tag: null });
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.satisfied).toBe(false);
  second.merged = true; second.head.sha = "e".repeat(40); writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.satisfied).toBe(false);
  second.head.sha = "b".repeat(40); writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies).toMatchObject({ satisfied: true, edges: [{ delivery: { merges: [{ number: 27 }, { number: 28 }] } }] });
  const dependent = (await f.get(route)).sources.find((s: { number: number }) => s.number === 12);
  const prefix = `/implementations/${dependent.implementation_id}`;
  const spec = (await f.post(prefix + "/specifications", { content: externalPlan })).body;
  for (const kind of ["specification", "testing_seams"]) await f.post(prefix + "/approvals", { kind, revision: spec.id, scope: "Fictional changed plan" });
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies).toMatchObject({ fresh: false, satisfied: false });
});

test("a changed prerequisite plan invalidates the combined graph before another sync", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: { 12: [issues[1]] } }));
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const target = (await f.get(route)).sources.find((s: { number: number }) => s.number === 24);
  const prefix = `/implementations/${target.implementation_id}`;
  const spec = (await f.post(prefix + "/specifications", { content: externalPlan.replace("None.", JSON.stringify([{ repository: "fictional/project", number: 12, requires: "merge" }])) })).body;
  for (const kind of ["specification", "testing_seams"]) await f.post(prefix + "/approvals", { kind, revision: spec.id, scope: "Changed combined graph" });
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.fresh).toBe(false);
});


test("merge containment uses the target branch commit rather than an ambiguous branch or tag name", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  const comparison = { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } };
  const data = { issues, pulls: [], dependencies: { 12: [issues[1]] }, delivery_pulls: { 27: deliveryPull() }, comparisons: { ["c".repeat(40) + "...main"]: comparison, ["c".repeat(40) + "..." + "f".repeat(40)]: { ...comparison, status: "behind" } } };
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const target = (await f.get(route)).sources.find((s: { number: number }) => s.number === 24);
  await f.post(route + "/issues/24/delivery", { source_revision: target.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: null });
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.satisfied).toBe(false);
  data.comparisons["c".repeat(40) + "..." + "f".repeat(40)]!.status = "ahead"; writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.satisfied).toBe(true);
});

test("prepared trusted issue plans retain explicit dependency requirements without synthetic owner approvals", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [{ ...dependencyIssue(12), labels: [{ name: "ready-for-agent" }] }, dependencyIssue(24)];
  issues[0]!.body = externalPlan.replace("None.", JSON.stringify([{ repository: "fictional/project", number: 24, requires: "release" }]));
  writeFileSync(f.state, JSON.stringify({ issues, pulls: [], dependencies: {}, events: [readinessEvent()] }));
  await f.post(route + "/configure", f.policy);
  await f.post(route + "/readiness", { expected_revision: null, account_profile_id: f.policy.account_profile_id, triage_labels: {}, blocked_label: "blocked" });
  const source = (await f.post(route + "/sync", {})).body.sources.find((s: { number: number }) => s.number === 12);
  const prepared = await f.post(route + "/issues/12/prepare", { source_revision: source.revision });
  expect(prepared.body.sources.find((s: { number: number }) => s.number === 12).planning.condition).toBe("prepared");
  await f.post(route + "/sync", {});
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies.edges).toMatchObject([{ number: 24, requires: "release", provenance: [{ kind: "app_plan" }] }]);
  expect((await f.get(`/implementations/${source.implementation_id}`)).approvals).toEqual([]);
});


test("approved scope changed during delivery verification cannot publish satisfied dependency evidence", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const issues = [dependencyIssue(12), dependencyIssue(24)];
  const data = { issues, pulls: [], dependencies: { 12: [issues[1]] }, delivery_pulls: { 27: deliveryPull() }, comparisons: { ["c".repeat(40) + "..." + "f".repeat(40)]: { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } } }, pause_compare: false };
  writeFileSync(f.state, JSON.stringify(data)); await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const sources = (await f.get(route)).sources; const target = sources.find((s: { number: number }) => s.number === 24); const dependent = sources.find((s: { number: number }) => s.number === 12);
  await f.post(route + "/issues/24/delivery", { source_revision: target.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: null });
  data.pause_compare = true; writeFileSync(f.state, JSON.stringify(data));
  const pending = f.post(route + "/sync", {});
  const deadline = Date.now() + 3000;
  while (!existsSync(join(f.root, "reading")) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(join(f.root, "reading"))).toBe(true);
  const prefix = `/implementations/${dependent.implementation_id}`;
  const spec = (await f.post(prefix + "/specifications", { content: externalPlan.replace("None.", JSON.stringify([{ repository: "fictional/project", number: 36, requires: "release" }])) })).body;
  for (const kind of ["specification", "testing_seams"]) await f.post(prefix + "/approvals", { kind, revision: spec.id, scope: "Changed while GitHub was reading" });
  writeFileSync(join(f.root, "continue"), "continue");
  expect((await pending).body).toMatchObject({ error: { code: "dependency_scope_changed" } });
  expect((await f.get(route)).sources.find((s: { number: number }) => s.number === 12).dependencies).toMatchObject({ fresh: false, satisfied: false });
});
