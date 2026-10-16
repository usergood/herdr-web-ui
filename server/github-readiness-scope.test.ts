import { expect, test } from "bun:test";
import { githubQueueFixture } from "../scripts/fixtures/github-queue.ts";

test.each(["app", "label"] as const)("dependency drift at an incomplete readiness fence requires %s renewal after restart", async renewal => {
  const f = githubQueueFixture(true);
  try {
    const { route, readiness } = await f.setup();
    await f.renewLabels(route);
    let source = (await f.json(route + "/sync", {})).sources[0];
    await f.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await f.json(route + "/issues/1/prepare", { source_revision: source.revision });
    source = (await f.json(route)).sources[0];
    expect(source.readiness.eligible).toBe(true);
    const dependency = { ...f.issue, number: 2, node_id: "fictional-added", html_url: "https://github.com/fictional/project/issues/2" };
    f.save([f.issue], false, {}, false, [f.issue], { dependencies: { 1: [dependency] } });
    expect((await f.json(route + "/sync", {})).sources[0].readiness_evidence.complete).toBe(false);
    f.restart();
    f.save([f.issue], true);
    expect((await f.post(route + "/sync", {})).status).toBe(409);
    f.save();
    const restored = (await f.json(route + "/sync", {})).sources[0];
    expect(restored.revision).toBe(source.revision);
    expect(restored.readiness_approvals).toEqual(source.readiness_approvals);
    expect(restored.readiness_evidence.label_event).toEqual(source.readiness_evidence.label_event);
    expect(restored.readiness).toMatchObject({ eligible: false, approval: null });
    expect((await f.json(route + "/preview", {})).eligible_count).toBe(0);
    const path = `/implementations/${source.implementation_id}`;
    expect((await f.post(path + "/runs", { action: "implement-spec", idempotency_key: "stale-dependency-approval", issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: source.planning.graph_hash } })).status).toBe(409);
    expect((await f.json(path)).runs).toEqual([]);
    expect(f.launches).toEqual([]);
    if (renewal === "app") {
      await f.json(route + "/issues/1/approve", { source_revision: restored.revision, policy_revision: readiness.revision });
    } else {
      await f.renewLabels(route);
      await f.json(route + "/sync", {});
    }
    const renewed = (await f.json(route)).sources[0];
    expect(renewed.readiness).toMatchObject({ eligible: true, approval: { provenance: renewal === "app" ? "app_owner" : "github_label" } });
    expect(renewed.readiness.approval.id).not.toBe(source.readiness.approval.id);
    await f.json(route + "/issues/1/prepare", { source_revision: renewed.revision });
    for (let observation = 0; observation < 2; observation++) {
      const unchanged = (await f.json(route + "/sync", {})).sources[0];
      expect(unchanged.readiness.approval).toEqual(renewed.readiness.approval);
      expect(unchanged.readiness.eligible).toBe(true);
    }
    const current = (await f.json(route)).sources[0];
    const start = await f.post(path + "/runs", { action: "implement-spec", idempotency_key: "renewed-dependency-approval", issue_scope: { source_id: current.id, source_revision: current.revision, graph_hash: current.planning.graph_hash } });
    expect(start.status).toBe(202);
    expect((await start.json()).condition).toBe("working");
    expect(f.launches).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["readiness fence", "later PR outage"] as const)("observed dependency removal survives restoration after %s", async failure => {
  const f = githubQueueFixture(true);
  try {
    const { route, readiness } = await f.setup();
    const dependency = { ...f.issue, number: 2, node_id: "fictional-original", html_url: "https://github.com/fictional/project/issues/2" };
    const issues = [f.issue, dependency];
    const dependencies = { 1: [dependency] };
    f.save(issues, false, dependencies);
    const source = (await f.json(route + "/sync", {})).sources[0];
    await f.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    const approved = (await f.json(route)).sources[0].readiness.approval;
    if (failure === "readiness fence") {
      f.save(issues, false, dependencies, false, issues, { dependencies: { 1: [] } });
      expect((await f.json(route + "/sync", {})).sources[0].readiness_evidence.complete).toBe(false);
    } else {
      f.save(issues, false, {}, false, issues, undefined, { pulls_fail: true });
      expect((await f.post(route + "/sync", {})).status).toBe(409);
    }
    f.restart();
    f.save(issues, false, dependencies);
    const restored = (await f.json(route + "/sync", {})).sources[0];
    expect(restored.revision).toBe(source.revision);
    expect(restored.readiness_approvals).toContainEqual(approved);
    expect(restored.readiness).toMatchObject({ eligible: false, approval: null });
    await f.json(route + "/issues/1/approve", { source_revision: restored.revision, policy_revision: readiness.revision });
    const renewed = (await f.json(route)).sources[0].readiness.approval;
    expect(renewed.id).not.toBe(approved.id);
    expect((await f.json(route + "/sync", {})).sources[0].readiness).toMatchObject({ eligible: true, approval: renewed });
  } finally { f.close(); }
});

test("a valid added dependency before a failed page revokes readiness without importing history", async () => {
  const f = githubQueueFixture(true);
  try {
    const { route, readiness } = await f.setup();
    const source = (await f.json(route + "/sync", {})).sources[0];
    await f.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    const dependencies = Array.from({ length: 30 }, (_, index) => ({ ...f.issue, number: index + 2, node_id: `fictional-partial-${index}`, html_url: `https://github.com/fictional/project/issues/${index + 2}` }));
    f.save([f.issue], false, {}, false, [f.issue], undefined, { dependency_pages: { 1: [dependencies, null] } });
    expect((await f.post(route + "/sync", {})).status).toBe(409);
    f.restart(); f.save();
    const restored = (await f.json(route + "/sync", {})).sources[0];
    expect(restored.history).toEqual(source.history);
    expect(restored.readiness).toMatchObject({ eligible: false, approval: null });
  } finally { f.close(); }
});

test.each(["missing", "malformed"] as const)("%s dependency evidence cannot revoke approval for restored unchanged scope", async failure => {
  const f = githubQueueFixture(true);
  try {
    const { route, readiness } = await f.setup();
    const source = (await f.json(route + "/sync", {})).sources[0];
    await f.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    const approval = (await f.json(route)).sources[0].readiness.approval;
    f.setApiResponses({ "repos/fictional/project/issues/1/dependencies/blocked_by?per_page=30&page=1": failure === "missing" ? null : [{ ...f.issue, number: 2 }] });
    expect((await f.post(route + "/sync", {})).status).toBe(409);
    f.restart(); f.save();
    expect((await f.json(route + "/sync", {})).sources[0].readiness).toMatchObject({ eligible: true, approval });
    expect(f.launches).toEqual([]);
  } finally { f.close(); }
});

test("renewing readiness after reverted dependency drift never resumes a paused Run", async () => {
  const f = githubQueueFixture(true);
  try {
    const { route, readiness } = await f.setup();
    const source = (await f.json(route + "/sync", {})).sources[0];
    await f.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await f.json(route + "/issues/1/prepare", { source_revision: source.revision });
    const current = (await f.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const run = await f.json(path + "/runs", { action: "implement-spec", idempotency_key: "paused-dependency-drift", issue_scope: { source_id: current.id, source_revision: current.revision, graph_hash: current.planning.graph_hash } });
    f.save([f.issue], false, {}, false, [f.issue], { dependencies: { 1: [{ ...f.issue, number: 2, node_id: "fictional-added", html_url: "https://github.com/fictional/project/issues/2" }] } });
    await f.json(route + "/sync", {});
    const paused = (await f.json(path)).runs[0];
    expect(paused).toMatchObject({ id: run.id, condition: "needs_you", issue_pause: { reason: "scope_changed" }, manifest: run.manifest });
    f.restart(); f.save();
    await f.json(route + "/sync", {});
    await f.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    for (let observation = 0; observation < 2; observation++) await f.json(route + "/sync", {});
    expect((await f.json(route)).sources[0].readiness.eligible).toBe(true);
    const retained = await f.json(path);
    expect(retained.runs).toHaveLength(1);
    expect(retained.runs[0]).toMatchObject({ id: paused.id, condition: "needs_you", issue_pause: paused.issue_pause, manifest: run.manifest });
    expect(retained.questions.filter((question: any) => question.run_id === run.id && question.answer === null)).toHaveLength(1);
    expect(f.launches).toEqual([run.id]);
  } finally { f.close(); }
});
