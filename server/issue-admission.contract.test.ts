import { expect, test } from "bun:test";
import { githubQueueFixture } from "../scripts/fixtures/github-queue.ts";

async function prepared(fixture: ReturnType<typeof githubQueueFixture>) {
  const setup = await fixture.setup();
  let view = await fixture.json(setup.route + "/sync", {});
  const source = view.sources[0];
  await fixture.json(setup.route + "/issues/1/approve", { source_revision: source.revision, policy_revision: setup.readiness.revision });
  await fixture.json(setup.route + "/issues/1/prepare", { source_revision: source.revision });
  view = await fixture.json(setup.route + "/sync", {});
  const current = view.sources[0];
  return { ...setup, source: current, path: `/implementations/${source.implementation_id}`, start: { action: "implement-spec", idempotency_key: "explicit-issue-start", issue_scope: { source_id: current.id, source_revision: current.revision, graph_hash: current.planning.graph_hash } } };
}

async function prepareSecond(fixture: ReturnType<typeof githubQueueFixture>, route: string, readiness: { revision: string }) {
  const view = await fixture.json(route);
  const source = view.sources.find((entry: any) => entry.number === 2);
  await fixture.json(route + "/issues/2/approve", { source_revision: source.revision, policy_revision: readiness.revision });
  await fixture.json(route + "/issues/2/prepare", { source_revision: source.revision });
  await fixture.json(route + "/sync", {});
  const detail = await fixture.json(`/implementations/${source.implementation_id}`);
  return { path: `/implementations/${source.implementation_id}`, start: { action: "implement-spec", idempotency_key: "second-issue-start", issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: detail.graph_hash } } };
}

test("explicit Start admits the prepared trusted plan with its frozen authorization and quality gates", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, source, project } = await prepared(fixture);
    const response = await fixture.post(path + "/runs", start);
    expect(response.status).toBe(202);
    const run = await response.json();
    expect(run).toMatchObject({ action: "implement-spec", condition: "working", specification_id: source.planning.specification_id, graph_hash: source.planning.graph_hash });
    expect(run.manifest.issue_admission).toMatchObject({ source: { id: source.id, revision: source.revision }, planning: { testing_seams: "Public HTTP and real browser journeys.", authorization: { checks_required: true, independent_reviews: ["standards", "spec"] } }, queue_policy: { automatic_implementation: false } });
    expect(run.manifest.project.checks).toEqual(project.checks);
    expect(run.manifest.tickets).toHaveLength(1);
    const detail = await fixture.json(path);
    expect(detail.approvals).toEqual([]);
    expect((await fixture.json(path + "/runs", start)).id).toBe(run.id);
    const reordered = { ...start, issue_scope: { graph_hash: start.issue_scope.graph_hash, source_revision: start.issue_scope.source_revision, source_id: start.issue_scope.source_id } };
    expect((await fixture.json(path + "/runs", reordered)).id).toBe(run.id);
    expect((await fixture.json(path)).runs).toHaveLength(1);
    const accepted = await fixture.post(`/runs/${run.id}/accept`, { head: run.base });
    expect(accepted.status).toBe(409);
    expect((await accepted.json()).error.code).toBe("fresh_evidence_required");
  } finally { fixture.close(); }
}, 20_000);

test("Pause queue refuses a new explicit issue Start while keeping its prepared plan", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
    const response = await fixture.post(path + "/runs", start);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("queue_paused");
    const detail = await fixture.json(path);
    expect(detail.runs).toEqual([]);
    expect(detail.github_sources[0].planning.condition).toBe("prepared");
  } finally { fixture.close(); }
}, 20_000);

test("explicit issue Start follows current board priority", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later issue" }]);
    const { path, route, readiness } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    const refused = await fixture.post(second.path + "/runs", second.start);
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("queue_priority_changed");
    await fixture.json(second.path + "/order", { before_id: path.split("/").at(-1) });
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(202);
  } finally { fixture.close(); }
}, 20_000);

