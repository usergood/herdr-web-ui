import { expect, test } from "bun:test";
import { githubQueueFixture } from "../scripts/fixtures/github-queue.ts";
import { githubDeliveryResponses } from "../scripts/fixtures/github-delivery.ts";

async function deliveryFixture({ requires = "merge", closed = false, readyLabel = false }: { requires?: "merge" | "release"; closed?: boolean; readyLabel?: boolean } = {}) {
  const fixture = githubQueueFixture(true);
  try {
    const { route, configuration } = await fixture.setup();
    const prerequisite = { ...fixture.issue, number: 2, node_id: "fictional-prerequisite", title: "Prerequisite", labels: readyLabel ? [{ name: "ready-for-agent" }] : [] as { name: string }[], state: closed ? "closed" : "open", html_url: "https://github.com/fictional/project/issues/2" };
    if (requires === "release") fixture.issue.body = fixture.issue.body.replace("## Dependencies\nNone.", '## Dependencies\n[{"repository":"fictional/project","number":2,"requires":"release"}]');
    const issues = [fixture.issue, prerequisite];
    const dependencies = { 1: [prerequisite] };
    const pull = { number: 27, html_url: "https://github.com/fictional/project/pull/27", merged: false, merged_at: "2026-10-03T12:00:00Z", merge_commit_sha: "c".repeat(40), head: { sha: "a".repeat(40) }, base: { ref: "main", repo: { full_name: "fictional/project" } } };
    function coverageResponses() {
      fixture.setApiResponses({
        "repos/fictional/project/pulls/27": pull,
        "repos/fictional/project/releases/tags/v1": { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: false, published_at: "2026-10-04T12:00:00Z" },
        "repos/fictional/project/git/ref/tags/v1": { ref: "refs/tags/v1", object: { type: "commit", sha: "d".repeat(40) } },
        ["repos/fictional/project/compare/" + "c".repeat(40) + "..." + "d".repeat(40)]: { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } },
        "repos/fictional/project/branches/main": { name: "main", commit: { sha: "f".repeat(40) } },
        ["repos/fictional/project/compare/" + "c".repeat(40) + "..." + "f".repeat(40)]: { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } },
      });
    }
    fixture.save(issues, false, dependencies); coverageResponses();
    await fixture.json(route + "/configure", { ...configuration, expected_revision: (await fixture.json(route)).policy.revision, sync_enabled: true });
    const view = await fixture.json(route + "/sync", {});
    const dependent = view.sources.find((source: any) => source.number === 1);
    const target = view.sources.find((source: any) => source.number === 2);
    await fixture.json(route + "/issues/1/approve", { source_revision: dependent.revision, policy_revision: view.readiness_policy.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: dependent.revision });
    const coverage = { source_revision: target.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: requires === "release" ? "v1" : null };
    await fixture.json(route + "/issues/2/delivery", coverage);
    const preview = await fixture.json(route + "/preview", {});
    expect(preview.entries.find((entry: any) => entry.number === 1)).toMatchObject({ eligible: false, reasons: [{ code: "dependency_delivery_unverified", detail: "fictional/project #2" }] });
    return { fixture, route, prerequisite, issues, dependencies, pull, coverageResponses, target, dependent, coverage, preview };
  } catch (error) { fixture.close(); throw error; }
}

test.each(["merge", "release"] as const)("closing unchanged requirements preserves intended coverage for later verified %s delivery", async requires => {
  const f = await deliveryFixture({ requires });
  try {
    f.prerequisite.state = "closed";
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    const closed = (await f.fixture.json(f.route + "/sync", {})).sources.find((source: any) => source.number === 2);
    expect(closed).toMatchObject({ delivery_scope_current: true, delivery: { source_revision: f.target.revision }, readiness: { eligible: false, blockers: expect.arrayContaining(["closed"]) } });
    const path = `/implementations/${f.target.implementation_id}`;
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.restart();
    f.pull.merged = true; f.coverageResponses();
    if (requires === "release") {
      f.fixture.setApiResponses({ ...githubDeliveryResponses(), "repos/fictional/project/releases/tags/v1": null });
      await f.fixture.json(f.route + "/sync", {});
      expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
      f.coverageResponses();
    }
    const merged = await f.fixture.json(f.route + "/sync", {});
    expect(merged.sources.find((source: any) => source.number === 2).delivery).toEqual(closed.delivery);
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: requires === "release" ? "released" : "merged", delivery_evidence: { coverage_revision: closed.delivery.revision, source_revision: f.target.revision, requires, merges: [{ number: 27, target_branch: "main" }] } });
    expect(merged.sources.find((source: any) => source.number === 1).dependencies).toMatchObject({ satisfied: true, edges: [{ blocker: null }] });
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
    f.prerequisite.labels.push({ name: "documentation" });
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    const metadata = (await f.fixture.json(f.route + "/sync", {})).sources.find((source: any) => source.number === 2);
    expect(metadata).toMatchObject({ delivery_scope_current: true, delivery: closed.delivery });
    expect((await f.fixture.json(path)).implementation).toEqual(completed);
    f.fixture.save(f.issues, true, f.dependencies); f.coverageResponses();
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    f.fixture.restart();
    expect((await f.fixture.json(path)).implementation).toEqual(completed);
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["REST", "GraphQL"] as const)("closure first observed at the %s fence preserves coverage through incomplete evidence and restart", async fence => {
  const f = await deliveryFixture();
  try {
    f.pull.merged = true;
    const proof = { id: f.prerequisite.node_id, title: f.prerequisite.title, body: f.prerequisite.body, state: "CLOSED", createdAt: "2026-09-30T12:00:00Z", updatedAt: f.prerequisite.updated_at, lastEditedAt: null };
    f.fixture.save(f.issues, false, f.dependencies, false, fence === "REST" ? [f.issues[0]!, { ...f.prerequisite, state: "closed" }] : f.issues, fence === "GraphQL" ? { proof } : undefined);
    f.coverageResponses();
    const partial = (await f.fixture.json(f.route + "/sync", {})).sources.find((source: any) => source.number === 2);
    expect(partial).toMatchObject({ delivery_scope_current: true, readiness_evidence: { complete: false } });
    const path = `/implementations/${f.target.implementation_id}`;
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.restart();
    f.prerequisite.state = "closed";
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    const complete = (await f.fixture.json(f.route + "/sync", {})).sources.find((source: any) => source.number === 2);
    expect(complete.delivery).toEqual(partial.delivery);
    expect(complete.delivery_scope_current).toBe(true);
    expect((await f.fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: "merged", delivery_evidence: { coverage_revision: partial.delivery.revision } });
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["REST", "GraphQL"] as const)("reopening after closure seen only at the %s fence still requires renewed intended coverage", async fence => {
  const f = await deliveryFixture();
  try {
    const proof = { id: f.prerequisite.node_id, title: f.prerequisite.title, body: f.prerequisite.body, state: "CLOSED", createdAt: "2026-09-30T12:00:00Z", updatedAt: f.prerequisite.updated_at, lastEditedAt: null };
    f.fixture.save(f.issues, false, f.dependencies, false, fence === "REST" ? [f.issues[0]!, { ...f.prerequisite, state: "closed" }] : f.issues, fence === "GraphQL" ? { proof } : undefined);
    f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    f.fixture.restart();
    f.pull.merged = true;
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    const view = await f.fixture.json(f.route + "/sync", {});
    const target = view.sources.find((source: any) => source.number === 2);
    expect(target).toMatchObject({ state: "open", delivery_scope_current: false });
    expect((await f.fixture.json(`/implementations/${f.target.implementation_id}`)).implementation.stage).not.toBe("done");
    expect(view.sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(false);
    await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, source_revision: target.revision, expected_revision: target.delivery.revision });
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(`/implementations/${f.target.implementation_id}`)).implementation).toMatchObject({ stage: "done", outcome: "merged" });
  } finally { f.fixture.close(); }
});

