import { expect, test } from "bun:test";
import { githubReviewFixture } from "../scripts/fixtures/github-review.ts";

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
