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