test("a prerequisite body changed at the readiness fence cannot complete or automatically admit its dependent", async () => {
  const f = await deliveryFixture();
  try {
    await f.fixture.json(f.route + "/queue", { expected_revision: null, automatic_implementation: true, preview_revision: f.preview.revision, paused: false, max_implementations: 1 });
    f.pull.merged = true;
    f.fixture.save(f.issues, false, f.dependencies, false, [f.issues[0]!, { ...f.prerequisite, body: "Changed intended behavior during collection" }]);
    f.coverageResponses();
    const view = await f.fixture.json(f.route + "/sync", {});
    expect(view.sources.find((source: any) => source.number === 2).readiness_evidence).toMatchObject({ complete: false, problem: "The issue changed while collecting readiness; sync again" });
    const detail = await f.fixture.json(`/implementations/${f.target.implementation_id}`);
    expect(detail.implementation.stage).not.toBe("done");
    expect(detail.implementation.outcome).toBe("none");
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1)).toMatchObject({ eligible: false, reasons: [{ code: "dependency_delivery_unverified", detail: "fictional/project #2" }] });
    expect(f.fixture.launches).toEqual([]);
  } finally { f.fixture.close(); }
});

test.each(["body", "native dependencies"] as const)("closure with changed %s still retires intended coverage across a revert", async change => {
  const f = await deliveryFixture();
  try {
    f.prerequisite.state = "closed";
    const closed = { ...f.prerequisite, body: change === "body" ? "Changed intended work" : f.prerequisite.body };
    f.fixture.save([f.issues[0]!, closed], false, change === "native dependencies" ? { ...f.dependencies, 2: [f.fixture.issue] } : f.dependencies);
    f.pull.merged = true; f.coverageResponses();
    let view = await f.fixture.json(f.route + "/sync", {});
    expect(view.sources.find((source: any) => source.number === 2).delivery_scope_current).toBe(false);
    const path = `/implementations/${f.target.implementation_id}`;
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    f.fixture.restart();
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    view = await f.fixture.json(f.route + "/sync", {});
    expect(view.sources.find((source: any) => source.number === 2).delivery_scope_current).toBe(false);
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
  } finally { f.fixture.close(); }
});

test.each(["wrong target", "stale PR head"] as const)("closed unchanged work cannot be delivered from a %s", async mismatch => {
  const f = await deliveryFixture();
  try {
    f.prerequisite.state = "closed";
    f.pull.merged = true;
    if (mismatch === "wrong target") f.pull.base.ref = "other";
    else f.pull.head.sha = "b".repeat(40);
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    const view = await f.fixture.json(f.route + "/sync", {});
    expect(view.sources.find((source: any) => source.number === 2).delivery_scope_current).toBe(true);
    expect((await f.fixture.json(`/implementations/${f.target.implementation_id}`)).implementation.stage).not.toBe("done");
    expect(view.sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(false);
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
  } finally { f.fixture.close(); }
});

test("replacement coverage retires old completion until its current PRs and containing release are verified", async () => {
  const f = await deliveryFixture();
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: "merged" });
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
    const prior = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2).delivery;
    const view = await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, expected_revision: prior.revision, intended_prs: [...f.coverage.intended_prs, { number: 28, head: "b".repeat(40) }], release_tag: "v1" });
    const replacement = view.sources.find((source: any) => source.number === 2).delivery;
    expect(replacement.revision).not.toBe(prior.revision);
    const retired = await f.fixture.json(path);
    expect(retired.implementation.stage).not.toBe("done");
    expect(retired.implementation.delivery_evidence).toBeUndefined();
    expect(retired.events).toContainEqual(expect.objectContaining({ kind: "issue_delivery_invalidated", data: { source_id: f.target.id, evidence: completed.delivery_evidence } }));
    expect(view.sources.find((source: any) => source.number === 2).delivery_history).toContainEqual(expect.objectContaining({ revision: prior.revision }));
    expect(view.sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(false);
    const responses = {
      "repos/fictional/project/pulls/28": { ...f.pull, number: 28, html_url: "https://github.com/fictional/project/pull/28", head: { sha: "b".repeat(40) }, merged: false },
    };
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), ...responses });
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    f.fixture.restart();
    f.fixture.save(f.issues, true, f.dependencies); f.coverageResponses();
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    expect((await f.fixture.json(path)).implementation.delivery_evidence).toBeUndefined();
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    responses["repos/fictional/project/pulls/28"].merged = true;
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), ...responses, "repos/fictional/project/releases/tags/v1": null });
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), ...responses });
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: "released", delivery_evidence: { coverage_revision: replacement.revision, requires: "release", merges: [{ number: 27 }, { number: 28 }], release: { tag: "v1" } } });
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["head", "branch", "release", "empty", "same coverage"] as const)("successful %s replacement cannot retain proof for its prior coverage revision", async change => {
  const f = await deliveryFixture({ requires: "release" });
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: "released" });
    const prior = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2).delivery;
    const view = await f.fixture.json(f.route + "/issues/2/delivery", {
      ...f.coverage, expected_revision: prior.revision,
      ...(change === "head" ? { intended_prs: [{ number: 27, head: "b".repeat(40) }] } : {}),
      ...(change === "branch" ? { target_branch: "other" } : {}),
      ...(change === "release" ? { release_tag: null } : {}),
      ...(change === "empty" ? { intended_prs: [] } : {}),
    });
    const target = view.sources.find((source: any) => source.number === 2);
    expect(target.delivery.revision).not.toBe(prior.revision);
    expect(target.delivery_requires).toBe("release");
    const retired = await f.fixture.json(path);
    expect(retired.implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" });
    expect(retired.implementation.delivery_evidence).toBeUndefined();
    expect(retired.events).toContainEqual(expect.objectContaining({ kind: "issue_delivery_invalidated", data: { source_id: f.target.id, evidence: completed.delivery_evidence } }));
    expect(view.sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(false);
    await f.fixture.json(f.route + "/sync", {});
    f.fixture.restart();
    const current = (await f.fixture.json(path)).implementation;
    if (change === "same coverage") {
      expect(current).toMatchObject({ stage: "done", outcome: "released", delivery_evidence: { coverage_revision: target.delivery.revision } });
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
    } else {
      expect(current).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" });
      expect(current.delivery_evidence).toBeUndefined();
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    }
  } finally { f.fixture.close(); }
});

