import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { githubReviewFixture } from "../scripts/fixtures/github-review.ts";
import { summarizeIssueAdmission, type IssueAdmission } from "../shared/issue-admission.ts";
import { githubDeliveryResponses } from "../scripts/fixtures/github-delivery.ts";
import type { ProjectPullRequest } from "../shared/github-project.ts";

test("review browser origin reaches retained Assignment state after restart", async () => {
  const fixture = githubReviewFixture();
  let retired: ReturnType<typeof Bun.serve> | undefined;
  try {
    const assignment = await fixture.json("/implementations", { title: "Retained review Assignment", description: "Fictional restart state" });
    const port = Number(new URL(fixture.origin).port);
    fixture.restart(() => { retired = Bun.serve({ port, fetch: () => new Response("Retired fixture address", { status: 410 }) }); });
    const response = await fetch(fixture.origin + `/api/factory/implementations/${assignment.id}`, { headers: fixture.headers, signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    expect((await response.json()).implementation).toMatchObject({ id: assignment.id, title: "Retained review Assignment" });
  } finally { retired?.stop(true); fixture.close(); }
});

async function prepareManual(fixture: ReturnType<typeof githubReviewFixture>) {
  const { project, route } = await fixture.setup();
  const assignment = await fixture.json("/implementations", { title: "Owned manual Assignment", description: "Show a greeting", project_id: project.id });
  const path = `/implementations/${assignment.id}`;
  const specification = await fixture.json(path + "/specifications", { content: "Show hello through the public HTTP interface." });
  for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Owned fixture approval for public HTTP" });
  const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "greeting", title: "Greeting", acceptance: "Show hello", dependencies: [] }] });
  await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Owned fixture graph approval" });
  const run = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "owned-manual-implementation" });
  return { path, run, route };
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

test("replacement delivery coverage returns completed ordinary issue Work to Awaiting merge without changing its Run", async () => {
  const fixture = githubReviewFixture();
  try {
    const { route } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    fixture.setNativeIdentity();
    const run = await fixture.json(path + "/runs", { action: "work", idempotency_key: "owned-replaced-delivery" });
    await fixture.json(path + "/complete-work", { run_id: run.id });
    await fixture.json(route + "/issues/1/delivery", { source_revision: source.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: null });
    fixture.setApiResponses(githubDeliveryResponses());
    const delivered = await fixture.json(route + "/sync", {});
    const completed = await fixture.json(path);
    expect(completed.implementation.stage).toBe("done");
    const link = delivered.sources[0].delivery;
    await fixture.json(route + "/issues/1/delivery", { source_revision: source.revision, expected_revision: link.revision, target_branch: "main", intended_prs: [], release_tag: null });
    fixture.restart();
    const replaced = await fixture.json(path);
    expect(replaced.implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" });
    expect(replaced.implementation.delivery_evidence).toBeUndefined();
    expect(replaced.runs).toEqual(completed.runs);
    expect((await fixture.post(path + "/archive", {})).status).toBe(409);
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
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: false });
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

test("restart keeps uncertain retirement recoverable through public controls while retaining ownership", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    fixture.setUncertainStop(true);
    expect((await fixture.post(`/runs/${run.id}/reconcile`, {})).status).toBe(409);
    fixture.restart();
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
    expect((await fixture.json(path)).runs[0].implementation_completion_pending).toBe(true);
    fixture.setUncertainStop(false);
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("completed");
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0 });
  } finally { fixture.close(); }
}, 20_000);

test("uncertain implementation retirement cannot authorize cleanup or certify stopped ownership", async () => {
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
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
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
    await fixture.review(run, "standards");
    if (kind === "worker") await fixture.json(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "unconsumed-native-worker" });
    await fixture.review(run, "spec");
    if (kind === "build") {
      fixture.setCheck("interrupted"); await fixture.json(`/runs/${run.id}/checks`, {});
      fixture.setCheck("passed"); await fixture.json(`/runs/${run.id}/checks`, {});
    }
    fixture.setCoordinator("completed"); await fixture.json(`/runs/${run.id}/reconcile`, {});
    fixture.restart();
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
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
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
    expect((await fixture.json(path)).implementation.activity).toBeUndefined();
  } finally { fixture.close(); }
}, 20_000);