test("Project implementing capacity remains reserved by an admitted issue Run", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later issue" }]);
    const { path, start, route, readiness } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    expect((await fixture.post(path + "/runs", start)).status).toBe(202);
    const refused = await fixture.post(second.path + "/runs", second.start);
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("project_capacity_exhausted");
    expect((await fixture.json(second.path)).runs).toEqual([]);
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: false, max_implementations: 2 });
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(202);
  } finally { fixture.close(); }
}, 20_000);

test("a Start key cannot replay a different trusted issue scope", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start } = await prepared(fixture);
    expect((await fixture.post(path + "/runs", start)).status).toBe(202);
    const changed = { ...start, issue_scope: { ...start.issue_scope, source_revision: "another-revision" } };
    const refused = await fixture.post(path + "/runs", changed);
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("idempotency_conflict");
    expect((await fixture.json(path)).runs).toHaveLength(1);
  } finally { fixture.close(); }
}, 20_000);

test("a known active-scope edit requests controlled pause without rewriting the admitted contract", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.issue.body += "\nA newly requested behavior.";
    fixture.issue.updated_at = "2026-10-02T12:00:00Z";
    fixture.save(); await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toMatchObject({ id: run.id, condition: "needs_you", issue_pause: { reason: "scope_changed", source_id: start.issue_scope.source_id } });
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.runs[0].worktree).toBe(run.worktree);
    expect(detail.questions.some((question: any) => question.run_id === run.id && question.answer === null)).toBe(true);
    const worker = await fixture.post(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "paused-worker" });
    expect(worker.status).toBe(409); expect((await worker.json()).error.code).toBe("issue_pause_required");
    fixture.restart();
    expect((await fixture.json(path)).runs[0].issue_pause.reason).toBe("scope_changed");
  } finally { fixture.close(); }
}, 20_000);

test("an inventory edit pauses admitted work before a later dependency failure", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.issue.body += "\nNew behavior observed in the inventory.";
    fixture.save([fixture.issue], false, { "1": null });
    const held = fixture.holdSync("/dependencies/blocked_by"); release = held.release;
    const pending = fixture.post(route + "/sync", {});
    await held.waiting;
    try {
      const detail = await fixture.json(path);
      expect(detail.runs[0].condition).toBe("needs_you");
      expect(detail.runs[0].issue_pause?.reason).toBe("scope_changed");
      expect(detail.runs[0].manifest).toEqual(run.manifest);
    } finally { release(); await pending; }
    expect((await pending).status).toBe(409);
    fixture.restart();
    expect((await fixture.json(path)).runs[0].issue_pause.reason).toBe("scope_changed");
  } finally { release(); fixture.close(); }
}, 20_000);

test("observed native dependency changes pause frozen work before a PR outage", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const dependency = { ...fixture.issue, number: 2, node_id: "new-prerequisite", html_url: "https://github.com/fictional/project/issues/2" };
    fixture.save([fixture.issue], false, { "1": [dependency] }, false, [fixture.issue], undefined, { pulls_fail: true });
    const held = fixture.holdSync("graphql"); release = held.release;
    const pending = fixture.post(route + "/sync", {});
    await held.waiting;
    try {
      const detail = await fixture.json(path);
      expect(detail.runs[0].issue_pause?.reason).toBe("scope_changed");
      expect(detail.runs[0].manifest).toEqual(run.manifest);
      expect(detail.github_sources[0].current.native_dependencies).toEqual([]);
    } finally { release(); await pending; }
    expect((await pending).status).toBe(409);
    expect((await fixture.json(path)).github_sync.problem).toContain("PR inventory");
  } finally { release(); fixture.close(); }
}, 20_000);