test("rejected coverage writes preserve verified current completion and dependent delivery", async () => {
  const f = await deliveryFixture();
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = await f.fixture.json(path);
    const prior = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2).delivery;
    const currentCoverage = { ...f.coverage, expected_revision: prior.revision };
    for (const [change, status] of [
      [{ expected_revision: null }, 409], [{ source_revision: "stale" }, 409],
      [{ intended_prs: [{ number: 27, head: "invalid" }] }, 400],
      [{ target_branch: "bad..branch" }, 400], [{ release_tag: "bad tag" }, 400],
    ] as const) {
      expect((await f.fixture.post(f.route + "/issues/2/delivery", { ...currentCoverage, ...change })).status).toBe(status);
      const detail = await f.fixture.json(path);
      expect(detail.implementation).toEqual(completed.implementation);
      expect(detail.events).toEqual(completed.events);
      const view = await f.fixture.json(f.route);
      expect(view.sources.find((source: any) => source.number === 2).delivery).toEqual(prior);
      expect(view.sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(true);
    }
  } finally { f.fixture.close(); }
});

test("a failed prerequisite approval fence invalidates previously satisfied dependencies across restart and outage", async () => {
  const f = await deliveryFixture();
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
    f.fixture.save(f.issues, false, f.dependencies, false, [f.issues[0]!, { ...f.prerequisite, title: "Changed prerequisite" }]);
    f.coverageResponses();
    const readiness = (await f.fixture.json(f.route)).readiness_policy;
    const refused = await f.fixture.post(f.route + "/issues/2/approve", { source_revision: f.target.revision, policy_revision: readiness.revision });
    expect(refused.status).toBe(409);
    const queue = await f.fixture.json(f.route + "/queue");
    expect(queue.entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(false);
    f.fixture.restart();
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.save(f.issues, true, f.dependencies); f.coverageResponses();
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2).readiness_evidence.complete).toBe(false);
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
  } finally { f.fixture.close(); }
});

test.each(["REST body", "REST title", "native relationship", "GraphQL body", "GraphQL title", "inventory body before outage"] as const)("known %s drift retires current completion but preserves its prior delivery proof", async change => {
  const f = await deliveryFixture();
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: "merged", delivery_evidence: { source_revision: f.target.revision } });
    const fresh = { ...f.prerequisite, body: change === "REST body" ? "Changed intended behavior" : f.prerequisite.body, title: change === "REST title" ? "Changed title" : f.prerequisite.title };
    const proof = { id: f.prerequisite.node_id, title: change === "GraphQL title" ? "Changed title" : f.prerequisite.title, body: f.prerequisite.body + (change === "GraphQL body" ? "\nChanged scope" : ""), state: "OPEN", createdAt: "2026-09-30T12:00:00Z", updatedAt: f.prerequisite.updated_at, lastEditedAt: null };
    const readiness = change === "native relationship" ? { dependencies: { 2: [f.fixture.issue] } } : change.startsWith("GraphQL") ? { proof } : undefined;
    if (change === "inventory body before outage") f.prerequisite.body = "Changed inventory before PR outage";
    f.fixture.save(f.issues, false, f.dependencies, false, [f.issues[0]!, fresh], readiness, change === "inventory body before outage" ? { pulls_fail: true } : undefined);
    f.coverageResponses();
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(change === "inventory body before outage" ? 409 : 200);
    const changed = await f.fixture.json(path);
    expect(changed.implementation.stage).not.toBe("done");
    expect(changed.implementation.outcome).toBe("none");
    expect(changed.implementation.delivery_evidence).toBeUndefined();
    expect(changed.events).toContainEqual(expect.objectContaining({ kind: "issue_delivery_invalidated", data: expect.objectContaining({ source_id: f.target.id, evidence: completed.delivery_evidence }) }));
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.restart();
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    if (change !== "REST body") return;
    f.fixture.save(f.issues, true, f.dependencies); f.coverageResponses();
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    // The next complete observation retains the edited scope, so old coverage
    // still cannot certify it. The owner must link intended coverage anew.
    f.prerequisite.body = "Changed intended behavior";
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    const observed = (await f.fixture.json(f.route + "/sync", {})).sources.find((source: any) => source.number === 2);
    expect(observed.readiness_evidence.complete).toBe(true);
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, source_revision: observed.revision, expected_revision: observed.delivery.revision });
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: "merged", delivery_evidence: { source_revision: observed.revision } });
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["REST title", "REST state", "native relationship", "GraphQL body", "GraphQL title", "GraphQL state", "partial history", "missing GraphQL"] as const)("%s uncertainty blocks old prerequisite coverage for completion and dependent delivery", async change => {
  const f = await deliveryFixture();
  try {
    f.pull.merged = true;
    const fresh = { ...f.prerequisite, ...(change === "REST title" ? { title: "Changed title" } : {}), ...(change === "REST state" ? { state: "closed" } : {}) };
    const proof = { id: f.prerequisite.node_id, title: change === "GraphQL title" ? "Changed title" : f.prerequisite.title, body: f.prerequisite.body + (change === "GraphQL body" ? "\nChanged scope" : ""), state: change === "GraphQL state" ? "CLOSED" : "OPEN", createdAt: "2026-09-30T12:00:00Z", updatedAt: f.prerequisite.updated_at, lastEditedAt: null };
    const readiness = change === "native relationship" ? { dependencies: { 2: [f.fixture.issue] } }
      : change === "partial history" ? { event_pages: [Array.from({ length: 100 }, (_, index) => ({ id: index + 1, event: "commented", created_at: "2026-10-02T12:00:00Z" })), null] }
      : change === "missing GraphQL" ? { proof: null }
      : change.startsWith("GraphQL") ? { proof } : undefined;
    f.fixture.save(f.issues, false, f.dependencies, false, [f.issues[0]!, fresh], readiness);
    f.coverageResponses();
    const view = await f.fixture.json(f.route + "/sync", {});
    expect(view.sources.find((source: any) => source.number === 2).readiness_evidence.complete).toBe(false);
    expect((await f.fixture.json(`/implementations/${f.target.implementation_id}`)).implementation).toMatchObject({ stage: "inbox", outcome: "none" });
    const dependent = view.sources.find((source: any) => source.number === 1);
    expect(dependent.dependencies).toMatchObject({ satisfied: false, edges: [{ blocker: "delivery_unverified" }] });
    expect(dependent.dependencies.edges[0].delivery).toBeUndefined();
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    expect(f.fixture.launches).toEqual([]);
  } finally { f.fixture.close(); }
});

