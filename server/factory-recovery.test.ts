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
      await f.request(`${f.workerRoute}/${reviewer.id}/review-evidence`, {});
    }
    f.rest(f.run.id);
    await f.request(`/runs/${f.run.id}/reconcile`, {});
    expect((await f.request(`/runs/${f.run.id}/accept`, { head: check.head })).status).toBe(200);
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
    const linked = (await f.request(f.prefix + "/delivery", { expected_revision: null, machine_id: "owned-host", account_profile_id: f.hostAccountId, pull_numbers: [12] })).body;
    const sync = () => f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    f.respond({ resources: { ...resources, "repos/fictional/schedules/pulls/12/files?per_page=100&page=1": [] } });
    expect((await sync()).body.condition).toBe("needs_you");
    f.respond({ resources });
    const question = (await f.request(f.prefix + "/questions", { question: "Confirm the remaining owner decision?" })).body;
    const delivered = (await sync()).body;
    expect(delivered.condition).toBe("merged");
    expect(delivered.changes).toEqual([{ path: "ready.txt", oid, mode: "100644" }]);
    expect((await f.request(f.prefix)).body.board).toMatchObject({ lane: "needs_you" });
    expect((await f.request(f.prefix)).body.board.sidebar_hidden).not.toBe(true);
    await f.request(`${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Confirmed" });
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
    await f.request(`/projects/${f.project.id}/queue/configure`, { expected_revision: null, max_implementations: 1, paused: true });
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