test("stale completion keeps Needs you and ownership across cached native cancellation and restart until exact proof is restored", async () => {
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
      expect(await fixture.json(`/runs/${run.id}/reconcile`, {})).toMatchObject({ condition: "needs_you", waiting_reason: expect.stringContaining("evidence changed") });
      expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
      expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(409);
      expect((await fixture.json(path)).implementation.activity).toBeUndefined();
    }
    fixture.setHead(check.head);
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("completed");
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0 });
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
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
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
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
    fixture.setHead(check.head);
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("completed");
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0 });
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

test.each([
  ["scope", "cancelled"], ["scope", "completed"], ["readiness", "cancelled"], ["readiness", "completed"], ["closure", "cancelled"], ["closure", "completed"],
] as const)("owner Stop recovers %s drift overlapping %s retirement without reopening the retired lease", async (drift, terminal) => {
  const fixture = githubReviewFixture();
  let release: (() => void) | undefined;
  try {
    const { run, path, route, readiness } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    fixture.setStopCondition(terminal);
    const gate = fixture.holdStop(); release = gate.release;
    const retiring = fixture.post(`/runs/${run.id}/reconcile`, {});
    await Promise.race([gate.waiting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Stop was not reached")), 5000))]);
    if (drift === "scope") fixture.issue.body += "\nA changed greeting requirement.";
    if (drift === "readiness") fixture.issue.labels = [];
    if (drift === "closure") fixture.issue.state = "closed";
    fixture.save(); await fixture.json(route + "/sync", {});
    gate.release();
    expect((await retiring).status).toBe(409);
    const beforeOwnerStop = await fixture.post(`/runs/${run.id}/retry`, { idempotency_key: "retirement-is-not-owner-stop", issue_scope: { source_id: (run.manifest as any).issue_admission.source.id, source_revision: (run.manifest as any).issue_admission.source.revision, graph_hash: run.graph_hash } });
    expect((await beforeOwnerStop.json()).error.code).toBe("retry_unavailable");
    const stopped = await fixture.json(`/runs/${run.id}/stop`, {});
    expect(stopped).toMatchObject({ condition: "cancelled", issue_pause: { source_id: (run.manifest as any).issue_admission.source.id } });
    expect(stopped.implementation_completion_pending).toBeUndefined();
    if (drift === "scope" && terminal === "cancelled") {
      // Historical input only: an interrupted pre-upgrade owner Stop retained its
      // recovery marker before clearing the pending flag. Observe it through HTTP.
      fixture.restart(() => {
        const db = new Database(join(fixture.root, "factory", "records.sqlite"));
        try { db.query("UPDATE records SET data=? WHERE kind='runs' AND id=?").run(JSON.stringify({ ...stopped, implementation_completion_pending: true }), run.id); }
        finally { db.close(); }
      });
      expect((await fixture.json(`/runs/${run.id}/stop`, {})).implementation_completion_pending).toBeUndefined();
    }
    fixture.restart();
    expect(await fixture.json(`/runs/${run.id}/reconcile`, {})).toMatchObject({ condition: "cancelled", issue_pause: stopped.issue_pause });
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0 });
    const detail = await fixture.json(path);
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.review_evidence).toHaveLength(2);
    expect(detail.approvals).toEqual([]);
    for (const question of detail.questions.filter((question: any) => question.answer === null)) await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Use the newly reviewed issue scope." });
    fixture.issue.state = "open"; fixture.issue.labels = [{ name: "ready-for-agent" }]; fixture.save();
    await fixture.json(route + "/sync", {});
    const source = (await fixture.json(route)).sources[0];
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision, question_revision: (await fixture.json(path)).question_revision });
    await fixture.json(route + "/sync", {});
    const current = (await fixture.json(path));
    const request = { idempotency_key: "renewed-paused-retirement", issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: current.graph_hash } };
    const successor = await fixture.json(`/runs/${run.id}/retry`, request);
    expect(successor).toMatchObject({ condition: "working", retry_of: run.id, manifest: { rework: { run_id: run.id, head: "a".repeat(40) } } });
    expect((await fixture.json(`/runs/${run.id}/retry`, request)).id).toBe(successor.id);
    expect((await fixture.json(path)).runs).toHaveLength(2);
  } finally { release?.(); fixture.close(); }
}, 20_000);