test.each(["merge", "release"] as const)("complete observations certify %s for a closed non-ready prerequisite without owner readiness approval", async requires => {
  const f = await deliveryFixture({ requires, closed: true });
  try {
    f.pull.merged = true;
    // Timestamp-only updates retain the exact coverage scope.
    f.prerequisite.updated_at = "2026-10-04T12:00:00Z";
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    const view = await f.fixture.json(f.route + "/sync", {});
    const target = view.sources.find((source: any) => source.number === 2);
    expect(target.revision).toBe(f.target.revision);
    expect(target.readiness_evidence.complete).toBe(true);
    expect(target.readiness).toMatchObject({ eligible: false, approval: null, blockers: expect.arrayContaining(["closed", "role_not_ready"]) });
    const completed = (await f.fixture.json(`/implementations/${target.implementation_id}`)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: requires === "release" ? "released" : "merged", delivery_evidence: { source_revision: target.revision, requires, merges: [{ number: 27, merge_commit: "c".repeat(40) }] } });
    const dependent = view.sources.find((source: any) => source.number === 1);
    expect(dependent.dependencies).toMatchObject({ satisfied: true, edges: [{ blocker: null, delivery: { merges: [{ number: 27 }] } }] });
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
    // Label eligibility changes alone do not revoke current delivery.
    f.prerequisite.labels.push({ name: "needs-triage" });
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const after = await f.fixture.json(`/implementations/${target.implementation_id}`);
    expect(after.implementation).toEqual(completed);
    expect(after.events.filter((event: any) => event.kind === "issue_delivery_invalidated")).toEqual([]);
  } finally { f.fixture.close(); }
});

test("withdrawing a published containing release retires completion until fresh publication and containment are verified", async () => {
  const f = await deliveryFixture({ requires: "release" });
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: "released" });
    const releasePath = "repos/fictional/project/releases/tags/v1";
    const draft = { id: 1042, node_id: "fictional-release-v1", tag_name: "v1", target_commitish: "main", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, prerelease: false, created_at: "2026-10-03T12:00:00Z", published_at: null };
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), [releasePath]: draft });
    const withdrawn = await f.fixture.json(f.route + "/sync", {});
    const retired = await f.fixture.json(path);
    expect(retired.implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" });
    expect(retired.implementation.delivery_evidence).toBeUndefined();
    expect(retired.events).toContainEqual(expect.objectContaining({ kind: "issue_delivery_invalidated", data: { source_id: f.target.id, evidence: completed.delivery_evidence } }));
    expect(withdrawn.sources.find((source: any) => source.number === 1).dependencies).toMatchObject({ satisfied: false, fresh: false, edges: [{ requires: "release", blocker: "release_unverified" }] });
    f.fixture.restart();
    f.fixture.save(f.issues, false, f.dependencies, false, f.issues, undefined, { api_fail: releasePath });
    f.coverageResponses();
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    expect((await f.fixture.json(path)).implementation).toEqual(retired.implementation);
    f.fixture.save(f.issues, false, f.dependencies);
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), [releasePath]: null });
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toEqual(retired.implementation);
    f.fixture.setApiResponses(githubDeliveryResponses({ containsRelease: false }));
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation.delivery_evidence).toBeUndefined();
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.coverageResponses();
    const published = await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: "released", delivery_evidence: { release: { tag: "v1", commit: "d".repeat(40) } } });
    expect(published.sources.find((source: any) => source.number === 1).dependencies).toMatchObject({ satisfied: true, fresh: true, edges: [{ blocker: null }] });
  } finally { f.fixture.close(); }
});

