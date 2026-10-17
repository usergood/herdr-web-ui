import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readyIssuesFixture } from "./ready-issues.fixture.ts";
import { reviewReworkFixture } from "./factory-review-rework.fixture.ts";

test("a trusted ready issue automatically implements its accepted plan in an isolated factory Run", async () => {
  const f = await readyIssuesFixture();
  try {
    const policy = (await f.request(f.route + "/configure", f.policy)).body;
    f.respond({ issues: [f.issue(1)] });
    const source = (await f.request(f.route + "/sync", {})).body.sources[0];
    await f.request(f.route + "/issues/1/approve", { issue_revision: source.revision, policy_revision: policy.revision, plan: f.plan });
    await f.tick();
    const detail = (await f.request(`/implementations/${source.implementation_id}`)).body;
    expect(detail.runs).toHaveLength(1);
    const run = detail.runs[0];
    expect(run).toMatchObject({ action: "implement-spec", condition: "working" });
    expect(run.worktree).not.toBe(run.checkout);
    expect(existsSync(run.worktree + "/README.md")).toBe(true);
    expect(run.manifest.issue_scope.approval.plan).toEqual(f.plan);
    expect(run.manifest.tickets).toHaveLength(1);
    expect(detail.questions).toEqual([]);
    expect(detail.approvals.map((approval: any) => approval.source_approval_id)).toEqual([run.manifest.issue_scope.approval.id, run.manifest.issue_scope.approval.id, run.manifest.issue_scope.approval.id]);
    expect(f.launches.map(run => run.action)).toEqual(["implement-spec"]);
    await f.tick(); f.restart(); await f.tick();
    expect((await f.request(`/implementations/${source.implementation_id}`)).body.runs).toHaveLength(1);
  } finally { f.close(); }
}, 30_000);

test("unconfigured Projects admit independent ready Assignments through available agent slots", async () => {
  const f = await readyIssuesFixture();
  try {
    const policy = (await f.request(f.route + "/configure", f.policy)).body;
    f.respond({ issues: [f.issue(1), f.issue(2)] });
    const sources = (await f.request(f.route + "/sync", {})).body.sources;
    for (const source of sources) await f.request(f.route + `/issues/${source.number}/approve`, { issue_revision: source.revision, policy_revision: policy.revision, plan: f.plan });
    await f.tick();
    for (const source of sources) expect((await f.request(`/implementations/${source.implementation_id}`)).body.runs).toMatchObject([{ action: "implement-spec", condition: "working" }]);
    expect(f.launches).toHaveLength(2);
    const queue = (await f.request(`/projects/${f.project.id}/queue`)).body;
    expect(queue.revision).toBeNull();
    expect(queue.capacity.agents).toBe(2);
  } finally { f.close(); }
}, 30_000);