test("a validated added dependency pauses frozen work before the next dependency page fails", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const dependencies = Array.from({ length: 30 }, (_, index) => ({ ...fixture.issue, number: index + 2, node_id: `prerequisite-${index}`, html_url: `https://github.com/fictional/project/issues/${index + 2}` }));
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], undefined, { dependency_pages: { "1": [dependencies, null] } });
    const held = fixture.holdSync("/dependencies/blocked_by?per_page=30&page=2"); release = held.release;
    const pending = fixture.post(route + "/sync", {});
    await held.waiting;
    try {
      const detail = await fixture.json(path);
      expect(detail.runs[0].issue_pause?.reason).toBe("scope_changed");
      expect(detail.runs[0].manifest).toEqual(run.manifest);
    } finally { release(); await pending; }
    expect((await pending).status).toBe(409);
  } finally { release(); fixture.close(); }
}, 20_000);

test.each([
  ["title", "dependency", "scope_changed"],
  ["body", "pulls", "scope_changed"],
  ["closure", "dependency", "issue_closed"],
  ["readiness", "pulls", "readiness_revoked"],
  ["blocked", "dependency", "readiness_revoked"],
])("inventory %s drift survives a later %s failure", async (change, failure, reason) => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    if (change === "title") fixture.issue.title = "New title";
    if (change === "body") fixture.issue.body += "\nNew scope.";
    if (change === "closure") fixture.issue.state = "closed";
    if (change === "readiness") fixture.issue.labels = [];
    if (change === "blocked") fixture.issue.labels.push({ name: "blocked" });
    fixture.save([fixture.issue], false, failure === "dependency" ? { "1": null } : {}, false, [fixture.issue], undefined, { pulls_fail: failure === "pulls" });
    expect((await fixture.post(route + "/sync", {})).status).toBe(409);
    const detail = await fixture.json(path);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause?.reason).toBe(reason);
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.github_sources[0].current.revision).toBe(start.issue_scope.source_revision);
    expect(detail.github_sync.problem).toBeString();
    expect(detail.implementation.outcome).toBe("none");
  } finally { fixture.close(); }
}, 20_000);

test.each(["body", "closure", "readiness"])("positive %s drift on an issue page survives a later page failure", async change => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "owned-partial-inventory-worker" });
    expect(worker.condition).toBe("disconnected");
    const siblings = Array.from({ length: 29 }, (_, index) => ({ ...fixture.issue, number: index + 2, node_id: `sibling-${index}`, html_url: `https://github.com/fictional/project/issues/${index + 2}` }));
    if (change === "body") fixture.issue.body += "\nEdited on the first page.";
    if (change === "closure") fixture.issue.state = "closed";
    if (change === "readiness") fixture.issue.labels = [];
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], undefined, { issue_pages: [[fixture.issue, ...siblings], null] });
    const held = fixture.holdSync("/issues?state=all&per_page=30&page=2"); release = held.release;
    const pending = fixture.post(route + "/sync", {});
    await held.waiting;
    const reason = change === "closure" ? "issue_closed" : change === "readiness" ? "readiness_revoked" : "scope_changed";
    try {
      const detail = await fixture.json(path);
      expect(detail.runs[0].issue_pause?.reason).toBe(reason);
      expect(detail.runs[0].manifest).toEqual(run.manifest);
      expect(detail.workers).toEqual([worker]);
    } finally { release(); await pending; }
    expect((await pending).status).toBe(409);
    await fixture.post(route + "/sync", {});
    fixture.restart();
    const detail = await fixture.json(path);
    expect(detail.runs[0].issue_pause?.reason).toBe(reason);
    expect(detail.runs[0].worktree).toBe(run.worktree);
    expect(detail.workers).toEqual([worker]);
    expect(detail.questions.filter((question: any) => question.run_id === run.id && question.answer === null)).toHaveLength(1);
    expect(detail.github_sources[0].current.revision).toBe(start.issue_scope.source_revision);
  } finally { release(); fixture.close(); }
}, 20_000);