test.each([
  { name: "missing", response: null },
  { name: "missing publication field", response: { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true } },
  { name: "wrong tag", response: { tag_name: "v2", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, published_at: null } },
  { name: "wrong repository", response: { tag_name: "v1", html_url: "https://github.com/fictional/other/releases/tag/v1", draft: true, published_at: null } },
  { name: "malformed publication", response: { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, published_at: "unknown" } },
  { name: "malformed draft", response: { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: "true", published_at: null } },
])("$name release evidence blocks admission without inventing a withdrawal", async ({ response }) => {
  const f = await deliveryFixture({ requires: "release" });
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed.stage).toBe("done");
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), "repos/fictional/project/releases/tags/v1": response });
    const view = await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toEqual(completed);
    expect((await f.fixture.json(path)).events.filter((event: any) => event.kind === "issue_delivery_invalidated")).toEqual([]);
    expect(view.sources.find((source: any) => source.number === 1).dependencies).toMatchObject({ satisfied: false, fresh: true, edges: [{ blocker: "release_unverified" }] });
    f.fixture.restart();
    expect((await f.fixture.json(path)).implementation).toEqual(completed);
    f.coverageResponses(); await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["branch", "release"] as const)("contradictory %s containment retires completion and preserves its proof across restart", async artifact => {
  const f = await deliveryFixture({ requires: artifact === "release" ? "release" : "merge" });
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: artifact === "release" ? "released" : "merged" });
    const responses = githubDeliveryResponses();
    responses["repos/fictional/project/compare/" + "c".repeat(40) + "..." + (artifact === "release" ? "d" : "f").repeat(40)] = { status: "behind", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "b".repeat(40) } };
    f.fixture.setApiResponses(responses);
    await f.fixture.json(f.route + "/sync", {});
    const retired = await f.fixture.json(path);
    expect(retired.implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" });
    expect(retired.implementation.delivery_evidence).toBeUndefined();
    expect(retired.events).toContainEqual(expect.objectContaining({ kind: "issue_delivery_invalidated", data: { source_id: f.target.id, evidence: completed.delivery_evidence } }));
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.restart();
    expect((await f.fixture.json(path)).implementation).toEqual(retired.implementation);
    f.fixture.save(f.issues, true, f.dependencies); f.coverageResponses();
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    expect((await f.fixture.json(path)).implementation.delivery_evidence).toBeUndefined();
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: artifact === "release" ? "released" : "merged" });
  } finally { f.fixture.close(); }
});

test.each([
  { order: "dependent first", outage: false },
  { order: "own completion first", outage: false },
  { order: "dependent first", outage: true },
])("a later merge contradiction revokes earlier and later consumers with $order (later outage: $outage)", async ({ order, outage }) => {
  const f = await deliveryFixture();
  try {
    const releaseConsumer = { ...f.fixture.issue, number: 3, node_id: "fictional-release-consumer", html_url: "https://github.com/fictional/project/issues/3", body: f.fixture.issue.body.replace("## Dependencies\nNone.", '## Dependencies\n[{"repository":"fictional/project","number":2,"requires":"release"}]') };
    const laterConsumer = { ...f.fixture.issue, number: 4, node_id: "fictional-later-consumer", html_url: "https://github.com/fictional/project/issues/4" };
    // Import order is durable. Recreate the fixture for the own-completion-first variant
    // by using a second prerequisite whose own proof precedes all its consumers.
    const targetIssue = order === "own completion first" ? { ...f.prerequisite, number: 5, node_id: "fictional-first-prerequisite", html_url: "https://github.com/fictional/project/issues/5" } : f.prerequisite;
    releaseConsumer.body = releaseConsumer.body.replace('"number":2', '"number":' + targetIssue.number);
    const unrelated = { ...f.prerequisite, number: 6, node_id: "fictional-fallible-delivery", html_url: "https://github.com/fictional/project/issues/6" };
    const issues = [...f.issues, ...(order === "own completion first" ? [targetIssue] : []), releaseConsumer, laterConsumer, ...(outage ? [unrelated] : [])];
    const dependencies = { 1: order === "dependent first" ? [targetIssue] : [], 4: [targetIssue] };
    f.fixture.save(issues, false, dependencies); f.coverageResponses();
    let view = await f.fixture.json(f.route + "/sync", {});
    const target = view.sources.find((source: any) => source.number === targetIssue.number);
    if (targetIssue.number !== 2) {
      const original = view.sources.find((source: any) => source.number === 2);
      await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, expected_revision: original.delivery.revision, intended_prs: [] });
      await f.fixture.json(f.route + `/issues/${targetIssue.number}/delivery`, { ...f.coverage, source_revision: target.revision });
    }
    const release = view.sources.find((source: any) => source.number === 3);
    const path = `/implementations/${release.implementation_id}`;
    const spec = await f.fixture.json(path + "/specifications", { content: releaseConsumer.body });
    for (const kind of ["specification", "testing_seams"]) await f.fixture.json(path + "/approvals", { kind, revision: spec.id, scope: "Require the released prerequisite", issue_scope: { source_id: release.id, source_revision: release.revision } });
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const targetPath = `/implementations/${target.implementation_id}`;
    expect((await f.fixture.json(targetPath)).implementation.stage).toBe("done");
    if (outage) {
      const other = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 6);
      await f.fixture.json(f.route + "/issues/6/delivery", { ...f.coverage, source_revision: other.revision, intended_prs: [{ number: 28, head: "b".repeat(40) }] });
      f.fixture.save(issues, false, dependencies, false, issues, undefined, { api_fail: "repos/fictional/project/pulls/28" });
    }
    const responses = githubDeliveryResponses();
    const branch = "repos/fictional/project/branches/main";
    // The merge-only proof uses f; the release verification subsequently sees
    // a force push to e excluding the same merge. All later merge consumers share it.
    responses["repos/fictional/project/compare/" + "c".repeat(40) + "..." + "e".repeat(40)] = { status: "diverged", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "b".repeat(40) } };
    f.fixture.setApiResponses(responses, { [branch]: [{ name: "main", commit: { sha: "f".repeat(40) } }, { name: "main", commit: { sha: "e".repeat(40) } }] });
    if (outage) {
      expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
      view = await f.fixture.json(f.route);
    } else view = await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(targetPath)).implementation.delivery_evidence).toBeUndefined();
    for (const number of order === "dependent first" ? [1, 3, 4] : [3, 4]) expect(view.sources.find((source: any) => source.number === number).dependencies).toMatchObject({ satisfied: false, fresh: false });
    f.fixture.restart();
    expect((await f.fixture.json(targetPath)).implementation.stage).not.toBe("done");
    f.fixture.save(issues, false, dependencies); f.coverageResponses(); await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(targetPath)).implementation.stage).toBe("done");
    expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 4).dependencies.satisfied).toBe(true);
    if (order === "dependent first") expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["ancestry", "withdrawal"] as const)("a release-only %s contradiction preserves merge consumers and unrelated source completion", async contradiction => {
  const f = await deliveryFixture();
  try {
    const consumer = { ...f.fixture.issue, number: 3, node_id: "fictional-release", html_url: "https://github.com/fictional/project/issues/3", body: f.fixture.issue.body.replace("## Dependencies\nNone.", '## Dependencies\n[{"repository":"fictional/project","number":2,"requires":"release"}]') };
    const unrelated = { ...f.prerequisite, number: 4, node_id: "fictional-independent", html_url: "https://github.com/fictional/project/issues/4" };
    const later = { ...f.fixture.issue, number: 5, node_id: "fictional-later-merge", html_url: "https://github.com/fictional/project/issues/5" };
    const otherBranch = { ...f.prerequisite, number: 6, node_id: "fictional-other-branch", html_url: "https://github.com/fictional/project/issues/6" };
    f.fixture.save([...f.issues, consumer, unrelated, later, otherBranch], false, { ...f.dependencies, 5: [f.prerequisite] });
    f.coverageResponses();
    let view = await f.fixture.json(f.route + "/sync", {});
    const release = view.sources.find((source: any) => source.number === 3);
    const path = `/implementations/${release.implementation_id}`;
    const spec = await f.fixture.json(path + "/specifications", { content: consumer.body });
    for (const kind of ["specification", "testing_seams"]) await f.fixture.json(path + "/approvals", { kind, revision: spec.id, scope: "Released prerequisite", issue_scope: { source_id: release.id, source_revision: release.revision } });
    const original = view.sources.find((source: any) => source.number === 2);
    await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, expected_revision: original.delivery.revision, release_tag: "v1" });
    const other = view.sources.find((source: any) => source.number === 4);
    await f.fixture.json(f.route + "/issues/4/delivery", { ...f.coverage, source_revision: other.revision });
    const maintenance = view.sources.find((source: any) => source.number === 6);
    await f.fixture.json(f.route + "/issues/6/delivery", { ...f.coverage, source_revision: maintenance.revision, target_branch: "maintenance", intended_prs: [{ number: 28, head: "b".repeat(40) }] });
    // Supply a positive contradiction, rather than merely unavailable evidence.
    const responses = githubDeliveryResponses();
    responses["repos/fictional/project/branches/maintenance"] = { name: "maintenance", commit: { sha: "f".repeat(40) } };
    responses["repos/fictional/project/pulls/28"] = { ...f.pull, number: 28, html_url: "https://github.com/fictional/project/pull/28", merged: true, head: { sha: "b".repeat(40) }, base: { ref: "maintenance", repo: { full_name: "fictional/project" } } };
    if (contradiction === "withdrawal") responses["repos/fictional/project/releases/tags/v1"] = { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, published_at: null };
    else responses["repos/fictional/project/compare/" + "c".repeat(40) + "..." + "d".repeat(40)] = { status: "diverged", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "b".repeat(40) } };
    f.fixture.setApiResponses(responses);
    view = await f.fixture.json(f.route + "/sync", {});
    for (const number of [1, 5]) expect(view.sources.find((source: any) => source.number === number).dependencies).toMatchObject({ satisfied: true, fresh: true, edges: [{ requires: "merge", blocker: null }] });
    expect(view.sources.find((source: any) => source.number === 3).dependencies).toMatchObject({ satisfied: false, fresh: false });
    expect((await f.fixture.json(`/implementations/${other.implementation_id}`)).implementation).toMatchObject({ stage: "done", outcome: "merged" });
    expect((await f.fixture.json(`/implementations/${maintenance.implementation_id}`)).implementation).toMatchObject({ stage: "done", outcome: "merged" });
    expect((await f.fixture.json(`/implementations/${f.target.implementation_id}`)).implementation.stage).not.toBe("done");
  } finally { f.fixture.close(); }
});