test.each(["merge", "release", "wrong_branch", "old_checkout"])("a prerequisite awaiting release admits only a dependent with merged changes in its target checkout (%s)", async mode => {
  const f = await readyIssuesFixture();
  try {
    await f.request(`/projects/${f.project.id}/configure`, { delivery_policy: "release" });
    const policy = (await f.request(f.route + "/configure", f.policy)).body;
    const issues = [f.issue(1), f.issue(2)]; f.respond({ issues });
    const sources = (await f.request(f.route + "/sync", {})).body.sources;
    const a = sources.find((source: any) => source.number === 1), b = sources.find((source: any) => source.number === 2);
    await f.request(f.route + "/issues/1/approve", { issue_revision: a.revision, policy_revision: policy.revision, plan: f.plan });
    await f.request(f.route + "/issues/2/approve", { issue_revision: b.revision, policy_revision: policy.revision, plan: { ...f.plan, dependencies: [{ repository: "fictional/schedules", issue_number: 1, requires: mode === "release" ? "release" : "merge" }] } });
    const run = (await f.request(`/implementations/${a.implementation_id}/runs`, { action: "work", idempotency_key: "prerequisite" })).body;
    const git = (args: string[], cwd = run.worktree) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    writeFileSync(run.worktree + "/dependency.txt", "Merged prerequisite\n"); git(["add", "dependency.txt"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "prerequisite"]);
    const head = git(["rev-parse", "HEAD"]), oid = git(["rev-parse", "HEAD:dependency.txt"]);
    git(["merge", "--ff-only", head], f.repo); f.rest(run.id);
    const tree = { truncated: false, tree: [{ path: "dependency.txt", mode: "100644", type: "blob", sha: oid }] };
    f.respond({ issues, resources: {
      "repos/fictional/schedules/pulls/12": { number: 12, merged: true, state: "closed", merge_commit_sha: head, base: { ref: "main", repo: { full_name: "fictional/schedules" } }, head: { sha: head } },
      "repos/fictional/schedules/pulls/12/files?per_page=100&page=1": [{ filename: "dependency.txt", status: "added", sha: oid }],
      "repos/fictional/schedules/branches/main": { name: "main", commit: { sha: head } },
      [`repos/fictional/schedules/compare/${head}...${head}`]: { status: "identical", merge_base_commit: { sha: head } },
      [`repos/fictional/schedules/git/trees/${head}?recursive=1`]: tree,
      "repos/fictional/schedules/releases?per_page=100&page=1": [],
    } });
    const linked = (await f.request(`/implementations/${a.implementation_id}/delivery`, { expected_revision: null, machine_id: "owned-host", account_profile_id: f.hostAccountId, pull_numbers: [12] })).body;
    expect(linked.revision).toBeString();
    const delivery = (await f.request(`/implementations/${a.implementation_id}/delivery/sync`, { expected_revision: linked.revision })).body;
    expect(delivery.condition).toBe("merged");
    expect((await f.request(`/implementations/${a.implementation_id}`)).body.implementation.stage).not.toBe("done");
    if (mode === "wrong_branch") await f.request(`/projects/${f.project.id}/configure`, { delivery_branch: "other-target" });
    if (mode === "old_checkout") git(["reset", "--hard", run.base], f.repo);
    await f.tick();
    const detail = (await f.request(`/implementations/${b.implementation_id}`)).body;
    expect(detail.runs).toHaveLength(mode === "merge" ? 1 : 0);
    if (mode === "merge") expect(detail.runs[0]).toMatchObject({ action: "implement-spec", condition: "working", base: head });
  } finally { f.close(); }
}, 30_000);

