import { expect, test } from "bun:test";
import { factoryMergeFixture } from "./factory-merge.fixture.ts";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("an owner links verified delivery PRs and repository work finishes only after their merge covers its changes", async () => {
  const f = await factoryMergeFixture();
  try {
    const linked = await f.request(f.prefix + "/delivery", f.links);
    expect(linked.status).toBe(200);
    const evidence = await linked.json();
    expect(evidence.repository).toBe("fictional/project");
    expect(evidence.branch).toBe("main");
    expect(evidence.pull_numbers).toEqual([12]);
    const verified = await f.request(f.prefix + "/delivery/sync", { expected_revision: evidence.revision });
    expect(verified.status).toBe(200);
    const result = await verified.json();
    expect(result.condition).toBe("merged");
    expect(result.changes.map((file: { path: string }) => file.path)).toEqual(["findings.md"]);
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.implementation.outcome).toBe("merged");
    expect(detail.board.lane).toBe("done");
    expect(f.calls().every(call => !call.args.includes("--method") && !call.args.some(arg => arg.endsWith("/merge")))).toBe(true);
  } finally { await f.close(); }
});

test("the owner can correct a missing GitHub remote while retaining the original repository baseline and delivery branch", async () => {
  const f = await factoryMergeFixture(false, "merge", false);
  try {
    f.git(["remote", "add", "origin", "https://github.com/fictional/project.git"], f.run.worktree!);
    const response = await f.request(f.prefix + "/delivery", f.links);
    expect(response.status).toBe(200);
    const linked = await response.json();
    const scope = (await f.request(f.prefix).then(r => r.json())).implementation.delivery_scope;
    expect(scope.github_repository).toBe("fictional/project");
    expect(scope.base).toBe(f.run.base); expect(scope.branch).toBe("main");
    expect((await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json())).condition).toBe("merged");
  } finally { await f.close(); }
});

test("an unavailable delivery Machine keeps verification uncertain and tells the owner to reconnect", async () => {
  const f = await factoryMergeFixture(true);
  try {
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const calls = f.calls().length; f.disconnect();
    const result = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(result.condition).toBe("needs_you");
    expect(result.problem).toContain("Reconnect the Machine");
    expect(f.calls()).toHaveLength(calls);
    expect((await f.request(f.prefix).then(r => r.json())).board.lane).toBe("needs_you");
  } finally { await f.close(); }
});

test("partial delivery remains Needs you until every required PR is linked and verified merged", async () => {
  const f = await factoryMergeFixture();
  try {
    f.commit("second.md", "A second intended change\n");
    const second = f.git(["rev-parse", "HEAD:second.md"], f.run.worktree!).trim();
    const merge13 = "f".repeat(40);
    const finalTree = { ...f.tree, tree: [...f.tree.tree, { path: "second.md", mode: "100644", type: "blob", sha: second }] };
    f.data[`repos/fictional/project/git/trees/${f.tip}?recursive=1`] = finalTree;
    f.data["repos/fictional/project/pulls/13"] = { ...f.pull, number: 13, merged: false, merge_commit_sha: merge13 };
    f.data["repos/fictional/project/pulls/13/files?per_page=100&page=1"] = [{ filename: "second.md", status: "added", sha: second }];
    f.data[`repos/fictional/project/git/trees/${merge13}?recursive=1`] = finalTree;
    f.data[`repos/fictional/project/compare/${merge13}...${f.tip}`] = { status: "ahead", merge_base_commit: { sha: merge13 } }; f.respond();
    const first = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const partial = await f.request(f.prefix + "/delivery/sync", { expected_revision: first.revision }).then(r => r.json());
    expect(partial.condition).toBe("needs_you"); expect(partial.problem).toContain("only part");
    expect(partial.pulls[0].covered_paths).toEqual(["findings.md"]);
    const corrected = await f.request(f.prefix + "/delivery", { ...f.links, expected_revision: first.revision, pull_numbers: [12, 13] }).then(r => r.json());
    const pending = await f.request(f.prefix + "/delivery/sync", { expected_revision: corrected.revision }).then(r => r.json());
    expect(pending.condition).toBe("needs_you"); expect(pending.problem).toContain("PR #13 is not verified merged");
    expect((await f.request(f.prefix + "/delivery", { ...f.links, expected_revision: first.revision })).status).toBe(409);
    (f.data["repos/fictional/project/pulls/13"] as { merged: boolean }).merged = true; f.respond();
    const delivered = await f.request(f.prefix + "/delivery/sync", { expected_revision: corrected.revision }).then(r => r.json());
    expect(delivered.condition).toBe("merged");
    expect(delivered.pulls.map((pull: { number: number }) => pull.number)).toEqual([12, 13]);
    expect((await f.request(f.prefix).then(r => r.json())).board.lane).toBe("done");
  } finally { await f.close(); }
});

