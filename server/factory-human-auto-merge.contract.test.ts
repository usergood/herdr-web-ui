import { expect, it } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { githubFixture } from "../scripts/factory-github-fixture.ts";
import { published, until } from "../scripts/factory-human-review-fixture.ts";

const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
function cleanPull(head: string, branch: string) {
  return { number: 27, id: "owned-human-pr", title: "Owned candidate", body: "Fictional result", url: "https://github.com/fictional/project/pull/27", state: "OPEN", isDraft: false, headRefOid: head, baseRefOid: "b".repeat(40), headRefName: branch, baseRefName: "main", author: { login: "fictional-owner" }, headRepository: { nameWithOwner: "fictional/project" }, viewerCanUpdate: true, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", reviews: connection([{ id: "owned-review", state: "APPROVED", submittedAt: "2026-10-16T00:00:00Z", author: { login: "fictional-reviewer" }, commit: { oid: head } }]), reviewRequests: connection([]), reviewThreads: connection([]), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: connection([{ name: "Fast checks", status: "COMPLETED", conclusion: "SUCCESS" }]) } } }] }, baseRef: { branchProtectionRule: { isAdminEnforced: true, requiresApprovingReviews: true, requiredApprovingReviewCount: 1, requiresStatusChecks: true, requiresStrictStatusChecks: true, requiresConversationResolution: true, requiredStatusCheckContexts: ["Fast checks"] } } };
}
for (const scenario of ["before approval", "after Decline", "before publication acknowledgment"] as const) it(`Project auto-merge cannot bypass factory Human Review ${scenario}`, async () => {
  const g = await githubFixture();
  const f = await capacityFixture({ advancingHeads: true, accountTools: { github: { executable: process.execPath, args: [join(g.root, "gh.mjs")] } } });
  const api = (path: string, body?: unknown) => fetch(`http://localhost:${f.app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const gate = scenario === "before publication acknowledgment" ? f.holdNextPublication() : null;
  try {
    const { prefix, detail, run } = await published(f, "merge", !gate);
    await until(detail, () => f.publications.has(run.id));
    if (scenario === "after Decline") {
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const r = ready.human_reviews[0];
      const comment = await api(`${prefix}/comments`, { snapshot_id: r.snapshot_id, path: "progress.ts", change: "branch:M", side: "new", line_start: 1, line_end: 1, content: "Repair before any later approval" }).then(r => r.json());
      expect((await api(`${prefix}/human-review/submit`, { review_id: r.id, snapshot_id: r.snapshot_id, head: r.head, disposition: "decline", comment_ids: [comment.id], idempotency_key: "decline-owned" })).status).toBe(202);
    }
    const pr = f.publications.get(run.id)!;
    const pull = cleanPull(pr.head, pr.branch); writeFileSync(g.state, JSON.stringify({ issues: [], pulls: [pull] }));
    const profile = await api("/machines/local/accounts", { name: "Owned GitHub", service: "github", expected_login: "fictional-owner" }).then(r => r.json());
    expect((await api(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision })).status).toBe(200);
    const project = await api("/projects", { name: "Other Project sharing repository", path: join(g.root, "repo"), machine_id: "local", provider: "codex", tracker: "app" }).then(r => r.json());
    const route = `/projects/${project.id}/github`;
    const policy = await api(route + "/configure", { ...g.policy, auto_merge: true, account_profile_id: profile.id }).then(r => r.json());
    expect((await api(route + "/sync", {})).status).toBe(200);
    expect(readFileSync(g.log, "utf8")).not.toContain('/pulls/27/merge');
    const manual = await api(route + "/pulls/27/merge", { head: pull.headRefOid, base: pull.baseRefOid, policy_revision: policy.revision });
    expect(manual.status).toBe(409);
    expect(await manual.json()).toMatchObject({ error: { code: "human_review_required" } });
    expect((await detail()).human_review_approvals).toHaveLength(0);
    const external = { ...cleanPull("c".repeat(40), "external-owned-feature"), number: 28, id: "external-pr", url: "https://github.com/fictional/project/pull/28" }; writeFileSync(g.state, JSON.stringify({ issues: [], pulls: [external] }));
    expect((await api(route + "/sync", {})).status).toBe(200);
    expect(readFileSync(g.log, "utf8")).toContain('/pulls/28/merge');
  } finally { gate?.release(); f.close(); g.close(); }
}, 30000);


it("a newly confirmed factory branch fences an auto-merge waiting at its final identity check", async () => {
  const g = await githubFixture();
  const f = await capacityFixture({ accountTools: { github: { executable: process.execPath, args: [join(g.root, "gh.mjs")] } } });
  const gate = f.holdNextAllocation(); let syncing: Promise<Response> | undefined;
  const api = (path: string, body?: unknown) => fetch(`http://localhost:${f.app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const profile = await api("/machines/local/accounts", { name: "Owned race", service: "github", expected_login: "fictional-owner" }).then(r => r.json());
    expect((await api(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision })).status).toBe(200);
    const project = await api("/projects", { name: "Owned shared repository", path: join(g.root, "repo"), machine_id: "local", provider: "codex", tracker: "app" }).then(r => r.json());
    const route = `/projects/${project.id}/github`;
    expect((await api(route + "/configure", { ...g.policy, auto_merge: true, account_profile_id: profile.id })).status).toBe(200);
    const id = await f.assignment("Allocating factory result"); const prefix = `/implementations/${id}`;
    const detail = () => f.api(prefix).then(r => r.json());
    await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixture", pull_request: { repository: "fictional/project", base_branch: "main" } });
    const spec = await f.api(`${prefix}/specifications`, { content: "Owned factory candidate" }).then(r => r.json());
    await f.api(`${prefix}/specification-acceptance`, { source: "button", specification_id: spec.id, hash: spec.hash });
    const runId = await gate.started;
    expect((await detail()).runs[0].branch).toBeNull();
    const users = readFileSync(g.log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(call => call.args[1] === "user").length;
    writeFileSync(g.state, JSON.stringify({ issues: [], pulls: [cleanPull("1".repeat(40), `owned-${runId}`)], pause_user: users + 6 }));
    syncing = api(route + "/sync", {});
    await until(async () => existsSync(join(g.root, "reading")), reading => reading);
    gate.release();
    await until(detail, d => d.runs[0].branch === `owned-${runId}`);
    writeFileSync(join(g.root, "continue"), "continue");
    expect((await syncing).status).toBe(409);
    expect(readFileSync(g.log, "utf8")).not.toContain('/pulls/27/merge');
  } finally { gate.release(); writeFileSync(join(g.root, "continue"), "continue"); await syncing?.catch(() => {}); f.close(); g.close(); }
}, 30000);
