import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "bun:test";
import { createServer } from "./index.ts";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { published, until } from "../scripts/factory-human-review-fixture.ts";
import { githubFixture } from "../scripts/factory-github-fixture.ts";
function connection<T>(nodes: T[]) { return { nodes, pageInfo: { hasNextPage: false, endCursor: null } }; }
function pull(state = "APPROVED") {
  return { number: 27, id: "fictional-pr-27", title: "Improve imports", body: "Fictional patch", url: "https://github.com/fictional/project/pull/27", state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), headRefName: "feature", baseRefName: "main", author: { login: "fictional-owner" }, headRepository: { nameWithOwner: "fictional/project" }, viewerCanUpdate: true, mergeStateStatus: "CLEAN", reviewDecision: state === "APPROVED" ? "APPROVED" : "CHANGES_REQUESTED",
    reviews: connection([{ id: "review-1", state, body: "Please validate the acceptance cases", submittedAt: "2026-10-11T12:00:00Z", author: { login: "fictional-reviewer" }, commit: { oid: "a".repeat(40) } }]), reviewRequests: connection([]), reviewThreads: connection([]),
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: connection([{ name: "Fast checks", status: "COMPLETED", conclusion: "SUCCESS" }]) } } }] },
    baseRef: { branchProtectionRule: { isAdminEnforced: true, requiresApprovingReviews: true, requiredApprovingReviewCount: 1, requiresStatusChecks: true, requiresStrictStatusChecks: true, requiresConversationResolution: true, requiredStatusCheckContexts: ["Fast checks"] } } };
}
async function pendingPublication(f: Awaited<ReturnType<typeof capacityFixture>>) {
  await f.api("/settings", { max_agents: 1 });
  const id = await f.assignment("Human Review result"); const prefix = `/implementations/${id}`;
  const detail = () => f.api(prefix).then(r => r.json());
  await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixtures only", pull_request: { repository: "fictional/project", base_branch: "main" } });
  const spec = await f.api(`${prefix}/specifications`, { content: "Retain the reviewed result" }).then(r => r.json());
  await f.api(`${prefix}/specification-acceptance`, { source: "button", specification_id: spec.id, hash: spec.hash });
  const run = (await until(detail, d => d.runs.length === 1)).runs[0];
  await f.agent(run.id, "tickets", { specification_id: spec.id, testing_plan: "Public HTTP and desktop/mobile browser", tickets: [{ key: "one", title: "Reviewed result", acceptance: "Readable captured changes", dependencies: [] }] });
  f.runs.get(run.id)!.condition = "ready";
  for (const role of ["implementer", "standards", "spec"]) {
    const d = await until(detail, d => d.workers.some((w: any) => w.role === role && w.condition === "working"));
    f.workers.get(d.workers.find((w: any) => w.role === role).id)!.condition = "ready";
  }
  await until(detail, () => f.publications.has(run.id));
  return { id, prefix, detail, run };
}

for (const pending of [false, true]) test(`Delete suppresses an app-published PR ${pending ? "before its receipt" : "after confirmation"}, including restored backups`, async () => {
const g = await githubFixture();
const f = await capacityFixture({ advancingHeads: true, accountTools: { github: { executable: process.execPath, args: [join(g.root, "gh.mjs")] } } });
let releasePublication = () => {};
try {
  const gate = pending ? f.holdNextPublication() : null;
  if (gate) releasePublication = gate.release;
  const result = gate ? await pendingPublication(f) : await published(f);
  if (gate) assert.equal((await result.detail()).pull_requests.length, 0, "The publication receipt must still be unknown to the owner app");
  const pr = gate ? f.publications.get(result.run.id)! : (await result.detail()).pull_requests[0];
  const retained = pull("CHANGES_REQUESTED"); retained.headRefOid = pr.head; retained.headRefName = pr.branch;
  retained.reviews.nodes[0]!.commit.oid = pr.head; retained.mergeStateStatus = "BEHIND";
  writeFileSync(g.state, JSON.stringify({ issues: [], pulls: [retained] }));
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`http://localhost:${f.app.port}/api/factory${path}`, { headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    const data = await response.json(); return { status: response.status, body: data };
  };
  const profile = await api("/machines/local/accounts", { name: "Owned publication cleanup", service: "github", expected_login: "fictional-owner" });
  assert.equal(profile.status, 201, JSON.stringify(profile));
  const verified = await api(`/machines/local/accounts/${profile.body.id}/verify`, { expected_revision: profile.body.revision }); assert.equal(verified.status, 200, JSON.stringify(verified));
  const project = await api("/projects", { name: "Owned retained PR intake", path: join(g.root, "repo"), machine_id: "local", provider: "codex", tracker: "app" }); assert.equal(project.status, 201, JSON.stringify(project));
  const route = `/projects/${project.body.id}/github`;
  const configured = await api(route + "/configure", { ...g.policy, auto_update: true, account_profile_id: profile.body.id }); assert.equal(configured.status, 200, JSON.stringify(configured));
  const backup = await api("/backups", {}); assert.equal(backup.status, 201, JSON.stringify(backup));
  const deletion = await api(`/implementations/${result.id}/delete`, {}); assert.equal(deletion.body.condition, "deleted", JSON.stringify(deletion));
  releasePublication();
  const synced = await api(route + "/sync", {}); assert.equal(synced.status, 200, JSON.stringify(synced));
  const overview = await api("");
  assert.deepEqual(overview.body.implementations, [], "Deleting an app-published PR Assignment must suppress later automatic repair intake for its retained PR");
  assert(!readFileSync(g.log, "utf8").includes('"PUT"'), "Deleted PR automation must not update its retained branch");
  const restored = await api(`/backups/${backup.body.id}/restore`, {}); assert.equal(restored.status, 201, JSON.stringify(restored));
  const copy = createServer({ port: 0, stateDir: restored.body.state_dir, token: f.token, machines: false, factory: { accountDiscoveryHome: g.root, accountTools: { github: { executable: process.execPath, args: [join(g.root, "gh.mjs")] } } } });
  try {
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`http://localhost:${copy.port}/api/factory${path}`, { headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual((await request("")).body.implementations, []);
    const account = await request("/machines/local/accounts", { name: "Owned recovery", service: "github", expected_login: "fictional-owner" }); assert.equal(account.status, 201);
    assert.equal((await request(`/machines/local/accounts/${account.body.id}/verify`, { expected_revision: account.body.revision })).status, 200);
    const policy = (await request(route)).body.policy;
    assert.equal((await request(route + "/configure", { ...g.policy, auto_update: true, account_profile_id: account.body.id, expected_revision: policy.revision })).status, 200);
    assert.equal((await request(route + "/sync", {})).status, 200);
    assert.deepEqual((await request("")).body.implementations, [], "Restored backups must retain published-PR suppression");
    assert(!readFileSync(g.log, "utf8").includes('"PUT"'));
  } finally { copy.stop(); }
  const explicit = await api(route + "/pulls/27/import", { head: retained.headRefOid, base: retained.baseRefOid, policy_revision: configured.body.revision });
  assert.equal(explicit.status, 200, JSON.stringify(explicit));
  const fresh = (await api("")).body.implementations;
  assert.equal(fresh.length, 1); assert.notEqual(fresh[0].id, result.id);
  assert.deepEqual(JSON.parse(readFileSync(g.state, "utf8")).pulls, [retained], "The PR itself must survive Delete");
} finally { releasePublication(); f.close(); g.close(); }
}, 30000);