test("wrong targets, closed unmerged PRs, unrelated content and incomplete GitHub evidence retain a correction path", async () => {
  const f = await factoryMergeFixture();
  try {
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const original = JSON.stringify(f.data);
    const cases: [string, (data: Record<string, any>) => void][] = [
      ["another repository", data => { data["repos/fictional/project/pulls/12"].base.repo.full_name = "other/repository"; }],
      ["another repository or branch", data => { data["repos/fictional/project/pulls/12"].base.ref = "stable"; }],
      ["not verified merged", data => { data["repos/fictional/project/pulls/12"].merged = false; }],
      ["does not cover", data => { data["repos/fictional/project/pulls/12/files?per_page=100&page=1"][0].filename = "unrelated.md"; }],
      ["not contained", data => { data[`repos/fictional/project/compare/${f.merge}...${f.tip}`].status = "diverged"; }],
      ["incomplete", data => { data[`repos/fictional/project/git/trees/${f.merge}?recursive=1`].truncated = true; }],
      ["does not contain", data => { data[`repos/fictional/project/git/trees/${f.tip}?recursive=1`].tree = []; }],
    ];
    for (const [reason, change] of cases) {
      Object.assign(f.data, JSON.parse(original)); change(f.data); f.respond();
      const result = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
      expect(result.condition).toBe("needs_you"); expect(result.problem).toContain(reason);
      const detail = await f.request(f.prefix).then(r => r.json());
      expect(detail.board.lane).toBe("needs_you"); expect(detail.implementation.outcome).toBe("none");
    }
    expect(f.calls().some(call => call.args.includes("--method"))).toBe(false);
  } finally { await f.close(); }
});

test("delivery uses the explicitly selected remote Machine's GitHub profile and never a coordinator account", async () => {
  const f = await factoryMergeFixture(true);
  try {
    expect((await f.request(f.prefix + "/delivery", { ...f.links, machine_id: "local" })).status).toBe(400);
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    expect(linked.machine_id).toBe("delivery-host");
    const result = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(result.condition).toBe("merged");
    expect(f.calls().every(call => call.scoped && !call.token)).toBe(true);
    expect((await f.request(f.prefix).then(r => r.json())).board.lane).toBe("done");
    expect(JSON.stringify(result)).not.toContain("owned-delivery-host");
    expect(JSON.stringify(result)).not.toContain("GH_CONFIG_DIR");
  } finally { await f.close(); }
});

test("verified merges cannot bypass a containing-release milestone frozen before a Project settings change", async () => {
  const f = await factoryMergeFixture(false, "release");
  try {
    await f.request(`/projects/${f.project.id}/configure`, { delivery_policy: "merge" });
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const result = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(result.condition).toBe("merged");
    expect(result.problem).toContain("containing release");
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.implementation.delivery_scope.milestone).toBe("release");
    expect(detail.board.lane).not.toBe("done"); expect(detail.implementation.outcome).toBe("none");
  } finally { await f.close(); }
});

test("replacement of the delivery branch during verification retains Needs you even when its files look delivered", async () => {
  const f = await factoryMergeFixture();
  try {
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    f.data.pause = "repos/fictional/project/pulls/12/files?per_page=100&page=1"; f.respond();
    const pending = f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(f.githubRoot, "reading")) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(f.githubRoot, "reading"))).toBe(true);
    f.data["repos/fictional/project/branches/main"] = { name: "main", commit: { sha: "e".repeat(40) } }; f.respond();
    writeFileSync(join(f.githubRoot, "continue"), "continue");
    const evidence = await (await pending).json();
    expect(evidence.condition).toBe("needs_you");
    expect(evidence.problem).toContain("branch changed");
  } finally { await f.close(); }
});

test("linked delivery PRs wait for a manual merge even when a Project's existing PR workflow enables automatic merges", async () => {
  const f = await factoryMergeFixture();
  try {
    const connection = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    const pull = { number: 12, id: "owned-pr-12", title: "Deliver findings", body: "", url: f.pull.html_url, state: "OPEN", isDraft: false, headRefOid: f.head, baseRefOid: f.run.base, headRefName: "findings", baseRefName: "main", author: { login: "fictional-owner" }, headRepository: { nameWithOwner: "fictional/project" }, viewerCanUpdate: true, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
      reviews: connection([{ id: "review-1", state: "APPROVED", body: "Owned approval", submittedAt: "2026-10-14T10:00:00Z", author: { login: "fictional-reviewer" }, commit: { oid: f.head } }]), reviewRequests: connection([]), reviewThreads: connection([]),
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: connection([{ name: "Fast checks", status: "COMPLETED", conclusion: "SUCCESS" }]) } } }] },
      baseRef: { branchProtectionRule: { isAdminEnforced: true, requiresApprovingReviews: true, requiredApprovingReviewCount: 1, requiresStatusChecks: true, requiresStrictStatusChecks: true, requiresConversationResolution: true, requiredStatusCheckContexts: ["Fast checks"] } } };
    f.pull.merged = false; f.pull.state = "open";
    f.data.graphql = { data: { repository: { viewerPermission: "ADMIN", pullRequests: connection([pull]), pullRequest: pull } } };
    f.data["repos/fictional/project/pulls/12/merge"] = { merged: true, sha: f.merge }; f.respond();
    await f.request(f.prefix + "/delivery", f.links);
    const route = `/projects/${f.project.id}/github`;
    expect((await f.request(route + "/configure", { expected_revision: null, repository: "fictional/project", account_profile_id: f.profile.id, sync_enabled: false, import_issues: false, import_fixes: false, auto_update: false, auto_merge: true, trusted_reviewers: ["fictional-reviewer"], required_checks: ["Fast checks"], review_context: "", poll_minutes: 15 })).status).toBe(200);
    expect((await f.request(route + "/sync", {})).status).toBe(200);
    expect(f.calls().some(call => call.args[1]?.endsWith("/merge"))).toBe(false);
    expect((await f.request(f.prefix).then(r => r.json())).board.lane).toBe("needs_you");
  } finally { await f.close(); }
});