test.each(["verified", "stale_head", "uncertain_check"])("only current verified implementation retires before manual merge while independent work already runs (%s)", async mode => {
  const f = await readyIssuesFixture();
  try {
    expect((await f.request(`/projects/${f.project.id}/queue/configure`, { expected_revision: null, paused: false })).status).toBe(200);
    const policy = (await f.request(f.route + "/configure", f.policy)).body;
    f.respond({ issues: [f.issue(1), f.issue(2)] });
    const sources = (await f.request(f.route + "/sync", {})).body.sources;
    for (const source of sources) await f.request(f.route + `/issues/${source.number}/approve`, { issue_revision: source.revision, policy_revision: policy.revision, plan: f.plan });
    await f.tick();
    const a = sources.find((source: any) => source.number === 1), b = sources.find((source: any) => source.number === 2);
    const run = (await f.request(`/implementations/${a.implementation_id}`)).body.runs[0];
    const independent = (await f.request(`/implementations/${b.implementation_id}`)).body.runs[0];
    expect(independent).toMatchObject({ action: "implement-spec", condition: "working" });
    f.rest(run.id); await f.tick();
    expect((await f.request(`/implementations/${b.implementation_id}`)).body.runs[0]).toMatchObject({ id: independent.id, condition: "working" });
    const workerRoute = `/runs/${run.id}/workers`;
    const worker = (await f.request(workerRoute, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "bounded-implementation" })).body;
    writeFileSync(worker.worktree + "/ready.txt", "Reviewed fixture change\n");
    for (const args of [["add", "ready.txt"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "ready change"]]) execFileSync("git", ["-C", worker.worktree, ...args], { stdio: "ignore" });
    f.restWorker(worker.id);
    await f.request(`${workerRoute}/${worker.id}/reconcile`, {});
    expect((await f.request(`${workerRoute}/${worker.id}/check`, {})).body.condition).toBe("passed");
    let integration = await f.request(`${workerRoute}/${worker.id}/integrate`, {});
    const integrationDeadline = Date.now() + 5000;
    // A parent resuming after its child wait briefly holds an accepted lease.
    // This exact guard rejects before integration dispatch, so observation can settle it.
    while (integration.status === 409 && integration.body.error?.code === "factory_run_required" && Date.now() < integrationDeadline) {
      const parent = (await f.request(`/implementations/${a.implementation_id}`)).body.runs.find((entry: any) => entry.id === run.id);
      expect(parent).toMatchObject({ action: "implement-spec", checkout: run.checkout, continuation: { kind: "children" } });
      await f.tick(); await Bun.sleep(10);
      integration = await f.request(`${workerRoute}/${worker.id}/integrate`, {});
    }
    expect(integration).toMatchObject({ status: 200, body: { condition: "completed" } });
    let resumed = (await f.request(`/runs/${run.id}/reconcile`, {})).body;
    const resumedDeadline = Date.now() + 5000;
    while (resumed.condition !== "working" && Date.now() < resumedDeadline) {
      await f.tick(); await Bun.sleep(10);
      resumed = (await f.request(`/runs/${run.id}/reconcile`, {})).body;
    }
    expect(resumed).toMatchObject({ id: run.id, condition: "working" });
    // In the positive case, unfinished checks keep retirement gated until the summary turn rests.
    if (mode !== "verified") expect(await f.request(`/runs/${run.id}/checks`, {})).toMatchObject({ status: 200, body: { condition: "passed" } });
    const standards = (await f.request(workerRoute, { role: "standards", idempotency_key: "independent-standards" })).body;
    await f.request(`${workerRoute}/${standards.id}/review-evidence`, {});
    await f.tick();
    expect((await f.request(`/implementations/${b.implementation_id}`)).body.runs[0]).toMatchObject({ id: independent.id, condition: "working" });
    const spec = (await f.request(workerRoute, { role: "spec", idempotency_key: "independent-spec" })).body;
    if (mode === "verified") {
      f.rest(run.id);
      const parked = await f.request(`/runs/${run.id}/reconcile`, {});
      expect(parked).toMatchObject({ status: 200, body: { continuation: { kind: "children", condition: "parked" } } });
      expect(parked.body.continuation.worker_keys).toContain("independent-spec");
    }
    if (mode === "stale_head") {
      writeFileSync(run.worktree + "/later.txt", "An unreviewed later change\n");
      for (const args of [["add", "later.txt"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "later change"]]) execFileSync("git", ["-C", run.worktree, ...args], { stdio: "ignore" });
    }
    if (mode === "uncertain_check") {
      f.offline(true); await f.request(`/runs/${run.id}/checks`, {}); f.offline(false);
      f.restart();
    }
    const finalReview = await f.request(`${workerRoute}/${spec.id}/review-evidence`, {});
    expect(finalReview.status).toBe(mode === "stale_head" ? 409 : 200);
    if (mode === "stale_head") expect(finalReview.body.error.code).toBe("review_stale");
    // Native Send executes the resumed parent until this explicit end of its turn.
    // Negative evidence is already arranged before native rest can permit retirement.
    f.rest(run.id);
    await f.tick();
    let complete = (await f.request(`/implementations/${a.implementation_id}`)).body;
    if (mode === "verified") {
      const deadline = Date.now() + 5000;
      let checked = false;
      while (complete.runs[0].condition !== "completed" && Date.now() < deadline) {
        const current = complete.runs.find((entry: { id: string }) => entry.id === run.id);
        if (!checked && current.condition === "working" && current.continuation?.kind === "children" && current.continuation.condition === "resumed") {
          expect(current).toMatchObject({ id: run.id, machine_id: run.machine_id, worktree: run.worktree, branch: run.branch, workspace_id: run.workspace_id, pane_id: run.pane_id });
          // The summary ACK started a native turn after the first rest observation.
          f.rest(run.id);
          expect(await f.request(`/runs/${run.id}/reconcile`, {})).toMatchObject({ status: 200, body: { id: run.id, condition: "ready", worktree: run.worktree, workspace_id: run.workspace_id, pane_id: run.pane_id } });
          expect(await f.request(`/runs/${run.id}/checks`, {})).toMatchObject({ status: 200, body: { condition: "passed" } });
          checked = true;
        }
        await f.tick();
        complete = (await f.request(`/implementations/${a.implementation_id}`)).body;
        if (complete.runs[0].condition !== "completed") await Bun.sleep(10);
      }
      expect(checked).toBe(true);
    }
    if (mode !== "verified") {
      expect(complete.runs[0].condition).not.toBe("completed");
      expect((await f.request(`/implementations/${b.implementation_id}`)).body.runs[0]).toMatchObject({ id: independent.id, condition: "working" });
      const queue = (await f.request(`/projects/${f.project.id}/queue`)).body;
      expect(queue.capacity.project_implementations).toBe(2);
      if (mode === "uncertain_check") expect(queue.capacity.builds).toBe(1);
      return;
    }
    expect(complete.runs[0].condition).toBe("completed");
    expect(complete.implementation).toMatchObject({ stage: "review", outcome: "implementation_complete" });
    expect(complete.board).toMatchObject({ lane: "needs_you", activity: "awaiting_merge" });
    let next = (await f.request(`/implementations/${b.implementation_id}`)).body;
    const deadline = Date.now() + 5000;
    while (!next.runs.length && Date.now() < deadline) {
      await f.tick(); next = (await f.request(`/implementations/${b.implementation_id}`)).body;
      if (!next.runs.length) await Bun.sleep(10);
    }
    expect(next.runs[0]).toMatchObject({ id: independent.id, action: "implement-spec", condition: "working" });
    expect((await f.request(`/projects/${f.project.id}/queue`)).body.capacity.project_implementations).toBe(1);
    expect(f.calls().some(args => args.includes("--method"))).toBe(false);
  } finally { f.close(); }
}, 30_000);