test.each(["unknown", "working", "failed"] as const)("%s Stop during paused retirement retains pending ownership until confirmed termination", async outcome => {
  const fixture = githubReviewFixture(); let release: (() => void) | undefined;
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    const gate = fixture.holdStop(); release = gate.release;
    const retiring = fixture.post(`/runs/${run.id}/reconcile`, {});
    await Promise.race([gate.waiting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Stop was not reached")), 5000))]);
    fixture.issue.body += "\nA new requirement."; fixture.save(); await fixture.json(route + "/sync", {});
    if (outcome === "unknown") fixture.setUncertainStop(true); else fixture.setStopCondition(outcome);
    gate.release(); expect((await retiring).status).toBe(409);
    await fixture.post(`/runs/${run.id}/stop`, {});
    fixture.restart(); await fixture.json(`/runs/${run.id}/reconcile`, {});
    expect((await fixture.json(path)).runs[0]).toMatchObject({ implementation_completion_pending: true, issue_pause: { reason: "scope_changed" }, manifest: run.manifest });
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
    expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(409);
    expect((await fixture.post(`/runs/${run.id}/retry`, { idempotency_key: "uncertain-pause-retry", issue_scope: (run.manifest as any).issue_admission })).status).toBe(409);
    fixture.setUncertainStop(false); fixture.setStopCondition("cancelled");
    expect((await fixture.json(`/runs/${run.id}/stop`, {})).implementation_completion_pending).toBeUndefined();
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0 });
  } finally { release?.(); fixture.close(); }
}, 20_000);

test.each(["worker", "build"] as const)("paused historical retirement cannot clear pending ownership while its %s remains owned", async child => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards");
    if (child === "worker") await fixture.json(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "retained-review-child" });
    await fixture.review(run, "spec");
    if (child === "build") { fixture.setCheck("interrupted"); await fixture.json(`/runs/${run.id}/checks`, {}); }
    fixture.issue.body += "\nA changed requirement."; fixture.save(); await fixture.json(route + "/sync", {});
    const paused = (await fixture.json(path)).runs[0];
    // Historical input only: restore an interrupted retirement with a retained child.
    fixture.restart(() => {
      const db = new Database(join(fixture.root, "factory", "records.sqlite"));
      try { db.query("UPDATE records SET data=? WHERE kind='runs' AND id=?").run(JSON.stringify({ ...paused, implementation_completion_pending: true }), run.id); }
      finally { db.close(); }
    });
    const stopped = await fixture.json(`/runs/${run.id}/stop`, {});
    expect(stopped).toMatchObject({ condition: "cancelled", implementation_completion_pending: true, issue_pause: paused.issue_pause });
    fixture.restart();
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).implementation_completion_pending).toBe(true);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
    expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(409);
  } finally { fixture.close(); }
}, 20_000);

test("an uncertain stop response retains capacity despite finished checks and reviews", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    fixture.setStopCondition("working");
    expect((await fixture.post(`/runs/${run.id}/reconcile`, {})).status).toBe(409);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
    expect((await fixture.json(path)).implementation.activity).toBeUndefined();
  } finally { fixture.close(); }
}, 20_000);