test.each(["missing", "malformed", "dependency", "pulls", "unrelated_label"])("%s inventory evidence alone leaves frozen work running", async failure => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const siblings = Array.from({ length: 30 }, (_, index) => ({ ...fixture.issue, number: index + 2, node_id: `sibling-${index}`, html_url: `https://github.com/fictional/project/issues/${index + 2}` }));
    const malformed = { ...fixture.issue, body: "Unvalidated changed scope", updated_at: "not-a-timestamp" };
    if (failure === "unrelated_label") fixture.issue.labels.push({ name: "documentation" });
    fixture.save([fixture.issue], false, failure === "dependency" || failure === "unrelated_label" ? { "1": null } : {}, false, [fixture.issue], undefined, { issue_pages: failure === "missing" ? [siblings, null] : failure === "malformed" ? [[malformed]] : undefined, pulls_fail: failure === "pulls" });
    expect((await fixture.post(route + "/sync", {})).status).toBe(409);
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.questions).toEqual([]);
    expect(detail.github_sources[0].current.revision).toBe(start.issue_scope.source_revision);
  } finally { fixture.close(); }
}, 20_000);

test("a malformed dependency alone cannot pause frozen work", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, { "1": [{ ...fixture.issue, number: 2, node_id: "unvalidated-prerequisite", html_url: "https://github.com/fictional/project/issues/2", updated_at: "invalid" }] });
    const response = await fixture.post(route + "/sync", {});
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("github_dependencies_incomplete");
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("an edit detected during readiness collection pauses frozen work before another sync", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, {}, false, [{ ...fixture.issue, body: fixture.issue.body + "\nNew behavior." }]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0]).toMatchObject({ id: run.id, condition: "needs_you", issue_pause: { reason: "scope_changed" } });
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.questions.filter((question: any) => question.run_id === run.id && question.answer === null)).toHaveLength(1);
    fixture.restart();
    expect((await fixture.json(path)).runs[0].issue_pause.reason).toBe("scope_changed");
  } finally { fixture.close(); }
}, 20_000);

test("closure detected during readiness collection pauses the admitted Run", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, {}, false, [{ ...fixture.issue, state: "closed" }]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause.reason).toBe("issue_closed");
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.implementation.outcome).toBe("none");
  } finally { fixture.close(); }
}, 20_000);

test("readiness removal detected during collection pauses frozen work despite incomplete evidence", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, {}, false, [{ ...fixture.issue, labels: [] }]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause.reason).toBe("readiness_revoked");
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    await fixture.json(route + "/sync", {});
    expect((await fixture.json(path)).questions).toHaveLength(detail.questions.length);
  } finally { fixture.close(); }
}, 20_000);

test("native dependency drift detected during readiness collection pauses frozen work", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const dependency = { ...fixture.issue, number: 2, node_id: "new-dependency", html_url: "https://github.com/fictional/project/issues/2" };
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { dependencies: { "1": [dependency] } });
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause.reason).toBe("scope_changed");
    expect(detail.runs[0].manifest).toEqual(run.manifest);
  } finally { fixture.close(); }
}, 20_000);

test.each(["body", "title", "closure"])("%s drift proven by GraphQL during readiness collection pauses frozen work", async change => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, {}, false, [fixture.issue], { proof: { id: fixture.issue.node_id, title: change === "title" ? "Renamed after REST" : fixture.issue.title, body: fixture.issue.body + (change === "body" ? "\nEdited after REST." : ""), state: change === "closure" ? "CLOSED" : "OPEN", createdAt: "2026-09-30T12:00:00Z", updatedAt: "2026-10-02T12:00:00Z", lastEditedAt: "2026-10-02T12:00:00Z" } });
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause.reason).toBe(change === "closure" ? "issue_closed" : "scope_changed");
    expect(detail.runs[0].manifest).toEqual(run.manifest);
  } finally { fixture.close(); }
}, 20_000);

