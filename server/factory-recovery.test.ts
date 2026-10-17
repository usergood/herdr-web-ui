import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { reviewReworkFixture } from "./factory-review-rework.fixture.ts";
import { readyIssuesFixture } from "./ready-issues.fixture.ts";

test("accepted integration supersedes earlier worker content, while missing delivery and owner questions still block Done", async () => {
  const f = await reviewReworkFixture();
  try {
    const batch = (await f.request(f.prefix + "/request-changes", f.submission)).body;
    const worker = (await f.request(f.workerRoute, { role: "implementer", ticket_id: f.ticket.id, review_batch_id: batch.id, idempotency_key: "repair" })).body;
    f.commit(worker.worktree, "Final accepted version\n"); f.restWorker(worker.id);
    await f.request(`${f.workerRoute}/${worker.id}/reconcile`, {});
    await f.request(`${f.workerRoute}/${worker.id}/check`, {});
    expect((await f.request(`${f.workerRoute}/${worker.id}/integrate`, {})).body.condition).toBe("completed");
    const check = (await f.request(`/runs/${f.run.id}/checks`, {})).body;
    f.setReviewOutcome("passed");
    for (const role of ["standards", "spec"]) {
      const reviewer = (await f.request(f.workerRoute, { role, idempotency_key: "fresh-" + role })).body;
      expect(await f.request(`${f.workerRoute}/${reviewer.id}/review-evidence`, {})).toMatchObject({ status: 200, body: { head: check.head, outcome: "passed", axis: role } });
    }
    const rested = await f.restRun();
    expect(["ready", "completed"]).toContain(rested.condition);
    const held = f.holdHeadResponse();
    const earlier = f.request(`/runs/${f.run.id}/reconcile`, {});
    await held.received;
    const accepted = await f.request(`/runs/${f.run.id}/accept`, { head: check.head });
    expect(accepted).toMatchObject({ status: 200, body: { condition: "completed" } });
    const oid = execFileSync("git", ["-C", f.run.worktree!, "rev-parse", "HEAD:ready.txt"], { encoding: "utf8" }).trim();
    const head = check.head;
    const resources = {
      "repos/fictional/schedules/pulls/12": { number: 12, merged: true, state: "closed", merge_commit_sha: head, base: { ref: "main", repo: { full_name: "fictional/schedules" } }, head: { sha: head } },
      "repos/fictional/schedules/pulls/12/files?per_page=100&page=1": [{ filename: "ready.txt", status: "added", sha: oid }],
      "repos/fictional/schedules/branches/main": { name: "main", commit: { sha: head } },
      [`repos/fictional/schedules/compare/${head}...${head}`]: { status: "identical", merge_base_commit: { sha: head } },
      [`repos/fictional/schedules/git/trees/${head}?recursive=1`]: { truncated: false, tree: [{ path: "ready.txt", mode: "100644", type: "blob", sha: oid }] },
    };
    f.respond({ resources });
    const linkResponse = await f.request(f.prefix + "/delivery", { expected_revision: null, machine_id: "owned-host", account_profile_id: f.hostAccountId, pull_numbers: [12] });
    expect(linkResponse).toMatchObject({ status: 200, body: { condition: "linked" } });
    expect(typeof linkResponse.body.revision).toBe("string");
    const linked = linkResponse.body;
    const question = (await f.request(f.prefix + "/questions", { question: "Confirm the remaining owner decision?" })).body;
    held.release(); await earlier;
    const retained = (await f.request(f.prefix)).body.runs.find((run: { id: string }) => run.id === f.run.id);
    expect(retained.accepted_result).toEqual(accepted.body.accepted_result);
    const sync = () => f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    f.respond({ resources: { ...resources, "repos/fictional/schedules/pulls/12/files?per_page=100&page=1": [] } });
    expect(await sync()).toMatchObject({ status: 200, body: { condition: "needs_you", problem: expect.stringContaining("does not cover the intended changes") } });
    f.respond({ resources });
    const delivered = (await sync()).body;
    expect(delivered.condition).toBe("merged");
    expect(delivered.changes).toEqual([{ path: "ready.txt", oid, mode: "100644" }]);
    expect((await f.request(f.prefix)).body.board).toMatchObject({ lane: "needs_you" });
    expect((await f.request(f.prefix)).body.board.sidebar_hidden).not.toBe(true);
    expect(await f.request(`${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Confirmed" })).toMatchObject({ status: 200, body: { id: question.id, revision: question.revision, answer: "Confirmed" } });
    expect((await sync()).body.condition).toBe("merged");
    expect((await f.request(f.prefix)).body.board).toMatchObject({ lane: "done", sidebar_hidden: true });
  } finally { f.close(); }
}, 30_000);

test("the board distinguishes selected waiting work, conflicting readiness and unselected Inbox", async () => {
  const f = await readyIssuesFixture();
  try {
    const policy = (await f.request(f.route + "/configure", f.policy)).body;
    f.respond({ issues: [f.issue(1), f.issue(2, ["ready-for-agent", "needs-info"]), f.issue(3, ["needs-triage"])] });
    const sources = (await f.request(f.route + "/sync", {})).body.sources;
    const first = sources.find((source: { number: number }) => source.number === 1);
    await f.request(f.route + "/issues/1/approve", { issue_revision: first.revision, policy_revision: policy.revision, plan: f.plan });
    await f.request(`/projects/${f.project.id}/queue/configure`, { expected_revision: null, paused: true });
    const overview = (await f.request("")).body;
    for (const [number, lane] of [[1, "queued"], [2, "needs_you"], [3, "inbox"]] as const) {
      const source = sources.find((source: { number: number }) => source.number === number);
      expect(overview.board.find((item: { implementation_id: string }) => item.implementation_id === source.implementation_id).lane).toBe(lane);
      expect((await f.request(`/implementations/${source.implementation_id}`)).body.board.lane).toBe(lane);
    }
    expect((await f.request(`/projects/${f.project.id}/remove`, {})).status).toBe(200);
    expect((await f.request("")).status).toBe(200);
    expect((await f.request(`/implementations/${first.implementation_id}`)).status).toBe(200);
  } finally { f.close(); }
}, 30_000);

test("late retirement observation preserves a newer owner context and the accepted candidate", async () => {
  const f = await reviewReworkFixture();
  try {
    f.setReviewOutcome("passed");
    for (const role of ["standards", "spec"]) {
      const reviewer = (await f.request(f.workerRoute, { role, idempotency_key: "passing-" + role })).body;
      expect(await f.request(`${f.workerRoute}/${reviewer.id}/review-evidence`, {})).toMatchObject({ status: 200, body: { head: f.head, outcome: "passed", axis: role } });
    }
    await f.restRun();
    const accepted = await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    expect(accepted).toMatchObject({ status: 200, body: { condition: "completed" } });
    const question = (await f.request(f.prefix + "/questions", { question: "Confirm the delivery decision?" })).body;
    expect((await f.request(`/runs/${f.run.id}/reconcile`, {})).body.condition).toBe("needs_you");
    expect(await f.request(`${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Confirmed" })).toMatchObject({ status: 200 });
    // A held head response can observe either retirement phase; both must preserve newer owner context.
    const held = f.holdHeadResponse(1);
    const recovering = f.request(`/runs/${f.run.id}/reconcile`, {});
    await held.received;
    const later = (await f.request(f.prefix + "/questions", { run_id: f.run.id, question: "Confirm the later owner context?" })).body;
    const newer = (await f.request(f.prefix)).body.runs.find((run: { id: string }) => run.id === f.run.id);
    expect(newer.continuation).toMatchObject({ kind: "owner" });
    expect(typeof newer.continuation.id).toBe("string");
    const completion = accepted.body.implementation_completion;
    expect(completion).toMatchObject({ head: f.head });
    const preserved = { id: f.run.id, implementation_id: f.run.implementation_id, machine_id: f.run.machine_id, checkout: f.run.checkout, worktree: f.run.worktree, branch: f.run.branch, workspace_id: f.run.workspace_id, pane_id: f.run.pane_id, accepted_result: accepted.body.accepted_result, continuation: { id: newer.continuation.id, kind: "owner" } };
    const expectPreserved = (run: any) => {
      expect(run).toMatchObject(preserved);
      expect(["needs_you", "completed"]).toContain(run.condition);
      if (run.condition === "completed") {
        expect(run.implementation_completion_pending ?? false).toBe(false);
        expect(run.implementation_completion).toEqual(completion);
      }
    };
    expect(await f.request(`${f.prefix}/questions/${later.id}/answer`, { revision: later.revision, answer: "Keep this exact context" })).toMatchObject({ status: 200 });
    held.release();
    const recovered = await recovering;
    if (recovered.status === 409) expect(recovered).toMatchObject({ body: { error: { code: "execution_changed" } } });
    else { expect(recovered.status).toBe(200); expectPreserved(recovered.body); }
    const retained = (await f.request(f.prefix)).body;
    expectPreserved(retained.runs.find((run: { id: string }) => run.id === f.run.id));
    expect(retained.questions.find((entry: { id: string }) => entry.id === later.id)).toMatchObject({ revision: later.revision, answer: "Keep this exact context" });
    const fresh = await f.request(`/runs/${f.run.id}/reconcile`, {});
    expect(fresh).toMatchObject({ status: 200, body: { condition: "completed" } });
    expectPreserved(fresh.body);
  } finally { f.close(); }
}, 30_000);

test("native reconciliation preserves accepted evidence while a later owner question remains pending", async () => {
  const f = await reviewReworkFixture();
  try {
    f.setReviewOutcome("passed");
    for (const role of ["standards", "spec"]) {
      const reviewer = (await f.request(f.workerRoute, { role, idempotency_key: "observed-" + role })).body;
      expect(await f.request(`${f.workerRoute}/${reviewer.id}/review-evidence`, {})).toMatchObject({ status: 200, body: { head: f.head, outcome: "passed", axis: role } });
    }
    await f.restRun();
    const accepted = await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    expect(accepted).toMatchObject({ status: 200, body: { condition: "completed" } });
    const question = await f.request(f.prefix + "/questions", { run_id: f.run.id, question: "Keep the accepted candidate while this later decision is pending?" });
    expect(question.status).toBe(201);
    const before = (await f.request(f.prefix)).body.runs.find((run: { id: string }) => run.id === f.run.id);
    expect(before).toMatchObject({ condition: "needs_you", accepted_result: accepted.body.accepted_result, continuation: { kind: "owner" } });
    const observed = await f.request(`/runs/${f.run.id}/reconcile`, {});
    expect(observed.status).toBe(200);
    const preserved = { id: f.run.id, machine_id: f.run.machine_id, worktree: f.run.worktree, branch: f.run.branch, pane_id: f.run.pane_id, workspace_id: f.run.workspace_id, accepted_result: accepted.body.accepted_result, continuation: { id: before.continuation.id, kind: "owner" } };
    expect(observed.body.accepted_result).toEqual(accepted.body.accepted_result);
    expect(observed.body).toMatchObject(preserved);
    const retained = (await f.request(f.prefix)).body;
    expect(retained.runs.find((run: { id: string }) => run.id === f.run.id)).toMatchObject(preserved);
    expect(retained.questions.find((entry: { id: string }) => entry.id === question.body.id)).toMatchObject({ answer: null, revision: question.body.revision });
    expect(retained.board).toMatchObject({ lane: "needs_you" });
    expect(retained.board.sidebar_hidden).not.toBe(true);
  } finally { f.close(); }
}, 30_000);
