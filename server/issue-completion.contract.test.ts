import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { githubReviewFixture } from "../scripts/fixtures/github-review.ts";
import { githubDeliveryResponses } from "../scripts/fixtures/github-delivery.ts";
import type { ProjectPullRequest } from "../shared/github-project.ts";

async function prepareManual(fixture: ReturnType<typeof githubReviewFixture>) {
  const { project } = await fixture.setup();
  const assignment = await fixture.json("/implementations", { title: "Owned manual Assignment", description: "Show a greeting", project_id: project.id });
  const path = `/implementations/${assignment.id}`;
  const specification = await fixture.json(path + "/specifications", { content: "Show hello through the public HTTP interface." });
  for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Owned fixture approval for public HTTP" });
  const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "greeting", title: "Greeting", acceptance: "Show hello", dependencies: [] }] });
  await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Owned fixture graph approval" });
  const run = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "owned-manual-implementation" });
  return { path, run };
}

test("owner acceptance completes a manual Assignment and allows archiving without GitHub delivery evidence", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path } = await prepareManual(fixture);
    await fixture.integrate(run);
    const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/accept`, { head: check.head });
    const detail = await fixture.json(path);
    expect(detail.github_sources).toEqual([]);
    expect(detail.implementation).toMatchObject({ stage: "done", outcome: "implementation_complete" });
    expect(detail.implementation.activity).toBeUndefined();
    expect(detail.approvals).toContainEqual(expect.objectContaining({ kind: "review", revision: check.head }));
    expect((await fixture.json(path + "/archive", {})).archived_at).toEqual(expect.any(String));
  } finally { fixture.close(); }
}, 20_000);

test("automatic retirement of manual execution still requires owner acceptance before completion and archiving", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path } = await prepareManual(fixture);
    await fixture.integrate(run);
    const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("completed");
    fixture.restart();
    const detail = await fixture.json(path);
    expect(detail.implementation).toMatchObject({ stage: "review", outcome: "none" });
    expect(detail.implementation.activity).toBeUndefined();
    expect(detail.approvals.some((approval: any) => approval.kind === "review")).toBe(false);
    const archive = await fixture.post(path + "/archive", {});
    expect(archive.status).toBe(409); expect((await archive.json()).error.code).toBe("assignment_unfinished");
    await fixture.json(`/runs/${run.id}/accept`, { head: check.head });
    expect((await fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: "implementation_complete" });
    expect((await fixture.json(path + "/archive", {})).archived_at).toEqual(expect.any(String));
  } finally { fixture.close(); }
}, 20_000);

test("ordinary manual work retains its explicit completion and archiving path", async () => {
  const fixture = githubReviewFixture();
  try {
    const { project } = await fixture.setup();
    const assignment = await fixture.json("/implementations", { title: "Owned direct work", description: "Fictional manual work", project_id: project.id });
    const path = `/implementations/${assignment.id}`;
    fixture.setNativeIdentity();
    const run = await fixture.json(path + "/runs", { action: "work", idempotency_key: "owned-direct-work" });
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("ready");
    expect((await fixture.json(path)).implementation.stage).toBe("running");
    expect(await fixture.json(path + "/complete-work", { run_id: run.id })).toMatchObject({ stage: "done", outcome: "implementation_complete" });
    expect((await fixture.json(path + "/archive", {})).archived_at).toEqual(expect.any(String));
  } finally { fixture.close(); }
}, 20_000);

test("explicitly cancelling ordinary manual work still releases ownership and allows clean checkout removal", async () => {
  const fixture = githubReviewFixture();
  try {
    const { project } = await fixture.setup();
    const assignment = await fixture.json("/implementations", { title: "Cancelled manual work", description: "Owned disposable work", project_id: project.id });
    const path = `/implementations/${assignment.id}`;
    const run = await fixture.json(path + "/runs", { action: "work", idempotency_key: "manual-cancel" });
    const stopped = await fixture.json(`/runs/${run.id}/stop`, {});
    expect(stopped.condition).toBe("cancelled"); expect(stopped.implementation_completion).toBeUndefined();
    fixture.restart();
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("cancelled");
    expect(await fixture.json(`/runs/${run.id}/cleanup`, {})).toMatchObject({ removed: [run.worktree] });
    expect((await fixture.json(path)).approvals).toEqual([]);
    expect((await fixture.json(path + "/runs", { action: "work", idempotency_key: "manual-after-cancel" })).condition).toBe("working");
  } finally { fixture.close(); }
}, 15_000);

test.each(["merge", "release"])("ordinary Start work on an imported issue awaits verified %s delivery and cannot archive from closure", async requires => {
  const fixture = githubReviewFixture();
  try {
    const { route } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    fixture.setNativeIdentity();
    const run = await fixture.json(path + "/runs", { action: "work", idempotency_key: "manual-imported-issue" });
    expect(run.manifest.issue_admission).toBeUndefined();
    await fixture.json(path + "/complete-work", { run_id: run.id });
    expect((await fixture.json(path)).implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" });
    expect((await fixture.post(path + "/archive", {})).status).toBe(409);
    fixture.issue.state = "closed"; fixture.save();
    await fixture.json(route + "/sync", {}); fixture.restart();
    expect((await fixture.json(path)).implementation).toMatchObject({ stage: "review", activity: "awaiting_merge" });
    expect((await fixture.post(path + "/archive", {})).status).toBe(409);
    const current = (await fixture.json(route)).sources[0];
    await fixture.json(route + "/issues/1/delivery", { source_revision: current.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: requires === "release" ? "v1" : null });
    fixture.setApiResponses(githubDeliveryResponses({ targetBranch: "other" }));
    await fixture.json(route + "/sync", {});
    expect((await fixture.post(path + "/archive", {})).status).toBe(409);
    fixture.setApiResponses(githubDeliveryResponses({ merged: false }));
    await fixture.json(route + "/sync", {});
    expect((await fixture.post(path + "/archive", {})).status).toBe(409);
    if (requires === "release") {
      fixture.setApiResponses(githubDeliveryResponses({ containsRelease: false }));
      await fixture.json(route + "/sync", {});
      expect((await fixture.post(path + "/archive", {})).status).toBe(409);
    }
    fixture.setApiResponses(githubDeliveryResponses());
    await fixture.json(route + "/sync", {});
    expect((await fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: requires === "release" ? "released" : "merged", delivery_evidence: { source_id: source.id, requires, merges: [{ number: 27, head: "a".repeat(40), target_branch: "main" }] } });
    expect((await fixture.json(path + "/archive", {})).archived_at).toEqual(expect.any(String));
  } finally { fixture.close(); }
}, 20_000);

test("ordinary Work on a PR fix source preserves manual completion and archiving", async () => {
  const fixture = githubReviewFixture();
  try {
    const { route, configuration } = await fixture.setup();
    const connection = <T,>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    const pull: ProjectPullRequest = { number: 27, id: "fictional-fix-27", title: "Owned review fix", body: "Fictional patch", url: "https://github.com/fictional/project/pull/27", state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), author: { login: "fictional-owner" }, headRefName: "owned-fix", baseRefName: "main", headRepository: { nameWithOwner: "fictional/project" }, viewerCanUpdate: true, mergeStateStatus: "CLEAN", reviewDecision: "CHANGES_REQUESTED", baseRef: null,
      reviews: connection([{ id: "review-1", state: "CHANGES_REQUESTED", body: "Show a greeting", submittedAt: "2026-10-03T12:00:00Z", author: { login: "fictional-reviewer" }, commit: { oid: "a".repeat(40) } }]), reviewRequests: connection([]), reviewThreads: connection([]), commits: { nodes: [] } };
    fixture.setApiResponses({ graphql: { data: { repository: { pullRequests: connection([pull]) } } } });
    const policy = (await fixture.json(route)).policy;
    await fixture.json(route + "/configure", { ...configuration, expected_revision: policy.revision, import_issues: false, import_fixes: true, trusted_reviewers: ["fictional-reviewer"] });
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    expect(source.kind).toBe("fix");
    const path = `/implementations/${source.implementation_id}`;
    fixture.setNativeIdentity();
    const run = await fixture.json(path + "/runs", { action: "work", idempotency_key: "owned-pr-fix-work" });
    expect(await fixture.json(path + "/complete-work", { run_id: run.id })).toMatchObject({ stage: "done", outcome: "implementation_complete" });
    expect((await fixture.json(path + "/archive", {})).archived_at).toEqual(expect.any(String));
  } finally { fixture.close(); }
}, 20_000);

test("accepting a checked and independently reviewed issue implementation awaits merge without establishing Done", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path } = await fixture.prepare();
    await fixture.integrate(run);
    const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    expect((await fixture.post(`/runs/${run.id}/accept`, { head: check.head })).status).toBe(200);
    const detail = await fixture.json(path);
    expect(detail.implementation).toMatchObject({ stage: "review", outcome: "implementation_complete" });
    expect(detail.implementation.activity).toBe("awaiting_merge");
    expect(detail.approvals.some((approval: any) => approval.kind === "review")).toBe(true);
  } finally { fixture.close(); }
}, 20_000);

test("owner Retry cannot bypass a failed-looking parent whose retirement is still uncertain", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: false, max_implementations: 2 });
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    fixture.setStopCondition("failed");
    expect((await fixture.post(`/runs/${run.id}/reconcile`, {})).status).toBe(409);
    const admitted = (run.manifest as any).issue_admission;
    const retry = await fixture.post(`/runs/${run.id}/retry`, { idempotency_key: "no-uncertain-retirement-retry", issue_scope: { source_id: admitted.source.id, source_revision: admitted.source.revision, graph_hash: run.graph_hash } });
    expect(retry.status).toBe(409);
    expect((await fixture.json(path)).runs).toHaveLength(1);
  } finally { fixture.close(); }
}, 20_000);

test("restart keeps uncertain retirement recoverable through public controls while retaining its slot", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    fixture.setUncertainStop(true);
    expect((await fixture.post(`/runs/${run.id}/reconcile`, {})).status).toBe(409);
    fixture.restart();
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
    expect((await fixture.json(path)).runs[0].implementation_completion_pending).toBe(true);
    fixture.setUncertainStop(false);
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("completed");
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0, available_slots: 1 });
  } finally { fixture.close(); }
}, 20_000);

test("uncertain implementation retirement cannot authorize cleanup or release its slot", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    fixture.setStopCondition("failed");
    expect((await fixture.post(`/runs/${run.id}/reconcile`, {})).status).toBe(409);
    expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(409);
    fixture.restart();
    expect((await fixture.json(path)).runs[0].implementation_completion_pending).toBe(true);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
  } finally { fixture.close(); }
}, 20_000);

test("finishing a later direct-work step cannot mark an admitted issue delivered", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    fixture.setNativeIdentity();
    const work = await fixture.json(path + "/runs", { action: "work", idempotency_key: "follow-up-direct-work" });
    const completed = await fixture.json(path + "/complete-work", { run_id: work.id });
    expect(completed).toMatchObject({ stage: "review", activity: "awaiting_merge" });
    expect(completed.outcome).not.toBe("merged"); expect(completed.outcome).not.toBe("released");
  } finally { fixture.close(); }
}, 20_000);

test.each(["worker", "build"])("a retained %s still owns capacity after a coordinator looks completed", async kind => {
  const fixture = githubReviewFixture();
  try {
    const { run, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    if (kind === "worker") await fixture.json(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "unconsumed-native-worker" });
    else {
      fixture.setCheck("interrupted"); await fixture.json(`/runs/${run.id}/checks`, {});
      fixture.setCheck("passed"); await fixture.json(`/runs/${run.id}/checks`, {});
    }
    fixture.setCoordinator("completed"); await fixture.json(`/runs/${run.id}/reconcile`, {});
    fixture.restart();
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
    expect((await fixture.post(`/runs/${run.id}/accept`, { head: "a".repeat(40) })).status).toBe(409);
  } finally { fixture.close(); }
}, 20_000);

test.each(["failed", "stale"])("%s review evidence cannot finish implementation execution", async kind => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards");
    if (kind === "failed") fixture.setReview("failed"); else fixture.setHead("b".repeat(40));
    await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
    expect((await fixture.json(path)).implementation.activity).toBeUndefined();
  } finally { fixture.close(); }
}, 20_000);

test("stale completion keeps Needs you and its slot across cached native cancellation, restart and Stop until exact proof is restored", async () => {
  const fixture = githubReviewFixture();
  try {
    fixture.setNativeIdentity();
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("completed");
    fixture.setHead("b".repeat(40));
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("needs_you");
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 1) fixture.restart();
      if (attempt === 2) await fixture.json(`/runs/${run.id}/stop`, {});
      expect(await fixture.json(`/runs/${run.id}/reconcile`, {})).toMatchObject({ condition: "needs_you", waiting_reason: expect.stringContaining("evidence changed") });
      expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
      expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(409);
      expect((await fixture.json(path)).implementation.activity).toBeUndefined();
    }
    fixture.setHead(check.head);
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("completed");
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0, available_slots: 1 });
    expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(409);
    await fixture.json(`/runs/${run.id}/accept`, { head: check.head });
    expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(200);
  } finally { fixture.close(); }
}, 15_000);

test("a revision changed during native retirement cannot release implementation capacity", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    fixture.setStopHead("b".repeat(40));
    expect((await fixture.post(`/runs/${run.id}/reconcile`, {})).status).toBe(409);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
    expect((await fixture.json(path)).implementation.activity).toBeUndefined();
  } finally { fixture.close(); }
}, 20_000);

test("confirmed native retirement with a changed checkout recovers after restart when the exact checked revision is restored", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, route } = await fixture.prepare();
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    fixture.setStopHead("b".repeat(40));
    expect((await fixture.post(`/runs/${run.id}/reconcile`, {})).status).toBe(409);
    fixture.restart();
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("needs_you");
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
    fixture.setHead(check.head);
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("completed");
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0, available_slots: 1 });
  } finally { fixture.close(); }
}, 15_000);

test("explicit Stop of a controlled pause can cancel an invalidated retired contract while retaining its pause and history", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    fixture.setHead("b".repeat(40)); await fixture.json(`/runs/${run.id}/reconcile`, {});
    fixture.issue.body += "\nA changed requirement after retirement.";
    fixture.save(); await fixture.json(route + "/sync", {});
    expect((await fixture.json(path)).runs[0].issue_pause).toBeDefined();
    const stopped = await fixture.json(`/runs/${run.id}/stop`, {});
    expect(stopped.condition).toBe("cancelled"); expect(stopped.issue_pause).toBeDefined();
    fixture.restart();
    const reconciled = await fixture.json(`/runs/${run.id}/reconcile`, {});
    expect(reconciled.condition).toBe("cancelled"); expect(reconciled.issue_pause).toEqual(stopped.issue_pause);
    expect((await fixture.json(path)).approvals).toEqual([]);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0 });
  } finally { fixture.close(); }
}, 15_000);

test("an uncertain stop response retains capacity despite finished checks and reviews", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    fixture.setStopCondition("working");
    expect((await fixture.post(`/runs/${run.id}/reconcile`, {})).status).toBe(409);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
    expect((await fixture.json(path)).implementation.activity).toBeUndefined();
  } finally { fixture.close(); }
}, 20_000);

test("owner acceptance cannot release a still-working implementation coordinator", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path } = await fixture.prepare();
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    fixture.setCoordinator("working");
    const accepted = await fixture.post(`/runs/${run.id}/accept`, { head: check.head });
    expect(accepted.status).toBe(409);
    expect((await fixture.json(path)).approvals).toEqual([]);
    fixture.setCoordinator("ready");
    expect((await fixture.post(`/runs/${run.id}/accept`, { head: check.head })).status).toBe(200);
  } finally { fixture.close(); }
}, 20_000);

test("a changed checked workspace reclaims released capacity before unrelated admission", async () => {
  const fixture = githubReviewFixture();
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Unrelated scope" }]);
    const { run, path, route, readiness } = await fixture.prepare();
    const second = await fixture.second(route, readiness);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    fixture.setWorkspaceHash("changed-after-review");
    const refused = await fixture.post(second.path + "/runs", second.start);
    expect(refused.status).toBe(409);
    expect((await fixture.json(second.path)).runs).toEqual([]);
    expect((await fixture.json(path)).implementation.activity).toBeUndefined();
  } finally { fixture.close(); }
}, 20_000);

test("verified owner cleanup preserves exact completion and released capacity across restart and repeated reconciliation", async () => {
  const fixture = githubReviewFixture();
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "After cleanup" }]);
    const { run, path, route, readiness } = await fixture.prepare();
    const second = await fixture.second(route, readiness);
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/accept`, { head: check.head });
    const completion = (await fixture.json(path)).runs[0].implementation_completion;
    expect(await fixture.json(`/runs/${run.id}/cleanup`, {})).toMatchObject({ removed: [run.worktree], branches_retained: true, notes_retained: true });
    fixture.restart();
    for (let attempt = 0; attempt < 2; attempt++) {
      const reconciled = await fixture.json(`/runs/${run.id}/reconcile`, {});
      expect(reconciled.condition).toBe("completed");
      expect(reconciled.implementation_completion).toEqual(completion);
      expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0, available_slots: 1 });
    }
    await fixture.json("/settings", { max_implementations: 1 });
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(202);
    expect((await fixture.json(path)).implementation).toMatchObject({ stage: "review", activity: "awaiting_merge" });
  } finally { fixture.close(); }
}, 20_000);