test("a malformed fresh issue response leaves admitted frozen work running", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], false, {}, false, [{ ...fixture.issue, body: "Malformed response with a different body", updated_at: "not-a-timestamp" }]);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test.each(["native", "graphql", "unavailable", "timestamp"])("incomplete %s readiness evidence alone preserves admitted frozen work", async failure => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const fresh = { ...fixture.issue, ...(failure === "timestamp" ? { updated_at: "2026-10-02T12:00:00Z" } : {}) };
    const invalidProof = { id: fixture.issue.node_id, title: fixture.issue.title, body: "Different body in malformed evidence", state: "OPEN", createdAt: "invalid", updatedAt: fixture.issue.updated_at, lastEditedAt: null };
    fixture.save([fixture.issue], false, {}, false, [fresh], failure === "native" ? { dependencies: { "1": null } } : failure === "graphql" ? { proof: invalidProof } : failure === "unavailable" ? { proof: null } : undefined);
    await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.github_sources[0].readiness_evidence.complete).toBe(false);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.questions).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test.each(["scope", "closure", "readiness", "outage", "pause", "policy"])("Start revalidates %s changed during native observation before admitting work", async change => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start, route, readiness } = await prepared(fixture);
    const held = fixture.holdCapabilities(); release = held.release;
    const pending = fixture.post(path + "/runs", start);
    await Promise.race([held.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Native fixture did not reach admission gate")), 5000))]);
    if (change === "pause") await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
    else if (change === "policy") await fixture.json(route + "/readiness", { expected_revision: readiness.revision, account_profile_id: readiness.account_profile_id, triage_labels: {}, blocked_label: "on-hold" });
    else {
      if (change === "scope") fixture.issue.body += "\nChanged testing requirement.";
      if (change === "closure") fixture.issue.state = "closed";
      if (change === "readiness") fixture.issue.labels = [];
      fixture.save([fixture.issue], change === "outage");
      const sync = await fixture.post(route + "/sync", {});
      expect(sync.status).toBe(change === "outage" ? 409 : 200);
    }
    release();
    expect((await pending).status).toBe(409);
    expect((await fixture.json(path)).runs).toEqual([]);
  } finally { release(); fixture.close(); }
}, 20_000);

test("outage retains visible evidence and admitted frozen work while blocking a fresh Start", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later issue" }]);
    const { path, start, route, readiness } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    const run = await fixture.json(path + "/runs", start);
    fixture.save([fixture.issue], true);
    expect((await fixture.post(route + "/sync", {})).status).toBe(409);
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toEqual(run);
    expect(detail.github_sync.problem).toBeString();
    expect(detail.github_sources[0].current.revision).toBe(start.issue_scope.source_revision);
    expect((await fixture.post(second.path + "/runs", second.start)).status).toBe(409);
    expect((await fixture.json(path + "/runs", start)).id).toBe(run.id);
  } finally { fixture.close(); }
}, 20_000);

test("concurrent and overlapping Start requests retain one admitted attempt", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start } = await prepared(fixture);
    const held = fixture.holdCapabilities(); release = held.release;
    const first = fixture.post(path + "/runs", start);
    await Promise.race([held.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Native fixture did not reach admission gate")), 5000))]);
    const replay = fixture.post(path + "/runs", start);
    const other = fixture.post(path + "/runs", { ...start, idempotency_key: "overlapping-request" });
    release();
    const responses = await Promise.all([first, replay, other]);
    expect(responses.map(response => response.status)).toEqual([202, 202, 409]);
    expect((await responses[0]!.json()).id).toBe((await responses[1]!.json()).id);
    expect((await fixture.json(path)).runs).toHaveLength(1);
  } finally { release(); fixture.close(); }
}, 20_000);

test("scope pause retains unreachable worker ownership and owner answers cannot resume frozen work", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, route, start } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    const worker = await fixture.json(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: run.manifest.tickets[0].id, idempotency_key: "unreachable-native-worker" });
    expect(worker.condition).toBe("disconnected");
    fixture.issue.body += "\nChanged scope."; fixture.save(); await fixture.json(route + "/sync", {});
    let detail = await fixture.json(path);
    expect(detail.workers[0]).toEqual(worker);
    for (const question of detail.questions.filter((question: any) => question.answer === null)) await fixture.json(path + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Preserve the work for a separately authorized attempt." });
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    detail = await fixture.json(path);
    expect(detail.runs[0].condition).toBe("needs_you");
    expect(detail.runs[0].issue_pause.reason).toBe("scope_changed");
    const send = await fixture.post(`/runs/${run.id}/send-answers`, { revision: detail.question_revision, idempotency_key: "do-not-resume" });
    expect(send.status).toBe(409); expect((await send.json()).error.code).toBe("issue_pause_required");
    expect((await fixture.json(path)).workers[0]).toEqual(worker);
  } finally { fixture.close(); }
}, 20_000);