test("new current-bound approved app requirements retire coverage immediately and require explicit relinking", async () => {
  const f = await deliveryFixture();
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    const before = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2);
    const linked = before.delivery;
    const spec = await f.fixture.json(path + "/specifications", { content: f.prerequisite.body + "\n## Additional acceptance\nAlso show goodbye." });
    // Neither a draft nor generic receipts authorize work for this issue scope.
    for (const kind of ["specification", "testing_seams"]) await f.fixture.json(path + "/approvals", { kind, revision: spec.id, scope: "Generic planning receipt" });
    f.coverageResponses(); await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2).delivery_scope_current).toBe(true);
    const issueScope = { source_id: f.target.id, source_revision: f.target.revision };
    for (const kind of ["specification", "testing_seams"]) await f.fixture.json(path + "/approvals", { kind, revision: spec.id, scope: "Reviewed additional acceptance for this issue", issue_scope: issueScope });
    let target = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2);
    expect(target).toMatchObject({ delivery_scope_current: false, delivery: linked });
    expect(target.delivery_history).toEqual(before.delivery_history);
    const retired = await f.fixture.json(path);
    expect(retired.implementation.delivery_evidence).toBeUndefined();
    expect(retired.events).toContainEqual(expect.objectContaining({ kind: "issue_delivery_invalidated", data: { source_id: f.target.id, evidence: completed.delivery_evidence } }));
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.restart();
    f.fixture.save(f.issues, true, f.dependencies); f.coverageResponses();
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    expect((await f.fixture.json(path)).implementation.delivery_evidence).toBeUndefined();
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    target = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2);
    expect(target.delivery_scope_current).toBe(false);
    await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, expected_revision: linked.revision });
    f.coverageResponses(); await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: "merged" });
    expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2).delivery_history).toEqual([...before.delivery_history, expect.objectContaining({ source_revision: f.target.revision })]);
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["acceptance", "graph", "testing seams"] as const)("approved app-origin coverage survives closure and reaffirmation until approved %s changes", async changed => {
  const f = await deliveryFixture({ readyLabel: true });
  try {
    const path = `/implementations/${f.target.implementation_id}`;
    const scope = { source_id: f.target.id, source_revision: f.target.revision };
    const content = "## Scope\nShow an approved app greeting.\n## Acceptance criteria\nShow the app greeting.\n## Dependencies\nNone.";
    const seams = "Public HTTP and real browser journeys.";
    const approve = (kind: string, revision: string, text: string, bound = true) => f.fixture.json(path + "/approvals", { kind, revision, scope: text, ...(bound ? { issue_scope: scope } : {}) });
    let spec = await f.fixture.json(path + "/specifications", { content });
    await approve("specification", spec.id, "Approve intended app acceptance");
    await approve("testing_seams", spec.id, seams);
    const tickets = [{ key: "api", title: "Greeting API", acceptance: "Return the app greeting", dependencies: [] }, { key: "browser", title: "Greeting browser", acceptance: "Show the app greeting", dependencies: ["api"] }];
    const graph = await f.fixture.json(path + "/tickets", { specification_id: spec.id, tickets });
    await approve("ticket_graph", graph.hash, "Approve the app graph");
    const readiness = (await f.fixture.json(f.route)).readiness_policy;
    await f.fixture.json(f.route + "/issues/2/approve", { source_revision: f.target.revision, policy_revision: readiness.revision });
    const prepared = await f.fixture.json(f.route + "/issues/2/prepare", { source_revision: f.target.revision });
    expect(prepared.sources.find((source: any) => source.number === 2).planning).toMatchObject({ origin: "app_plan", condition: "prepared" });
    let target = prepared.sources.find((source: any) => source.number === 2);
    await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, expected_revision: target.delivery.revision });
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed.stage).toBe("done");
    f.prerequisite.state = "closed";
    f.prerequisite.labels.push({ name: "documentation" });
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    let view = await f.fixture.json(f.route + "/sync", {});
    target = view.sources.find((source: any) => source.number === 2);
    expect(target).toMatchObject({ delivery_scope_current: true, readiness: { eligible: false, blockers: expect.arrayContaining(["closed"]) } });
    expect((await f.fixture.json(path)).implementation).toEqual(completed);
    expect(view.sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(true);
    f.fixture.restart();
    // The same semantic app contract has new record IDs. Its accepted graph and
    // fallback seams still describe the same work, including on the closed source.
    scope.source_revision = target.revision;
    spec = await f.fixture.json(path + "/specifications", { content });
    await approve("specification", spec.id, "Reaffirm the same intended work");
    await approve("testing_seams", spec.id, seams);
    const reaffirmed = await f.fixture.json(path + "/tickets", { specification_id: spec.id, tickets: [...tickets].reverse() });
    await approve("ticket_graph", reaffirmed.hash, "Reaffirm the same graph");
    expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2).delivery_scope_current).toBe(true);
    let revision = spec.id;
    const kind = changed === "graph" ? "ticket_graph" : changed === "testing seams" ? "testing_seams" : "specification";
    const text = changed === "testing seams" ? "Public HTTP, real browser and accessibility journeys." : "Approve additional app acceptance";
    if (changed === "acceptance") {
      spec = await f.fixture.json(path + "/specifications", { content: content + "\n## More acceptance\nAlso show goodbye." });
      revision = spec.id;
    } else if (changed === "graph") {
      const revised = await f.fixture.json(path + "/tickets", { specification_id: spec.id, tickets: tickets.map(ticket => ({ ...ticket, acceptance: ticket.acceptance + " and goodbye" })) });
      revision = revised.hash;
    }
    await approve(kind, revision, text, false);
    expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2).delivery_scope_current).toBe(true);
    await approve(kind, revision, text);
    expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2).delivery_scope_current).toBe(false);
    expect((await f.fixture.json(path)).implementation.delivery_evidence).toBeUndefined();
    f.fixture.restart(); f.coverageResponses();
    view = await f.fixture.json(f.route + "/sync", {});
    expect(view.sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(false);
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    if (changed === "acceptance") {
      const reverted = await f.fixture.json(path + "/specifications", { content });
      await approve("specification", reverted.id, "Revert the app acceptance");
      await approve("testing_seams", reverted.id, seams);
      expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2).delivery_scope_current).toBe(false);
    }
    target = view.sources.find((source: any) => source.number === 2);
    await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, source_revision: target.revision, expected_revision: target.delivery.revision });
    f.coverageResponses(); view = await f.fixture.json(f.route + "/sync", {});
    expect(view.sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(true);
    expect((await f.fixture.json(path)).implementation.stage).toBe("done");
  } finally { f.fixture.close(); }
});