test("redundant Stop preserves unaccepted completion and its cleanup gate through restart and reconciliation", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path } = await fixture.prepare();
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    const finished = await fixture.json(`/runs/${run.id}/reconcile`, {});
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) fixture.restart();
      const stopped = await fixture.json(`/runs/${run.id}/stop`, {});
      expect(stopped.condition).toBe("completed");
      expect(stopped.implementation_completion).toEqual(finished.implementation_completion);
      const reconciled = await fixture.json(`/runs/${run.id}/reconcile`, {});
      expect(reconciled.implementation_completion).toEqual(finished.implementation_completion);
      const cleanup = await fixture.post(`/runs/${run.id}/cleanup`, {});
      expect(cleanup.status).toBe(409);
      expect((await cleanup.json()).error.code).toBe("review_acceptance_required");
      expect((await fixture.json(path)).approvals).toEqual([]);
    }
    await fixture.json(`/runs/${run.id}/accept`, { head: check.head });
    expect(await fixture.json(`/runs/${run.id}/cleanup`, {})).toMatchObject({ removed: [run.worktree] });
  } finally { fixture.close(); }
}, 15_000);

test.each(["completion", "invalidation"])("a Stop already in flight cannot discard %s retained before its native response", async kind => {
  const fixture = githubReviewFixture(); let release = () => {}; let pending: Promise<Response> | undefined;
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    const gate = fixture.holdStop(); release = gate.release;
    pending = fixture.post(`/runs/${run.id}/stop`, {});
    await Promise.race([gate.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Stop did not reach the owned native gate")), 5000))]);
    let completed = await fixture.json(`/runs/${run.id}/reconcile`, {});
    expect(completed.condition).toBe("completed");
    if (kind === "invalidation") {
      fixture.setHead("b".repeat(40));
      completed = await fixture.json(`/runs/${run.id}/reconcile`, {});
    }
    release();
    const stopped = await (await pending).json();
    expect(stopped.condition).toBe(kind === "invalidation" ? "needs_you" : "completed");
    expect(stopped.implementation_completion).toEqual(completed.implementation_completion);
    const cleanup = await fixture.post(`/runs/${run.id}/cleanup`, {});
    expect(cleanup.status).toBe(409); expect((await cleanup.json()).error.code).toBe(kind === "invalidation" ? "run_owned" : "review_acceptance_required");
    expect((await fixture.json(route + "/queue")).implementing_count).toBe(kind === "invalidation" ? 1 : 0);
    expect((await fixture.json(path)).approvals).toEqual([]);
  } finally { release(); await pending?.catch(() => {}); fixture.close(); }
}, 15_000);

test("cleanup before owner acceptance preserves the checkout and explains how to accept first", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path } = await fixture.prepare();
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    const cleanup = await fixture.post(`/runs/${run.id}/cleanup`, {});
    expect(cleanup.status).toBe(409);
    expect((await cleanup.json()).error).toMatchObject({ code: "review_acceptance_required", message: expect.stringContaining("Accept reviewed head") });
    fixture.restart();
    expect((await fixture.json(path)).approvals).toEqual([]);
    expect((await fixture.post(`/runs/${run.id}/accept`, { head: check.head })).status).toBe(200);
    expect(await fixture.json(`/runs/${run.id}/cleanup`, {})).toMatchObject({ removed: [run.worktree] });
  } finally { fixture.close(); }
}, 15_000);