test("an unfinished GitHub inventory cannot authorize admission from the previous snapshot", async () => {
  const fixture = githubQueueFixture(true); let release = () => {}; let sync: Promise<Response> | undefined;
  try {
    const { path, route, start } = await prepared(fixture);
    const held = fixture.holdSync(); release = held.release;
    sync = fixture.post(route + "/sync", {}); await held.waiting;
    const response = await fixture.post(path + "/runs", start);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("github_busy");
    expect((await fixture.json(path)).runs).toEqual([]);
  } finally { release(); await sync; fixture.close(); }
}, 20_000);

test.each(["readiness", "closure"])("known active %s changes request a durable owner decision", async change => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, route, start } = await prepared(fixture);
    const run = await fixture.json(path + "/runs", start);
    if (change === "closure") fixture.issue.state = "closed"; else fixture.issue.labels = [];
    fixture.save(); await fixture.json(route + "/sync", {});
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toMatchObject({ condition: "needs_you", issue_pause: { reason: change === "closure" ? "issue_closed" : "readiness_revoked" } });
    expect(detail.runs[0].manifest).toEqual(run.manifest);
    expect(detail.implementation.outcome).toBe("none");
    await fixture.json(route + "/sync", {});
    expect((await fixture.json(path)).questions).toHaveLength(detail.questions.length);
  } finally { fixture.close(); }
}, 20_000);

test("global agent capacity remains effective even when the Project allows another implementation", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later issue" }]);
    const { path, route, readiness, start } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: false, max_implementations: 2 });
    await fixture.json("/settings", { max_agents: 1 });
    expect((await fixture.post(path + "/runs", start)).status).toBe(202);
    const response = await fixture.post(second.path + "/runs", second.start);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("capacity_exhausted");
    expect((await fixture.json(second.path)).runs).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);


test("failed issue work waits through sync and restart for explicit owner Retry", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    fixture.setLaunchOutcome("failed");
    const failed = await fixture.json(path + "/runs", start);
    expect(failed.condition).toBe("failed");
    await fixture.json(route + "/sync", {}); fixture.restart();
    const replay = await fixture.json(path + "/runs", start);
    expect(replay.id).toBe(failed.id);
    expect(fixture.launches).toEqual([failed.id]);
    const retry = { idempotency_key: "owner-retry", issue_scope: start.issue_scope };
    fixture.setLaunchOutcome("working");
    const response = await fixture.post(`/runs/${failed.id}/retry`, retry);
    expect(response.status).toBe(202);
    const next = await response.json();
    expect(next).toMatchObject({ condition: "working", retry_of: failed.id });
    expect(next.id).not.toBe(failed.id);
    expect((await fixture.json(path)).runs).toEqual([failed, next]);
    expect(fixture.launches).toEqual([failed.id, next.id]);
  } finally { fixture.close(); }
}, 20_000);

test("restart recovers a lost launch response by observing the admitted identity without replay", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    fixture.setLaunchOutcome("lost");
    const uncertain = await fixture.json(path + "/runs", start);
    expect(uncertain.condition).toBe("disconnected");
    fixture.restart();
    const detail = await fixture.json(path);
    expect(detail.runs[0]).toMatchObject({ id: uncertain.id, condition: "working" });
    expect(detail.runs[0].manifest).toEqual(uncertain.manifest);
    await fixture.json(route + "/sync", {});
    expect((await fixture.json(path + "/runs", start)).id).toBe(uncertain.id);
    expect(fixture.launches).toEqual([uncertain.id]);
    const retry = await fixture.post(`/runs/${uncertain.id}/retry`, { idempotency_key: "do-not-replay", issue_scope: start.issue_scope });
    expect(retry.status).toBe(409);
    expect((await fixture.json(path)).runs).toHaveLength(1);
  } finally { fixture.close(); }
}, 20_000);