test("owner acceptance cannot release a still-working implementation coordinator", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path } = await fixture.prepare();
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    fixture.setCoordinator("working");
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("working");
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    const accepted = await fixture.post(`/runs/${run.id}/accept`, { head: check.head });
    expect(accepted.status).toBe(409);
    expect((await fixture.json(path)).approvals).toEqual([]);
    fixture.setCoordinator("ready");
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("completed");
    expect((await fixture.post(`/runs/${run.id}/accept`, { head: check.head })).status).toBe(200);
  } finally { fixture.close(); }
}, 20_000);

test("a changed checked workspace invalidates its own completion without blocking unrelated Agent admission", async () => {
  const fixture = githubReviewFixture();
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Unrelated scope" }]);
    const { run, path, route, readiness } = await fixture.prepare();
    const second = await fixture.second(route, readiness);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
    await fixture.integrate(run); const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    fixture.setWorkspaceHash("changed-after-review");
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(202);
    expect((await fixture.json(second.path)).runs).toMatchObject([{ condition: "working" }]);
    const acceptance = await fixture.post(`/runs/${run.id}/accept`, { head: check.head });
    expect(acceptance.status).toBe(409);
    expect((await fixture.json(path)).approvals).toEqual([]);
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
      expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0 });
    }
    await fixture.json("/settings", { max_agents: 1 });
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
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
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
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
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
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0 });
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
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
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

test("a completed-looking coordinator without both reviews retains ownership while independent work can start", async () => {
  const fixture = githubReviewFixture();
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Unrelated scope" }]);
    const { run, path, route, readiness } = await fixture.prepare();
    const second = await fixture.second(route, readiness);
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {}); await fixture.review(run, "standards");
    fixture.setCoordinator("completed");
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    const incomplete = await fixture.json(path);
    expect(incomplete.runs[0].implementation_completion).toBeUndefined();
    expect(incomplete.approvals).toEqual([]);
    expect(incomplete.review_evidence.map((report: any) => report.axis)).toEqual(["standards"]);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(202);
    expect((await fixture.json(second.path)).runs).toMatchObject([{ condition: "working" }]);
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 2 });
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
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0, entries: expect.arrayContaining([expect.objectContaining({ implementation_id: run.implementation_id, lane: "review", activity: "awaiting_merge" })]) });
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
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 0 });
    await fixture.json("/settings", { max_agents: 1 });
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(202);
    expect((await fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: "implementation_complete" });
    expect((await fixture.json(path)).runs[0]).toMatchObject({ condition: "completed" });
  } finally { fixture.close(); }
}, 20_000);

test("matching dirty check receipts and committed HEAD reviews cannot retire or accept implementation", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, route } = await fixture.prepare();
    await fixture.integrate(run);
    fixture.setWorkspaceHash("owned-uncommitted-relevant-content");
    const check = await fixture.json(`/runs/${run.id}/checks`, {});
    expect(check.condition).toBe("passed"); // An older Machine may retain this receipt.
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("ready");
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
    const accepted = await fixture.post(`/runs/${run.id}/accept`, { head: check.head });
    expect(accepted.status).toBe(409); expect((await accepted.json()).error.code).toBe("fresh_evidence_required");
  } finally { fixture.close(); }
}, 15_000);