test("preparing a trusted issue-body plan preserves already linked intent through closure", async () => {
  const f = await deliveryFixture({ readyLabel: true });
  try {
    const readiness = (await f.fixture.json(f.route)).readiness_policy;
    await f.fixture.json(f.route + "/issues/2/approve", { source_revision: f.target.revision, policy_revision: readiness.revision });
    const before = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2);
    const prepared = await f.fixture.json(f.route + "/issues/2/prepare", { source_revision: f.target.revision });
    expect(prepared.sources.find((source: any) => source.number === 2)).toMatchObject({ delivery_scope_current: true, delivery: before.delivery, planning: { origin: "issue_body", condition: "prepared" } });
    f.prerequisite.state = "closed"; f.prerequisite.labels.push({ name: "documentation" });
    f.pull.merged = true;
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    f.fixture.restart();
    const view = await f.fixture.json(f.route + "/sync", {});
    expect(view.sources.find((source: any) => source.number === 2)).toMatchObject({ delivery_scope_current: true, delivery: before.delivery, readiness: { eligible: false } });
    expect((await f.fixture.json(`/implementations/${f.target.implementation_id}`)).implementation).toMatchObject({ stage: "done", outcome: "merged" });
    expect(view.sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["merge", "release"] as const)("unrelated metadata preserves %s coverage and dependent satisfaction without reusing readiness approval", async requires => {
  const f = await deliveryFixture({ requires, readyLabel: true });
  try {
    const readiness = (await f.fixture.json(f.route)).readiness_policy;
    await f.fixture.json(f.route + "/issues/2/approve", { source_revision: f.target.revision, policy_revision: readiness.revision });
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: requires === "release" ? "released" : "merged" });
    for (const labels of [[{ name: "ready-for-agent" }, { name: "documentation" }], [{ name: "ready-for-agent" }]]) {
      f.prerequisite.labels = labels;
      f.prerequisite.updated_at = "2026-10-05T12:00:00Z";
      f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
      const view = await f.fixture.json(f.route + "/sync", {});
      const prerequisite = view.sources.find((source: any) => source.number === 2);
      expect(prerequisite.delivery).toMatchObject({ source_revision: f.target.revision });
      expect(view.sources.find((source: any) => source.number === 1).dependencies).toMatchObject({ satisfied: true, edges: [{ blocker: null }] });
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
      expect((await f.fixture.json(path)).implementation).toEqual(completed);
      if (labels.length > 1) {
        expect(prerequisite.revision).not.toBe(f.target.revision);
        expect(prerequisite.readiness).toMatchObject({ eligible: false, approval: null });
      }
      f.fixture.restart();
      expect((await f.fixture.json(path)).implementation).toEqual(completed);
      f.fixture.save(f.issues, true, f.dependencies); f.coverageResponses();
      expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
      expect((await f.fixture.json(path)).implementation).toEqual(completed);
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
      f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
      await f.fixture.json(f.route + "/sync", {});
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
    }
  } finally { f.fixture.close(); }
});