test("a new Start key cannot silently retry failed issue work", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start } = await prepared(fixture);
    fixture.setLaunchOutcome("failed");
    const failed = await fixture.json(path + "/runs", start);
    for (const body of [{ ...start, idempotency_key: "renewed-eligibility" }, { action: "implement-spec", idempotency_key: "generic-start" }]) {
      const response = await fixture.post(path + "/runs", body);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("retry_required");
    }
    expect(fixture.launches).toEqual([failed.id]);
  } finally { fixture.close(); }
}, 20_000);


test("restart during native launch retains the accepted intent and recovers the same Run", async () => {
  const fixture = githubQueueFixture(true); let release = () => {}; let pending: Promise<Response> | undefined;
  try {
    const { path, start } = await prepared(fixture);
    const held = fixture.holdLaunch(); release = held.release;
    pending = fixture.post(path + "/runs", start).catch(() => new Response(null, { status: 503 }));
    await Promise.race([held.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Launch fixture never accepted the Run")), 5000))]);
    const accepted = (await fixture.json(path)).runs[0];
    expect(accepted.condition).toBe("accepted");
    fixture.restart();
    const recovered = (await fixture.tracker(accepted.id)).run;
    expect(recovered.id).toBe(accepted.id);
    expect(recovered.condition).toBe("working");
    expect(recovered.manifest).toEqual(accepted.manifest);
    release(); await pending;
    expect((await fixture.json(path + "/runs", start)).id).toBe(accepted.id);
    expect(fixture.launches).toEqual([accepted.id]);
  } finally { release(); await pending; fixture.close(); }
}, 20_000);

test("concurrent owner retries and a lost Retry response create one successor with retained history", async () => {
  const fixture = githubQueueFixture(true); let release = () => {};
  try {
    const { path, start } = await prepared(fixture);
    fixture.setLaunchOutcome("failed"); const failed = await fixture.json(path + "/runs", start);
    fixture.setLaunchOutcome("lost");
    const held = fixture.holdCapabilities(); release = held.release;
    const retry = { idempotency_key: "same-retry", issue_scope: start.issue_scope };
    const first = fixture.post(`/runs/${failed.id}/retry`, retry);
    await Promise.race([held.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Retry fixture never reached its gate")), 5000))]);
    const same = fixture.post(`/runs/${failed.id}/retry`, retry);
    const other = fixture.post(`/runs/${failed.id}/retry`, { ...retry, idempotency_key: "overlapping-retry" });
    release();
    const results = await Promise.all([first, same, other]);
    expect(results.map(result => result.status)).toEqual([202, 202, 409]);
    const next = await results[0]!.json();
    expect((await results[1]!.json()).id).toBe(next.id);
    fixture.restart();
    expect((await fixture.json(`/runs/${failed.id}/retry`, retry)).id).toBe(next.id);
    expect((await fixture.json(path)).runs.map((run: any) => [run.id, run.condition, run.retry_of ?? null])).toEqual([[failed.id, "failed", null], [next.id, "working", failed.id]]);
    expect(fixture.launches).toEqual([failed.id, next.id]);
  } finally { release(); fixture.close(); }
}, 20_000);

test("unreachable execution after restart retains Project capacity until its original identity is observed", async () => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Next issue" }]);
    const { path, start, route, readiness } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    fixture.setLaunchOutcome("lost"); const uncertain = await fixture.json(path + "/runs", start);
    fixture.setHostOffline(true); fixture.restart();
    expect((await fixture.json(path)).runs[0].condition).toBe("disconnected");
    const refused = await fixture.post(second.path + "/runs", second.start);
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("project_capacity_exhausted");
    expect(fixture.launches).toEqual([uncertain.id]);
    fixture.setHostOffline(false);
    expect((await fixture.json(`/runs/${uncertain.id}/reconcile`, {})).id).toBe(uncertain.id);
    expect((await fixture.json(path)).runs[0].condition).toBe("working");
  } finally { fixture.close(); }
}, 20_000);


test("Retry cannot replace a failed parent while an uncertain build still owns the Assignment", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { path, start, route } = await prepared(fixture);
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: false, max_implementations: 2 });
    const run = await fixture.json(path + "/runs", start);
    const check = await fixture.json(`/runs/${run.id}/checks`, {});
    expect(check.condition).toBe("interrupted");
    fixture.failNativeRun(run.id); await fixture.json(`/runs/${run.id}/reconcile`, {});
    fixture.restart();
    const response = await fixture.post(`/runs/${run.id}/retry`, { idempotency_key: "owned-build-retry", issue_scope: start.issue_scope });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("implementation_owned");
    const detail = await fixture.json(path);
    expect(detail.checks).toEqual([check]);
    expect(detail.runs).toHaveLength(1);
    expect(fixture.launches).toEqual([run.id]);
  } finally { fixture.close(); }
}, 20_000);

