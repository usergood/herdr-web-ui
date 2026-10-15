import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { githubFixture } from "../scripts/factory-github-fixture.ts";

const fixtures: Awaited<ReturnType<typeof githubFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function fixture() { const f = await githubFixture(); fixtures.push(f); return f; }

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
test("Delete permanently removes the linked issue and stale sync cannot recreate its Assignment", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const stale = readFileSync(f.state, "utf8");
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const removed = await f.post(`/implementations/${idea.id}/delete`, {});
  expect(removed).toEqual({ status: 200, body: { id: idea.id, condition: "deleted" } });
  expect(JSON.parse(readFileSync(f.state, "utf8")).issues).toEqual([]);
  expect((await f.get(route)).sources).toEqual([]);
  writeFileSync(f.state, stale);
  await f.post(route + "/sync", {});
  expect((await f.get("")).implementations).toEqual([]);
  expect(await f.post(`/implementations/${idea.id}/delete`, {})).toEqual(removed);
});
test("denied issue deletion stays pending with suppression across restart and recovers automatically", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.permission = "WRITE";
  writeFileSync(f.state, JSON.stringify(data));
  const response = await f.post(`/implementations/${idea.id}/delete`, {});
  expect(response.status).toBe(202);
  expect(response.body.reasons.join(" ")).toContain("repository-admin");
  expect(JSON.parse(readFileSync(f.state, "utf8")).issues).toHaveLength(1);
  f.restart();
  await f.post(route + "/sync", {});
  expect((await f.get("")).implementations).toHaveLength(1);
  const pending = await f.get(`/implementations/${idea.id}`);
  expect(pending.messages).toEqual([]); expect(pending.implementation.description).toBe("");
  expect((await f.get(route)).sources).toEqual([]);
  data.permission = "ADMIN"; writeFileSync(f.state, JSON.stringify(data));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && (await f.get("")).implementations.length) await Bun.sleep(30);
  expect((await f.get("")).implementations).toEqual([]);
  expect(JSON.parse(readFileSync(f.state, "utf8")).issues).toEqual([]);
}, 15000);
test("a lost GitHub deletion reply remains pending, then reconciles without repeating the mutation", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.lose_delete = true;
  writeFileSync(f.state, JSON.stringify(data));
  const replies = await Promise.all([f.post(`/implementations/${idea.id}/delete`, {}), f.post(`/implementations/${idea.id}/delete`, {})]);
  expect(replies.map(r => r.status)).toEqual([202, 202]);
  expect(replies[0]!.body.reasons.join(" ")).toContain("GitHub");
  f.restart();
  expect((await f.post(`/implementations/${idea.id}/delete`, {})).body).toEqual({ id: idea.id, condition: "deleted" });
  const calls = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(call => call.args.some((arg: string) => arg.includes("deleteIssue(")))).toHaveLength(1);
  expect((await f.get("")).implementations).toEqual([]);
});
test("permanent issue deletion follows a complete paginated inventory", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const data = JSON.parse(readFileSync(f.state, "utf8"));
  data.paginate = true;
  data.issues = [...Array.from({ length: 100 }, (_, i) => ({ number: i + 100, node_id: `other-${i}` })), ...data.issues];
  writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(`/implementations/${idea.id}/delete`, {})).status).toBe(200);
  expect(JSON.parse(readFileSync(f.state, "utf8")).issues).toHaveLength(100);
  expect((await f.get("")).implementations).toEqual([]);
});
test("pending issue deletion never switches to a changed GitHub identity", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.permission = "WRITE"; writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(`/implementations/${idea.id}/delete`, {})).status).toBe(202);
  const profile = (await f.get("/machines/local/accounts")).profiles[0];
  const configured = await f.post(`/machines/local/accounts/${profile.id}/configure`, { expected_revision: profile.revision, name: profile.name, expected_login: "another-owner", expected_account_id: "2042" });
  expect(configured.status).toBe(200);
  data.login = "another-owner"; data.account_id = 2042; data.permission = "ADMIN"; writeFileSync(f.state, JSON.stringify(data));
  expect((await f.post(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: configured.body.revision })).status).toBe(200);
  const result = await f.post(`/implementations/${idea.id}/delete`, {});
  expect(result.status).toBe(202);
  expect(result.body.reasons.join(" ")).toContain("authorized GitHub identity");
  expect(JSON.parse(readFileSync(f.state, "utf8")).issues).toHaveLength(1);
});
test("an ambiguous GitHub receipt stays pending until an independent inventory confirms removal", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.ambiguous_delete = true; writeFileSync(f.state, JSON.stringify(data));
  const response = await f.post(`/implementations/${idea.id}/delete`, {});
  expect(response.status).toBe(202);
  expect(response.body.reasons.join(" ")).toContain("did not confirm");
  f.restart();
  expect((await f.post(`/implementations/${idea.id}/delete`, {})).body).toEqual({ id: idea.id, condition: "deleted" });
});
test("confirmed GitHub cleanup is not repeated while another Delete obligation remains pending", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const stale = readFileSync(f.state, "utf8");
  await f.post("/backups", {});
  expect((await f.post(`/implementations/${idea.id}/delete`, {})).status).toBe(202);
  writeFileSync(f.state, stale);
  f.restart();
  await f.post(`/implementations/${idea.id}/delete`, {});
  const mutations = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(call => call.args.some((a: string) => a.includes("deleteIssue(")));
  expect(mutations).toHaveLength(1);
});
test("an unreadable GitHub inventory cannot be mistaken for an already-missing issue", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.incomplete_inventory = true; writeFileSync(f.state, JSON.stringify(data));
  const response = await f.post(`/implementations/${idea.id}/delete`, {});
  expect(response.status).toBe(202);
  expect(response.body.reasons.join(" ")).toContain("inventory is incomplete");
  expect(JSON.parse(readFileSync(f.state, "utf8")).issues).toHaveLength(1);
});
test("GitHub organization denial stays pending with a concrete safe permission reason", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.deny_delete = true; writeFileSync(f.state, JSON.stringify(data));
  const response = await f.post(`/implementations/${idea.id}/delete`, {});
  expect(response.status).toBe(202);
  expect(response.body.reasons.join(" ")).toContain("FORBIDDEN");
  expect(response.body.reasons.join(" ")).toContain("organization");
  expect(JSON.stringify(response.body)).not.toContain("untrusted diagnostic");
  expect(JSON.parse(readFileSync(f.state, "utf8")).issues).toHaveLength(1);
});
test("source suppression survives unavailable cleanup credentials and applies across Projects for the same repository", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const profile = (await f.get("/machines/local/accounts")).profiles[0];
  expect((await f.post(`/machines/local/accounts/${profile.id}/disable`, { expected_revision: profile.revision })).status).toBe(200);
  expect((await f.post(`/implementations/${idea.id}/delete`, {})).status).toBe(202);
  const otherAccount = (await f.post("/machines/local/accounts", { name: "Another fixture", service: "github", expected_login: "fictional-owner" })).body;
  await f.post(`/machines/local/accounts/${otherAccount.id}/verify`, { expected_revision: otherAccount.revision });
  const otherProject = (await f.post("/projects", { name: "Other fixture", path: join(f.root, "repo"), machine_id: "local", provider: "codex", tracker: "app" })).body;
  const otherRoute = `/projects/${otherProject.id}/github`;
  expect((await f.post(otherRoute + "/configure", { ...f.policy, account_profile_id: otherAccount.id })).status).toBe(200);
  expect((await f.post(otherRoute + "/sync", {})).status).toBe(200);
  expect((await f.get("")).implementations.map((a: { id: string }) => a.id)).toEqual([idea.id]);
});
test("a temporary GitHub identity transport outage recovers automatically without another owner verification", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  await f.post(route + "/configure", f.policy); await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const data = JSON.parse(readFileSync(f.state, "utf8")); data.offline_identity = true; writeFileSync(f.state, JSON.stringify(data));
  const response = await f.post(`/implementations/${idea.id}/delete`, {});
  expect(response.status).toBe(202);
  expect(response.body.reasons.join(" ")).toContain("GitHub");
  f.restart();
  data.offline_identity = false; writeFileSync(f.state, JSON.stringify(data));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && (await f.get("")).implementations.length) await Bun.sleep(30);
  expect((await f.get("")).implementations).toEqual([]);
  expect(JSON.parse(readFileSync(f.state, "utf8")).issues).toEqual([]);
}, 15000);
function pull(state = "APPROVED") {
  return { number: 27, id: "fictional-pr-27", title: "Improve imports", body: "Fictional patch", url: "https://github.com/fictional/project/pull/27", state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), headRefName: "feature", baseRefName: "main", author: { login: "fictional-owner" }, headRepository: { nameWithOwner: "fictional/project" }, viewerCanUpdate: true, mergeStateStatus: "CLEAN", reviewDecision: state === "APPROVED" ? "APPROVED" : "CHANGES_REQUESTED",
    reviews: connection([{ id: "review-1", state, body: "Please validate the acceptance cases", submittedAt: "2026-10-11T12:00:00Z", author: { login: "fictional-reviewer" }, commit: { oid: "a".repeat(40) } }]), reviewRequests: connection([]), reviewThreads: connection([]),
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: connection([{ name: "Fast checks", status: "COMPLETED", conclusion: "SUCCESS" }]) } } }] },
    baseRef: { branchProtectionRule: { isAdminEnforced: true, requiresApprovingReviews: true, requiredApprovingReviewCount: 1, requiresStatusChecks: true, requiresStrictStatusChecks: true, requiresConversationResolution: true, requiredStatusCheckContexts: ["Fast checks"] } } };
}
test("retained PRs do not automatically recreate or update deleted work; explicit owner intake stays distinct", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  const pr = pull("CHANGES_REQUESTED");
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr] }));
  const policy = (await f.post(route + "/configure", { ...f.policy, auto_update: true })).body;
  await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  expect((await f.post(`/implementations/${idea.id}/delete`, {})).status).toBe(200);
  f.restart();
  pr.headRefOid = "c".repeat(40); pr.mergeStateStatus = "BEHIND";
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pr] }));
  expect((await f.post(route + "/sync", {})).status).toBe(200);
  expect((await f.get("")).implementations).toEqual([]);
  expect(JSON.parse(readFileSync(f.state, "utf8")).pulls).toEqual([pr]);
  expect(readFileSync(f.log, "utf8")).not.toContain('"PUT"');
  expect((await f.get(route)).pulls[0].fix_implementation_id).toBeNull();
  expect((await f.post(route + "/pulls/27/import", { head: pr.headRefOid, base: pr.baseRefOid, policy_revision: policy.revision })).status).toBe(200);
  const explicit = (await f.get("")).implementations;
  expect(explicit).toHaveLength(1); expect(explicit[0].id).not.toBe(idea.id);
});
test("Delete fences an automatic PR merge already waiting on its last identity check", async () => {
  const f = await fixture(); const route = `/projects/${f.project.id}/github`;
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pull("CHANGES_REQUESTED")] }));
  await f.post(route + "/configure", { ...f.policy, auto_merge: true });
  await f.post(route + "/sync", {});
  const idea = (await f.get("")).implementations[0];
  const users = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(call => call.args[1] === "user").length;
  writeFileSync(f.state, JSON.stringify({ issues: [], pulls: [pull()], pause_user: users + 6 }));
  const sync = f.post(route + "/sync", {});
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.root, "reading")) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(join(f.root, "reading"))).toBe(true);
  try { expect((await f.post(`/implementations/${idea.id}/delete`, {})).status).toBe(200); }
  finally { writeFileSync(join(f.root, "continue"), "continue"); }
  await sync;
  expect(readFileSync(f.log, "utf8")).not.toContain('"PUT"');
  expect((await f.get("")).implementations).toEqual([]);
}, 15000);
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