test("verified merge completion releases a resting Run for archiving while retaining its native chat", async () => {
  const f = await factoryMergeFixture();
  try {
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    expect((await f.request(f.prefix + "/archive", {})).status).toBe(200);
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.runs[0].condition).toBe("completed");
    expect(detail.runs[0].pane_id).toBe(f.run.pane_id);
    expect(detail.implementation.outcome).toBe("merged");
  } finally { await f.close(); }
});

test("changing a checkout's GitHub remote after Start cannot relink delivery to a different repository", async () => {
  const f = await factoryMergeFixture();
  try {
    f.git(["remote", "set-url", "origin", "https://github.com/fictional/other.git"], f.run.worktree!);
    f.data["repos/fictional/other"] = { full_name: "fictional/other" }; f.respond();
    const response = await f.request(f.prefix + "/delivery", f.links);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("delivery_repository_required");
  } finally { await f.close(); }
});

test("a PR that merely touches an intended filename cannot claim changes inherited from another merge", async () => {
  const f = await factoryMergeFixture();
  try {
    f.data["repos/fictional/project/pulls/12/files?per_page=100&page=1"] = [{ filename: "findings.md", status: "modified", sha: "d".repeat(40) }]; f.respond();
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const evidence = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(evidence.condition).toBe("needs_you");
    expect(evidence.problem).toContain("does not cover");
    expect((await f.request(f.prefix).then(r => r.json())).board.lane).toBe("needs_you");
  } finally { await f.close(); }
});

test("missing delivery linkage asks the owner to link PR evidence instead of treating a clean committed worktree as delivered", async () => {
  const f = await factoryMergeFixture();
  try {
    expect((await f.request(f.prefix + "/delivery/sync", { expected_revision: null })).status).toBe(409);
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.board.lane).toBe("needs_you");
    expect(detail.board.waiting_reason).toContain("Link");
    expect(detail.implementation.outcome).toBe("none");
  } finally { await f.close(); }
});

test("Project GitHub synchronization completes a linked delivery once without sending a merge", async () => {
  const f = await factoryMergeFixture();
  try {
    f.data.graphql = { data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }; f.respond();
    await f.request(f.prefix + "/delivery", f.links);
    const route = `/projects/${f.project.id}/github`;
    const policy = await f.request(route + "/configure", { expected_revision: null, repository: "fictional/project", account_profile_id: f.profile.id, sync_enabled: false, import_issues: false, import_fixes: false, auto_update: false, auto_merge: false, trusted_reviewers: [], required_checks: [], review_context: "", poll_minutes: 15 });
    expect(policy.status).toBe(200);
    expect((await f.request(route + "/sync", {})).status).toBe(200);
    let detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.board.lane).toBe("done");
    const delivered = detail.events.filter((event: { kind: string }) => event.kind === "assignment_delivered");
    expect(delivered).toHaveLength(1);
    expect((await f.request(route + "/sync", {})).status).toBe(200);
    detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.events.filter((event: { kind: string }) => event.kind === "assignment_delivered").map((event: { id: string }) => event.id)).toEqual(delivered.map((event: { id: string }) => event.id));
    expect(f.calls().every(call => !call.args.includes("--method") && !call.args.some(arg => arg.endsWith("/merge")))).toBe(true);
  } finally { await f.close(); }
});

test("changes committed during verification remain visible and cannot be completed by older PR evidence", async () => {
  const f = await factoryMergeFixture();
  try {
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    f.data.pause = `repos/fictional/project/git/trees/${f.tip}?recursive=1`; f.respond();
    const pending = f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(f.githubRoot, "reading")) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(f.githubRoot, "reading"))).toBe(true);
    f.commit("more.md", "A later intended change\n");
    writeFileSync(join(f.githubRoot, "continue"), "continue");
    const evidence = await (await pending).json();
    expect(evidence.condition).toBe("needs_you");
    expect(evidence.problem).toContain("changes");
    expect((await f.request(f.prefix).then(r => r.json())).board.lane).toBe("needs_you");
  } finally { await f.close(); }
});