test("automatic failure retains its attempt across restart until the owner explicitly retries", async () => {
  const f = await readyIssuesFixture();
  try {
    const policy = (await f.request(f.route + "/configure", f.policy)).body;
    f.respond({ issues: [f.issue(1)] });
    const source = (await f.request(f.route + "/sync", {})).body.sources[0];
    await f.request(f.route + "/issues/1/approve", { issue_revision: source.revision, policy_revision: policy.revision, plan: f.plan });
    f.failLaunch(true); await f.tick();
    const failed = (await f.request(`/implementations/${source.implementation_id}`)).body.runs[0];
    expect(failed.condition).toBe("failed");
    f.failLaunch(false); f.restart(); await f.tick(); await f.tick();
    expect(f.launches).toHaveLength(1);
    expect((await f.request(`/projects/${f.project.id}/queue`)).body.items[0].reasons).toContain("retry_required");
    expect((await f.request(`/implementations/${source.implementation_id}/retry`, { run_id: failed.id })).status).toBe(200);
    await f.tick();
    const detail = (await f.request(`/implementations/${source.implementation_id}`)).body;
    expect(detail.runs.map((run: any) => run.condition)).toEqual(["failed", "working"]);
    expect(detail.specifications).toHaveLength(1);
  } finally { f.close(); }
}, 30_000);

test("automatic launch preserves opt-in, scope, pause, owner-question and uncertain-Machine holds", async () => {
  const f = await readyIssuesFixture();
  try {
    let policy = (await f.request(f.route + "/configure", { ...f.policy, auto_implement: false })).body;
    const issue = f.issue(1); f.respond({ issues: [issue, f.issue(2, ["ready-for-human"]), f.issue(3, ["wontfix"]), f.issue(4, ["ready-for-agent", "needs-info"])] });
    let source = (await f.request(f.route + "/sync", {})).body.sources.find((source: any) => source.number === 1);
    await f.request(f.route + "/issues/1/approve", { issue_revision: source.revision, policy_revision: policy.revision, plan: f.plan });
    await f.tick(); expect(f.launches).toHaveLength(0);
    policy = (await f.request(f.route + "/configure", { ...f.policy, expected_revision: policy.revision })).body;
    await f.tick(); expect(f.launches).toHaveLength(0); // The changed trust policy needs its own receipt.
    await f.request(f.route + "/issues/1/approve", { issue_revision: source.revision, policy_revision: policy.revision, plan: f.plan });
    const queueRoute = `/projects/${f.project.id}/queue`;
    let queue = (await f.request(queueRoute + "/configure", { expected_revision: null, paused: true })).body;
    await f.tick(); expect(f.launches).toHaveLength(0);
    queue = (await f.request(queueRoute + "/configure", { expected_revision: queue.revision, paused: false })).body;
    issue.body = "An unapproved scope edit"; f.respond({ issues: [issue] });
    await f.tick(); expect(f.launches).toHaveLength(0);
    source = (await f.request(f.route)).body.sources.find((source: any) => source.number === 1);
    const invalid = await f.request(f.route + "/issues/1/approve", { issue_revision: source.revision, policy_revision: policy.revision, plan: { ...f.plan, testing_seams: [] } });
    expect(invalid.status).toBe(400);
    await f.request(f.route + "/issues/1/approve", { issue_revision: source.revision, policy_revision: policy.revision, plan: f.plan });
    const question = (await f.request(`/implementations/${source.implementation_id}/questions`, { question: "A new design decision needs the owner" })).body;
    await f.tick(); expect(f.launches).toHaveLength(0);
    await f.request(`/implementations/${source.implementation_id}/questions/${question.id}/answer`, { revision: question.revision, answer: "Keep the accepted behavior" });
    f.offline(true); await f.tick(); expect(f.launches).toHaveLength(0);
    f.offline(false); await f.tick(); expect(f.launches).toHaveLength(1);
    issue.labels = []; f.respond({ issues: [issue] });
    await f.request(f.route + "/sync", {});
    const detail = (await f.request(`/implementations/${source.implementation_id}`)).body;
    expect(detail.runs[0].scope_pause.condition).toBe("paused");
    expect(detail.runs[0].manifest.issue_scope.issue.labels).toEqual(["ready-for-agent"]);
    expect(existsSync(detail.runs[0].worktree)).toBe(true);
    await f.tick(); expect(f.launches).toHaveLength(1);
  } finally { f.close(); }
}, 30_000);