test("accepting an earlier Run at the same head does not authorize cleanup of its successor", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path } = await prepareManual(fixture);
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/accept`, { head: check.head });
    const successor = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "unaccepted-successor" });
    await fixture.integrate(successor); await fixture.json(`/runs/${successor.id}/checks`, {});
    await fixture.review(successor, "standards"); await fixture.review(successor, "spec");
    await fixture.json(`/runs/${successor.id}/reconcile`, {});
    const cleanup = await fixture.post(`/runs/${successor.id}/cleanup`, {});
    expect(cleanup.status).toBe(409); expect((await cleanup.json()).error.code).toBe("review_acceptance_required");
    expect((await fixture.json(path)).approvals.filter((approval: any) => approval.kind === "review")).toHaveLength(1);
    await fixture.json(`/runs/${successor.id}/accept`, { head: check.head });
    expect((await fixture.post(`/runs/${successor.id}/cleanup`, {})).status).toBe(200);
  } finally { fixture.close(); }
}, 15_000);

test.each(["unexpected", "lost", "unconfirmed", "other_checkout"] as const)("%s checkout loss cannot establish a completion cleanup receipt", async kind => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/accept`, { head: check.head });
    if (kind === "unexpected") fixture.setHeadUnavailable();
    else {
      fixture.setCleanupOutcome(kind);
      expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(kind === "lost" ? 503 : 200);
    }
    fixture.restart();
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
    const detail = await fixture.json(path);
    expect(detail.runs[0].implementation_completion).toBeUndefined();
    expect(detail.implementation.activity).toBeUndefined();
  } finally { fixture.close(); }
}, 20_000);