test.each(["issue", "manual", "accepted_issue", "accepted_manual"])("owner Stop and Retry recover retired %s implementation after a finding without reopening its closed native lease", async origin => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await (origin.endsWith("issue") ? fixture.prepare() : prepareManual(fixture));
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    const finished = await fixture.json(`/runs/${run.id}/reconcile`, {});
    expect(finished.condition).toBe("completed");
    if (origin.startsWith("accepted_")) await fixture.json(`/runs/${run.id}/accept`, { head: finished.implementation_completion.head });
    const snapshot = await fixture.json(path + "/snapshots", { run_id: run.id, mode: "branch" });
    const finding = await fixture.json(path + "/comments", { snapshot_id: snapshot.id, path: "README.md", side: "new", line_start: 1, line_end: 1, content: "Correct this produced greeting" });
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("needs_you");
    fixture.restart();
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("needs_you");
    expect(await fixture.json(route + "/queue")).toMatchObject({ implementing_count: 1 });
    expect((await fixture.post(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "cannot-reopen-retired" })).status).toBe(409);
    const stopped = await fixture.json(`/runs/${run.id}/stop`, {});
    expect(stopped.condition).toBe("cancelled");
    const stoppedDetail = await fixture.json(path);
    expect(stoppedDetail.implementation.outcome).toBe("none");
    expect(stoppedDetail.approvals.filter((approval: any) => approval.kind === "review")).toHaveLength(origin.startsWith("accepted_") ? 1 : 0);
    fixture.restart();
    expect((await fixture.json(`/runs/${run.id}/reconcile`, {})).condition).toBe("cancelled");
    expect((await fixture.json(`/runs/${run.id}/stop`, {})).condition).toBe("cancelled");
    expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(409);
    const source = origin.endsWith("issue") ? (await fixture.json(route)).sources[0] : null;
    const retryBody = { idempotency_key: "explicit-retired-rework", ...(source ? { issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: run.graph_hash } } : {}) };
    expect((await fixture.post(path + "/runs", { ...retryBody, action: "implement-spec" })).status).toBe(409);
    const retried = await fixture.json(`/runs/${run.id}/retry`, retryBody);
    expect(retried).toMatchObject({ condition: "working", retry_of: run.id, manifest: { rework: { run_id: run.id, head: finished.implementation_completion.head, workspace_hash: finished.implementation_completion.workspace_hash } } });
    expect((await fixture.json(`/runs/${run.id}/retry`, retryBody)).id).toBe(retried.id);
    fixture.setHead("b".repeat(40));
    await fixture.integrate(retried); const check = await fixture.json(`/runs/${retried.id}/checks`, {});
    await fixture.review(retried, "standards"); await fixture.review(retried, "spec");
    expect((await fixture.json(`/runs/${retried.id}/reconcile`, {})).condition).toBe("ready");
    expect((await fixture.post(`/runs/${retried.id}/accept`, { head: check.head })).status).toBe(409);
    const resolved = await fixture.json(path + `/comments/${finding.id}/resolve`, { head: check.head, summary: "Owner confirmed the repaired greeting after fresh checks and reviews" });
    expect(resolved).toMatchObject({ run_id: run.id, status: "resolved", resolution: { head: check.head } });
    expect((await fixture.json(`/runs/${retried.id}/reconcile`, {})).condition).toBe("completed");
    expect((await fixture.post(`/runs/${retried.id}/cleanup`, {})).status).toBe(409);
    await fixture.json(`/runs/${retried.id}/accept`, { head: check.head });
    const detail = await fixture.json(path);
    expect(detail.runs).toMatchObject([{ id: run.id, condition: "cancelled" }, { id: retried.id, condition: "completed" }]);
    expect(detail.comments[0].snapshot_id).toBe(snapshot.id);
    fixture.setHead("c".repeat(40));
    expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(409);
    fixture.setHead(check.head); await fixture.json(`/runs/${retried.id}/reconcile`, {});
    expect((await fixture.post(`/runs/${run.id}/cleanup`, {})).status).toBe(200);
  } finally { fixture.close(); }
}, 20_000);

