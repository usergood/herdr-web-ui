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

test.each(["REST body", "REST title", "native relationship", "GraphQL body", "GraphQL title", "GraphQL state", "inventory body before outage"] as const)("known %s drift retires current completion but preserves its prior delivery proof", async change => {
  const f = await deliveryFixture();
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: "merged", delivery_evidence: { source_revision: f.target.revision } });
    const fresh = { ...f.prerequisite, body: change === "REST body" ? "Changed intended behavior" : f.prerequisite.body, title: change === "REST title" ? "Changed title" : f.prerequisite.title };
    const proof = { id: f.prerequisite.node_id, title: change === "GraphQL title" ? "Changed title" : f.prerequisite.title, body: f.prerequisite.body + (change === "GraphQL body" ? "\nChanged scope" : ""), state: change === "GraphQL state" ? "CLOSED" : "OPEN", createdAt: "2026-09-30T12:00:00Z", updatedAt: f.prerequisite.updated_at, lastEditedAt: null };
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

test.each(["branch", "release"] as const)("a known %s contradiction survives a later transport failure and unavailable evidence across restart", async artifact => {
  const f = await deliveryFixture({ requires: artifact === "release" ? "release" : "merge" });
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
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), [comparison]: { status: "diverged", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "b".repeat(40) } } });
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    const retired = await f.fixture.json(path);
    expect(retired.implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" });
    expect(retired.implementation.delivery_evidence).toBeUndefined();
    expect(retired.events).toContainEqual(expect.objectContaining({ kind: "issue_delivery_invalidated", data: { source_id: f.target.id, evidence: completed.delivery_evidence } }));
    f.fixture.restart();
    expect((await f.fixture.json(path)).implementation).toEqual(retired.implementation);
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.save(f.issues, false, f.dependencies);
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), [comparison]: null });
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