test("an unavailable execution contract is visible in the queue and clearing it admits the approved issue", async () => {
  const f = await readyIssuesFixture();
  try {
    await f.request(`/projects/${f.project.id}/configure`, { checks: [] });
    const policy = (await f.request(f.route + "/configure", f.policy)).body;
    f.respond({ issues: [f.issue(1)] });
    const source = (await f.request(f.route + "/sync", {})).body.sources[0];
    await f.request(f.route + "/issues/1/approve", { issue_revision: source.revision, policy_revision: policy.revision, plan: f.plan });
    await f.tick();
    const queue = (await f.request(`/projects/${f.project.id}/queue`)).body;
    expect(queue.items[0].eligible).toBe(false);
    expect(queue.items[0].problem).toContain("Configure known Project checks");
    expect(f.launches).toHaveLength(0);
    expect((await f.request(`/implementations/${source.implementation_id}`)).body.board).toMatchObject({ lane: "needs_you", waiting_reason: expect.stringContaining("Configure known Project checks") });
    await f.request(`/projects/${f.project.id}/configure`, { checks: [["git", "status", "--porcelain"]] });
    await f.tick();
    expect(f.launches).toHaveLength(1);
  } finally { f.close(); }
}, 30_000);

test("an owner-stopped automatic attempt is not relaunched by the same readiness receipt", async () => {
  const f = await readyIssuesFixture();
  try {
    const policy = (await f.request(f.route + "/configure", f.policy)).body;
    f.respond({ issues: [f.issue(1)] });
    const source = (await f.request(f.route + "/sync", {})).body.sources[0];
    await f.request(f.route + "/issues/1/approve", { issue_revision: source.revision, policy_revision: policy.revision, plan: f.plan });
    await f.tick();
    const run = (await f.request(`/implementations/${source.implementation_id}`)).body.runs[0];
    await f.request(`/runs/${run.id}/stop`, { summary: "Owner stops automatic work" });
    f.restart(); await f.tick();
    expect(f.launches).toHaveLength(1);
    expect((await f.request(`/implementations/${source.implementation_id}`)).body.runs[0].condition).toBe("cancelled");
  } finally { f.close(); }
}, 30_000);

test.each([false, true])("an accepted native review notification executes once even when its acknowledgment is lost (%s)", async lost => {
  const f = await reviewReworkFixture();
  try {
    await f.restRun(); const priorDeliveries = f.deliveries.length; f.uncertainDelivery(lost);
    const sent = await f.request(f.prefix + "/request-changes", f.submission);
    expect(sent).toMatchObject({ status: 200, body: { status: lost ? "uncertain" : "sent" } });
    expect((await f.request(`/runs/${f.run.id}/reconcile`, {})).body.condition).toBe("working");
    expect((await f.request(f.prefix + "/request-changes", f.submission)).body.id).toBe(sent.body.id);
    expect(f.deliveries).toHaveLength(priorDeliveries + 1);
    expect(f.deliveries.at(-1)).toContain(`Request changes batch ${sent.body.id}`);
    expect((await f.request(`/runs/${f.run.id}/stop`, {})).body.condition).toBe("cancelled");
    f.rest(f.run.id);
    expect((await f.request(`/runs/${f.run.id}/reconcile`, {})).body.condition).toBe("cancelled");
    expect(f.deliveries).toHaveLength(priorDeliveries + 1);
  } finally { f.close(); }
}, 30_000);