test("ordinary Work acceptance also refuses dirty check receipts combined with committed HEAD reviews", async () => {
  const fixture = githubReviewFixture();
  try {
    const { project } = await fixture.setup();
    const assignment = await fixture.json("/implementations", { title: "Owned dirty Work", description: "Fictional checked work", project_id: project.id });
    const path = `/implementations/${assignment.id}`;
    const run = await fixture.json(path + "/runs", { action: "work", idempotency_key: "owned-dirty-work" });
    fixture.setWorkspaceHash("owned-uncommitted-work-inputs");
    const check = await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    const response = await fixture.post(`/runs/${run.id}/accept`, { head: check.head });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("fresh_evidence_required");
    expect((await fixture.json(path)).approvals).toEqual([]);
  } finally { fixture.close(); }
}, 15_000);


test.each(["issue", "manual"])("failed %s rework keeps the produced commit for the next explicit Retry", async origin => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await (origin === "issue" ? fixture.prepare() : prepareManual(fixture));
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    fixture.setHead("b".repeat(40)); await fixture.json(`/runs/${run.id}/reconcile`, {});
    await fixture.json(`/runs/${run.id}/stop`, {});
    const source = origin === "issue" ? (await fixture.json(route)).sources[0] : null;
    const scope = source ? { issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: run.graph_hash } } : {};
    fixture.setLaunchFailure(true);
    const failed = await fixture.json(`/runs/${run.id}/retry`, { ...scope, idempotency_key: "failed-retired-rework" });
    expect(failed.condition).toBe("failed"); expect(failed.worktree).toBeNull();
    fixture.restart(); fixture.setLaunchFailure(false);
    expect((await fixture.json(path)).runs).toHaveLength(2);
    const ordinary = await fixture.post(path + "/runs", { ...scope, action: "implement-spec", idempotency_key: "no-implicit-failed-rework" });
    expect(ordinary.status).toBe(409); expect((await ordinary.json()).error.code).toBe("retry_required");
    const next = await fixture.json(`/runs/${failed.id}/retry`, { ...scope, idempotency_key: "retry-failed-retired-rework" });
    expect(next).toMatchObject({ condition: "working", retry_of: failed.id, manifest: { rework: { run_id: run.id, head: "b".repeat(40) } } });
    expect((await fixture.json(`/runs/${failed.id}/retry`, { ...scope, idempotency_key: "retry-failed-retired-rework" })).id).toBe(next.id);
  } finally { fixture.close(); }
}, 20_000);

test("compact current decisions retain admitted identity and controlled pause without frozen planning history", async () => {
  const fixture = githubReviewFixture();
  try {
    const { run, path, route } = await fixture.prepare();
    fixture.issue.body += "\nChanged owned scope."; fixture.save(); await fixture.json(route + "/sync", {});
    const full = await fixture.json(path), current = await fixture.json(path + "?view=current");
    expect(current.runs[0].issue_pause).toEqual(full.runs[0].issue_pause);
    expect(current.runs[0].manifest.issue_admission).toEqual(summarizeIssueAdmission((run.manifest as { issue_admission: IssueAdmission }).issue_admission));
    expect(current.runs[0].manifest.issue_admission.planning.content).toBeUndefined();
    expect(current.runs[0].manifest.issue_admission.source.history).toBeUndefined();
    expect(full.runs[0].manifest).toEqual(run.manifest);
  } finally { fixture.close(); }
}, 20_000);

test("an explicit Project delivery declaration still binds manual work in an intake Project", async () => {
  const fixture = githubReviewFixture();
  try {
    const { project } = await fixture.setup();
    await fixture.json(`/projects/${project.id}/configure`, { delivery_policy: "merge" });
    const idea = await fixture.json("/implementations", { title: "Explicit delivery", description: "Owned explicit delivery contract", project_id: project.id });
    fixture.setNativeIdentity();
    const run = await fixture.json(`/implementations/${idea.id}/runs`, { action: "work", idempotency_key: "explicit-delivery" });
    const response = await fixture.post(`/implementations/${idea.id}/complete-work`, { run_id: run.id });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("repository_delivery_required");
    expect((await fixture.json(`/implementations/${idea.id}`)).implementation.stage).not.toBe("done");
  } finally { fixture.close(); }
}, 20_000);
