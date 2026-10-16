import { expect, test } from "bun:test";
import { githubQueueFixture } from "../scripts/fixtures/github-queue.ts";
import { githubDeliveryResponses } from "../scripts/fixtures/github-delivery.ts";
import { deliveryFixture } from "./github-delivery-scope.fixture.ts";

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