test("a semantic edit observed only at the fence cannot regain old coverage by reverting", async () => {
  const f = await deliveryFixture();
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    expect((await f.fixture.json(path)).implementation.stage).toBe("done");
    f.fixture.save(f.issues, false, f.dependencies, false, [f.issues[0]!, { ...f.prerequisite, body: "Changed only at the fence" }]);
    f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation.delivery_evidence).toBeUndefined();
    f.fixture.restart();
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    const target = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2);
    await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, source_revision: target.revision, expected_revision: target.delivery.revision });
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation.stage).toBe("done");
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["branch", "release", "withdrawal"] as const)("a known %s contradiction survives a later transport failure and unavailable evidence across restart", async artifact => {
  const f = await deliveryFixture({ requires: artifact === "branch" ? "merge" : "release" });
  try {
    const third = { ...f.prerequisite, number: 3, node_id: "fictional-unrelated", html_url: "https://github.com/fictional/project/issues/3" };
    f.issues.push(third);
    f.pull.merged = true;
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    const view = await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed.stage).toBe("done");
    expect(view.sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(true);
    const other = view.sources.find((source: any) => source.number === 3);
    await f.fixture.json(f.route + "/issues/3/delivery", { ...f.coverage, source_revision: other.revision, intended_prs: [{ number: 28, head: "b".repeat(40) }] });
    f.fixture.save(f.issues, false, f.dependencies, false, f.issues, undefined, { api_fail: "repos/fictional/project/pulls/28" });
    const comparison = "repos/fictional/project/compare/" + "c".repeat(40) + "..." + (artifact === "release" ? "d" : "f").repeat(40);
    const proof = artifact === "withdrawal" ? "repos/fictional/project/releases/tags/v1" : comparison;
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), [proof]: artifact === "withdrawal" ? { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, published_at: null } : { status: "diverged", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "b".repeat(40) } } });
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    const retired = await f.fixture.json(path);
    expect(retired.implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" });
    expect(retired.implementation.delivery_evidence).toBeUndefined();
    expect(retired.events).toContainEqual(expect.objectContaining({ kind: "issue_delivery_invalidated", data: { source_id: f.target.id, evidence: completed.delivery_evidence } }));
    f.fixture.restart();
    expect((await f.fixture.json(path)).implementation).toEqual(retired.implementation);
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.save(f.issues, false, f.dependencies);
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), [proof]: null });
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation.delivery_evidence).toBeUndefined();
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation.stage).toBe("done");
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

for (const requires of ["merge", "release"] as const) {
  test.each(["missing", "malformed", "transport"] as const)(`${requires} evidence %s blocks fresh dependency admission without inventing contradictory completion`, async unavailable => {
    const f = await deliveryFixture({ requires });
    try {
      f.pull.merged = true; f.coverageResponses();
      await f.fixture.json(f.route + "/sync", {});
      const path = `/implementations/${f.target.implementation_id}`;
      const completed = (await f.fixture.json(path)).implementation;
      expect(completed.stage).toBe("done");
      const comparison = "repos/fictional/project/compare/" + "c".repeat(40) + "..." + (requires === "release" ? "d" : "f").repeat(40);
      f.prerequisite.labels.push({ name: "documentation" });
      f.fixture.save(f.issues, false, f.dependencies, false, f.issues, undefined, unavailable === "transport" ? { api_fail: comparison } : undefined);
      f.fixture.setApiResponses({ ...githubDeliveryResponses(), [comparison]: unavailable === "malformed" ? { status: "diverged", base_commit: { sha: "unknown" }, merge_base_commit: { sha: "b".repeat(40) } } : null });
      expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(unavailable === "transport" ? 409 : 200);
      const detail = await f.fixture.json(path);
      expect(detail.implementation).toEqual(completed);
      expect(detail.events.filter((event: any) => event.kind === "issue_delivery_invalidated")).toEqual([]);
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
      f.fixture.restart();
      expect((await f.fixture.json(path)).implementation).toEqual(completed);
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
      f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
      await f.fixture.json(f.route + "/sync", {});
      expect((await f.fixture.json(path)).implementation).toEqual(completed);
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
    } finally { f.fixture.close(); }
  });

  test.each(["title", "body", "native dependencies"] as const)(`${requires} coverage cannot cross an imported %s edit and revert`, async changed => {
    const f = await deliveryFixture({ requires });
    try {
      f.pull.merged = true; f.coverageResponses();
      await f.fixture.json(f.route + "/sync", {});
      const path = `/implementations/${f.target.implementation_id}`;
      expect((await f.fixture.json(path)).implementation.stage).toBe("done");
      const edited = { ...f.prerequisite, title: changed === "title" ? "Different intended work" : f.prerequisite.title, body: changed === "body" ? "Different requirements" : f.prerequisite.body };
      f.fixture.save([f.issues[0]!, edited], false, changed === "native dependencies" ? { ...f.dependencies, 2: [f.fixture.issue] } : f.dependencies);
      f.coverageResponses();
      await f.fixture.json(f.route + "/sync", {});
      expect((await f.fixture.json(path)).implementation.delivery_evidence).toBeUndefined();
      f.fixture.restart();
      f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
      await f.fixture.json(f.route + "/sync", {});
      const target = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 2);
      expect(target.revision).toBe(f.target.revision);
      expect((await f.fixture.json(path)).implementation.stage).not.toBe("done");
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
      await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, source_revision: target.revision, expected_revision: target.delivery.revision });
      await f.fixture.json(f.route + "/sync", {});
      expect((await f.fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: requires === "release" ? "released" : "merged", delivery_evidence: { requires } });
      expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
    } finally { f.fixture.close(); }
  });
}

test("an inventory reopening retires delivery even when the ready label is unchanged", async () => {
  const f = await deliveryFixture({ closed: true, readyLabel: true });
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    expect((await f.fixture.json(path)).implementation.stage).toBe("done");
    f.prerequisite.state = "open";
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toMatchObject({ stage: "inbox", outcome: "none" });
    expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 1).dependencies.satisfied).toBe(false);
  } finally { f.fixture.close(); }
});