test.each(["before", "after"])("a workspace changed %s cleanup cannot establish or retain its completion proof", async when => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/accept`, { head: check.head });
    if (when === "after") await fixture.json(`/runs/${run.id}/cleanup`, {});
    fixture.setHeadUnavailable(false); fixture.setWorkspaceHash("changed-checkout");
    expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(409);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
    expect((await fixture.json(path)).runs[0].implementation_completion).toBeUndefined();
  } finally { fixture.close(); }
}, 20_000);

test("frozen setup and checks allow independent-review retirement, slot release and owner acceptance", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route, project } = await fixture.prepare({ setup: [["bun", "install", "--frozen-lockfile"], ["bun", "run", "prepare"]], checks: [["bun", "run", "typecheck"], ["bun", "run", "test:unit"]] });
    await fixture.integrate(run);
    await fixture.json(`/projects/${project.id}/configure`, { setup: [["bun", "install"]], checks: [["bun", "run", "build"]] });
    const check = await fixture.json(`/runs/${run.id}/checks`, {});
    expect(check.commands.map((command: any) => command.args)).toEqual([["bun", "install", "--frozen-lockfile"], ["bun", "run", "prepare"], ["bun", "run", "typecheck"], ["bun", "run", "test:unit"]]);
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    const finished = await fixture.json(`/runs/${run.id}/reconcile`, {});
    expect(finished).toMatchObject({ condition: "completed", implementation_completion: { head: check.head, workspace_hash: check.workspace_hash, check_id: check.id } });
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0, available_slots: 1 });
    expect((await fixture.json(path)).approvals).toEqual([]);
    expect((await fixture.post(`/runs/${run.id}/accept`, { head: check.head })).status).toBe(200);
    expect((await fixture.json(path)).approvals).toContainEqual(expect.objectContaining({ kind: "review", revision: check.head }));
  } finally { fixture.close(); }
}, 15_000);

test("passing check evidence must include the frozen Project commands before releasing or accepting implementation", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run } = await fixture.prepare();
    await fixture.integrate(run);
    fixture.setCheckCommands([]);
    const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("ready");
    const accepted = await fixture.post(`/runs/${run.id}/accept`, { head: check.head });
    expect(accepted.status).toBe(409); expect((await accepted.json()).error.code).toBe("fresh_evidence_required");
  } finally { fixture.close(); }
}, 20_000);

test.each([
  { kind: "missing setup", commands: [["bun", "run", "typecheck"]] },
  { kind: "missing later setup", commands: [["bun", "install", "--frozen-lockfile"], ["bun", "run", "typecheck"]] },
  { kind: "changed setup arguments", commands: [["bun", "install"], ["bun", "run", "prepare"], ["bun", "run", "typecheck"]] },
  { kind: "reordered setup", commands: [["bun", "run", "prepare"], ["bun", "install", "--frozen-lockfile"], ["bun", "run", "typecheck"]] },
  { kind: "checks before setup", commands: [["bun", "run", "typecheck"], ["bun", "install", "--frozen-lockfile"], ["bun", "run", "prepare"]] },
  { kind: "extra setup", commands: [["bun", "install", "--frozen-lockfile"], ["bun", "run", "prepare"], ["bun", "run", "extra"], ["bun", "run", "typecheck"]] },
  { kind: "failing first setup", commands: [["bun", "install", "--frozen-lockfile"], ["bun", "run", "prepare"], ["bun", "run", "typecheck"]], exitCodes: [1, 0, 0] },
  { kind: "failing later setup", commands: [["bun", "install", "--frozen-lockfile"], ["bun", "run", "prepare"], ["bun", "run", "typecheck"]], exitCodes: [0, 1, 0] },
  { kind: "setup only", commands: [["bun", "install", "--frozen-lockfile"], ["bun", "run", "prepare"]] },
])("$kind receipts retain capacity and reject acceptance despite a passing check status", async ({ commands, exitCodes }) => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare({ setup: [["bun", "install", "--frozen-lockfile"], ["bun", "run", "prepare"]], checks: [["bun", "run", "typecheck"]] });
    await fixture.integrate(run);
    fixture.setCheckCommands(commands.map(args => [...args]), exitCodes ? [...exitCodes] : undefined);
    const check = await fixture.json(`/runs/${run.id}/checks`, {});
    expect(check.condition).toBe("passed");
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("ready");
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1, available_slots: 0 });
    const accepted = await fixture.post(`/runs/${run.id}/accept`, { head: check.head });
    expect(accepted.status).toBe(409); expect((await accepted.json()).error.code).toBe("fresh_evidence_required");
    const detail = await fixture.json(path);
    expect(detail.runs[0].implementation_completion).toBeUndefined();
    expect(detail.approvals).toEqual([]);
  } finally { fixture.close(); }
}, 15_000);

test("setup commands without known checks cannot authorize implementation", async () => {
  const fixture = githubReviewFixture();
  try {
    await expect(fixture.prepare({ setup: [["bun", "install", "--frozen-lockfile"]], checks: [] })).rejects.toThrow("project_setup_required");
  } finally { fixture.close(); }
}, 15_000);

test("a completed-looking coordinator without both reviews retains the Project slot", async () => {
  const fixture = githubReviewFixture();
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Unrelated scope" }]);
    const { run, route, readiness } = await fixture.prepare();
    const second = await fixture.second(route, readiness);
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {}); await fixture.review(run, "standards");
    fixture.setCoordinator("completed");
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    const response = await fixture.post(second.path + "/runs", second.start);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("project_capacity_exhausted");
    expect((await fixture.json(second.path)).runs).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("reconciled implementation with current checks and both reviews frees capacity before owner acceptance or merge", async () => {
  const fixture = githubReviewFixture();
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Unrelated scope" }]);
    const { run, path, route, readiness } = await fixture.prepare();
    const second = await fixture.second(route, readiness);
    await fixture.integrate(run);
    await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    const finished = await fixture.json(`/runs/${run.id}/reconcile`, {});
    expect(finished.condition).toBe("completed");
    const detail = await fixture.json(path);
    expect(detail.implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "none" });
    expect(detail.approvals).toEqual([]);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0, available_slots: 1, entries: expect.arrayContaining([expect.objectContaining({ implementation_id: run.implementation_id, lane: "review", activity: "awaiting_merge" })]) });
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(202);
    fixture.restart();
    expect((await fixture.json(path)).implementation.stage).toBe("review");
    const check = detail.checks.filter((check: any) => check.worker_id === null).at(-1);
    expect((await fixture.post(`/runs/${run.id}/accept`, { head: check.head })).status).toBe(200);
    expect((await fixture.json(path)).implementation.stage).toBe("review");
  } finally { fixture.close(); }
}, 20_000);


test("historically accepted implementations with cleaned workspaces retain released capacity after upgrade", async () => {
  const fixture = githubReviewFixture();
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Next issue" }]);
    const { run, path, route, readiness } = await fixture.prepare();
    const second = await fixture.second(route, readiness);
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/accept`, { head: check.head });
    const accepted = await fixture.json(path);
    // Persist the pre-upgrade input format while the disposable server is stopped.
    // Assertions below use only HTTP, never database reads.
    const historical = { ...accepted.runs[0] };
    delete historical.implementation_completion; delete historical.manifest.issue_admission;
    fixture.setHeadUnavailable();
    fixture.restart(() => {
      const db = new Database(join(fixture.root, "factory", "records.sqlite"));
      try {
        db.query("UPDATE records SET data=? WHERE kind='runs' AND id=?").run(JSON.stringify(historical), run.id);
        db.query("UPDATE records SET data=? WHERE kind='implementations' AND id=?").run(JSON.stringify({ ...accepted.implementation, stage: "done" }), run.implementation_id);
      } finally { db.close(); }
    });
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0, available_slots: 1 });
    await fixture.json("/settings", { max_implementations: 1 });
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(202);
    expect((await fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: "implementation_complete" });
    expect((await fixture.json(path)).runs[0]).toMatchObject({ condition: "completed" });
  } finally { fixture.close(); }
}, 20_000);