test.each(["pause", "priority", "scope", "outage", "readiness"])("Retry revalidates current %s instead of reusing failed authorization", async change => {
  const fixture = githubQueueFixture(true);
  try {
    fixture.save([fixture.issue, { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Next issue" }]);
    const { path, start, route, readiness } = await prepared(fixture);
    const second = await prepareSecond(fixture, route, readiness);
    fixture.setLaunchOutcome("failed"); const failed = await fixture.json(path + "/runs", start);
    if (change === "pause") await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 1 });
    if (change === "priority") await fixture.json(second.path + "/order", { before_id: failed.implementation_id });
    if (change === "scope") fixture.issue.body += "\nA different behavior.";
    if (change === "readiness") fixture.issue.labels = [];
    if (["scope", "readiness", "outage"].includes(change)) {
      fixture.save([fixture.issue], change === "outage"); await fixture.post(route + "/sync", {});
    }
    const response = await fixture.post(`/runs/${failed.id}/retry`, { idempotency_key: "stale-retry", issue_scope: start.issue_scope });
    expect(response.status).toBe(409);
    expect((await fixture.json(path)).runs).toEqual([failed]);
    expect(fixture.launches).toEqual([failed.id]);
  } finally { fixture.close(); }
}, 20_000);


test("completed planning Runs allow approved issue preparation and one guarded implementation attempt", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const planning = await fixture.json(path + "/runs", { action: "to-spec", idempotency_key: "owned-manual-planning" });
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    expect((await fixture.json(route + "/preview", {})).entries[0].reasons).toContainEqual({ code: "attempt_exists", detail: "" });
    fixture.setExecutionHandler(async request => new URL(request.url).pathname.endsWith(`/runs/${planning.id}/reconcile`) ? Response.json({ ...planning, condition: "completed" }) : null);
    await fixture.json(`/runs/${planning.id}/reconcile`, {});
    const specification = await fixture.json(path + "/specifications", { content: fixture.issue.body });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Public HTTP and real browser journeys." });
    const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "greeting", title: "Greeting", acceptance: "Show hello.", dependencies: [] }] });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Approved bounded greeting" });
    const preview = await fixture.json(route + "/preview", {});
    expect(preview).toMatchObject({ eligible_count: 1, entries: [expect.objectContaining({ eligible: true, reasons: [] })] });
    const prepared = (await fixture.json(route)).sources[0].planning;
    expect(prepared).toMatchObject({ condition: "prepared", origin: "app_plan", specification_id: specification.id, graph_hash: graph.hash });
    const start = { action: "implement-spec", idempotency_key: "after-manual-planning", issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: graph.hash } };
    expect((await fixture.post(path + "/runs", start)).status).toBe(202);
    expect((await fixture.post(path + "/runs", { ...start, idempotency_key: "no-duplicate-after-planning" })).status).toBe(409);
    expect((await fixture.json(path)).runs.map((run: any) => run.action)).toEqual(["to-spec", "implement-spec"]);
  } finally { fixture.close(); }
}, 20_000);
