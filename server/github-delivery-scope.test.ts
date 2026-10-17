import { expect, test } from "bun:test";
import { githubDeliveryResponses } from "../scripts/fixtures/github-delivery.ts";
import { deliveryFixture } from "./github-delivery-scope.fixture.ts";

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
    await f.fixture.json(f.route + "/queue", { expected_revision: null, automatic_implementation: true, preview_revision: f.preview.revision, paused: false });
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
