import { expect, test } from "bun:test";
import { githubQueueFixture } from "../scripts/fixtures/github-queue.ts";

async function synced(fixture: ReturnType<typeof githubQueueFixture>) {
  fixture.save(undefined, false, {}, true);
  const setup = await fixture.setup();
  await fixture.json(setup.route + "/configure", { ...setup.configuration, expected_revision: (await fixture.json(setup.route)).policy.revision, sync_enabled: true });
  await fixture.renewLabels(setup.route);
  await fixture.json(setup.route + "/sync", {});
  return setup;
}

test("automatic opt-in requires the selected identity and exact current backlog preview", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route } = await synced(fixture);
    const config = { expected_revision: null, automatic_implementation: true, paused: true };
    const missing = await fixture.post(route + "/queue", config);
    expect(missing.status).toBe(409);
    expect((await missing.json()).error.code).toBe("queue_preview_required");
    const preview = await fixture.json(route + "/preview", {});
    expect(preview.eligible_count).toBe(1);
    const enabled = await fixture.json(route + "/queue", { ...config, preview_revision: preview.revision });
    expect(enabled.policy.automatic_implementation).toBe(true);
    expect(enabled.entries[0].lane).toBe("queued");
    expect(fixture.launches).toEqual([]);
    fixture.restart();
    expect((await fixture.json(route + "/queue")).policy).toEqual(enabled.policy);
  } finally { fixture.close(); }
}, 20_000);

async function enable(fixture: ReturnType<typeof githubQueueFixture>, route: string, paused = false) {
  const preview = await fixture.json(route + "/preview", {});
  return fixture.json(route + "/queue", { expected_revision: preview.policy.revision, automatic_implementation: true, preview_revision: preview.revision, paused });
}

test("remote automation without an owner-configured callback fails before reserving or launching a Run", async () => {
  const fixture = githubQueueFixture(true, null);
  try {
    const { route } = await synced(fixture);
    const preview = await fixture.json(route + "/preview", {});
    const response = await fixture.post(route + "/queue", { expected_revision: null, automatic_implementation: true, preview_revision: preview.revision, paused: false }, { ...fixture.headers, "x-forwarded-host": "untrusted.example", "x-forwarded-proto": "https" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dispatch_problem: { code: "factory_public_url_required" }, implementing_count: 0 });
    expect(fixture.launches).toEqual([]);
    const source = (await fixture.json(route)).sources[0];
    expect((await fixture.json(`/implementations/${source.implementation_id}`)).runs).toEqual([]);
    fixture.restart(); await fixture.json(route + "/sync", {});
    expect((await fixture.json(route + "/queue")).dispatch_problem.code).toBe("factory_public_url_required");
    expect(fixture.launches).toEqual([]);
  } finally { fixture.close(); }
}, 15_000);

test("remote callback setup recovers automation after restart without changing the opt-in or duplicating work", async () => {
  const fixture = githubQueueFixture(true, null);
  try {
    const { route } = await synced(fixture);
    await enable(fixture, route);
    const policy = (await fixture.json(route + "/queue")).policy;
    expect(fixture.launches).toEqual([]);
    fixture.restart(undefined, "https://owner.fixture.invalid");
    await fixture.json(route + "/sync", {});
    const source = (await fixture.json(route)).sources[0];
    const path = `/implementations/${source.implementation_id}`;
    const run = (await fixture.json(path)).runs[0];
    expect(run.condition).toBe("working");
    expect(fixture.trackerUrl(run.id)).toBe(`https://owner.fixture.invalid/api/factory-agent/${run.id}`);
    expect((await fixture.json(route + "/queue")).policy).toEqual(policy);
    fixture.restart(); await fixture.json(route + "/sync", {});
    expect((await fixture.json(path)).runs).toHaveLength(1);
    expect(fixture.launches).toEqual([run.id]);
    expect((await fixture.json(route + "/queue")).dispatch_problem).toBeNull();
  } finally { fixture.close(); }
}, 15_000);

test("configuring a remote callback does not enable automatic implementation", async () => {
  const fixture = githubQueueFixture(true, null);
  try {
    const { route } = await synced(fixture);
    fixture.restart(undefined, "https://owner.fixture.invalid");
    await fixture.json(route + "/sync", {});
    expect((await fixture.json(route + "/queue")).policy.automatic_implementation).toBe(false);
    expect(fixture.launches).toEqual([]);
    const source = (await fixture.json(route)).sources[0];
    expect((await fixture.json(`/implementations/${source.implementation_id}`)).runs).toEqual([]);
  } finally { fixture.close(); }
}, 15_000);

test.each(["http://localhost:7317", "http://127.2.3.4:7317", "http://[::1]:7317", "http://[::ffff:127.0.0.1]", "http://0.0.0.0:7317", "http://[::]:7317", "https://owner.localhost.", "not-a-url", "file:///tmp/owner", "https://user:secret@owner.fixture.invalid"])("remote automation rejects unusable configured callback %s before admission", async publicUrl => {
  const fixture = githubQueueFixture(true, publicUrl);
  try {
    const { route } = await synced(fixture);
    expect(await enable(fixture, route)).toMatchObject({ dispatch_problem: { code: "factory_public_url_required" }, implementing_count: 0 });
    expect(fixture.launches).toEqual([]);
    const source = (await fixture.json(route)).sources[0];
    expect((await fixture.json(`/implementations/${source.implementation_id}`)).runs).toEqual([]);
  } finally { fixture.close(); }
}, 15_000);

test("explicit remote Start retains the owner request origin when no public callback is configured", async () => {
  const fixture = githubQueueFixture(true, null);
  try {
    const { route, readiness } = await fixture.setup();
    const source = (await fixture.json(route + "/sync", {})).sources[0];
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
    await fixture.json(route + "/sync", {});
    const path = `/implementations/${source.implementation_id}`;
    const detail = await fixture.json(path);
    const run = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "explicit-remote-origin", issue_scope: { source_id: source.id, source_revision: source.revision, graph_hash: detail.graph_hash } });
    expect(run.condition).toBe("working");
    expect(fixture.trackerUrl(run.id)).toBe(`${fixture.origin}/api/factory-agent/${run.id}`);
    expect((await fixture.json(route + "/queue")).policy.automatic_implementation).toBe(false);
  } finally { fixture.close(); }
}, 15_000);

test("reviewed backlog and future trusted plans dispatch once through the existing sync path", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route } = await synced(fixture);
    await enable(fixture, route, false);
    const first = (await fixture.json(route)).sources[0];
    const run = (await fixture.json(`/implementations/${first.implementation_id}`)).runs[0];
    expect(run).toMatchObject({ condition: "working", action: "implement-spec", manifest: { issue_admission: { queue_policy: { automatic_implementation: true }, source: { revision: first.revision } } } });
    const later = { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Future trusted scope" };
    fixture.save([fixture.issue, later], false, {}, true); await fixture.renewLabels(route, [2]);
    await fixture.json(route + "/sync", {});
    const view = await fixture.json(route);
    const second = view.sources.find((source: any) => source.number === 2);
    expect(second.planning.condition).toBe("prepared");
    const next = (await fixture.json(`/implementations/${second.implementation_id}`)).runs[0];
    expect(next.condition).toBe("working");
    await fixture.json(route + "/sync", {}); fixture.restart(); await fixture.json(route + "/sync", {});
    expect((await fixture.json(route)).sources).toHaveLength(2);
    expect((await fixture.json(`/implementations/${first.implementation_id}`)).runs).toHaveLength(1);
    expect((await fixture.json(`/implementations/${second.implementation_id}`)).runs).toHaveLength(1);
    expect(fixture.launches).toEqual([run.id, next.id]);
  } finally { fixture.close(); }
}, 20_000);

test("the first preview prepares trusted sufficient scope while missing decisions remain Needs you", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, configuration } = await fixture.setup();
    await fixture.json(route + "/configure", { ...configuration, expected_revision: (await fixture.json(route)).policy.revision, sync_enabled: true });
    const incomplete = { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Missing decisions", body: "## Scope\nA greeting.\n## Acceptance criteria\nHello.\n## Dependencies\nNone." };
    fixture.save([fixture.issue, incomplete], false, {}, true); await fixture.renewLabels(route);
    const preview = await fixture.json(route + "/preview", {});
    expect(preview.eligible_count).toBe(1);
    expect(preview.entries.find((entry: any) => entry.number === 2).lane).toBe("needs_you");
    const source = (await fixture.json(route)).sources.find((source: any) => source.number === 2);
    const detail = await fixture.json(`/implementations/${source.implementation_id}`);
    expect(detail.questions).toHaveLength(1);
    expect(detail.questions[0].answer).toBeNull();
    await fixture.json(route + "/preview", {});
    expect((await fixture.json(`/implementations/${source.implementation_id}`)).questions).toHaveLength(1);
    expect(fixture.launches).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("a preview made before a scope edit cannot enable automatic implementation", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route } = await synced(fixture);
    const preview = await fixture.json(route + "/preview", {});
    fixture.issue.body += "\nA different requirement.";
    fixture.save(undefined, false, {}, true); await fixture.json(route + "/sync", {});
    const response = await fixture.post(route + "/queue", { expected_revision: null, automatic_implementation: true, preview_revision: preview.revision, paused: false });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("queue_preview_required");
    expect((await fixture.json(route + "/queue")).policy.automatic_implementation).toBe(false);
    expect(fixture.launches).toEqual([]);
  } finally { fixture.close(); }
}, 20_000);

test("automatic dispatch reports pre-admission setup failures without inventing an attempt", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route, project } = await synced(fixture);
    await fixture.json(`/projects/${project.id}/configure`, { checks: [] });
    const queue = await enable(fixture, route);
    expect(queue.dispatch_problem).toMatchObject({ code: "project_setup_required" });
    expect(fixture.launches).toEqual([]);
    const source = (await fixture.json(route)).sources[0];
    expect((await fixture.json(`/implementations/${source.implementation_id}`)).runs).toEqual([]);
    fixture.restart();
    expect((await fixture.json(route + "/queue")).dispatch_problem.code).toBe("project_setup_required");
  } finally { fixture.close(); }
}, 20_000);

test.each(["disable", "pause", "scope", "outage", "priority", "readiness", "dependencies"])("automatic admission rechecks %s while native observation is pending", async change => {
  const fixture = githubQueueFixture(true); let release = () => {}; let pending: Promise<Response> | undefined;
  try {
    const { route, readiness } = await synced(fixture);
    const later = { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later trusted scope", html_url: "https://github.com/fictional/project/issues/2" };
    fixture.save([fixture.issue, later], false, {}, true); await fixture.renewLabels(route, [2]);
    const preview = await fixture.json(route + "/preview", {});
    const gate = fixture.holdCapabilities(); release = gate.release;
    pending = fixture.post(route + "/queue", { expected_revision: null, automatic_implementation: true, preview_revision: preview.revision, paused: false });
    await Promise.race([gate.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Automatic admission did not reach native observation")), 5000))]);
    if (change === "disable" || change === "pause") {
      const queue = await fixture.json(route + "/queue");
      await fixture.json(route + "/queue", { expected_revision: queue.policy.revision, automatic_implementation: change !== "disable", paused: change === "pause" });
    } else if (change === "priority") {
      const entries = (await fixture.json(route + "/queue")).entries;
      const rejected = await fixture.post(`/implementations/${entries[1].implementation_id}/order`, { before_id: entries[0].implementation_id });
      expect(rejected.status).toBe(409);
    } else if (change === "readiness") {
      await fixture.json(route + "/readiness", { expected_revision: readiness.revision, account_profile_id: readiness.account_profile_id, triage_labels: {}, blocked_label: "on-hold" });
    } else {
      if (change === "scope") fixture.issue.body += "\nA different requirement.";
      fixture.save([fixture.issue, later], change === "outage", change === "dependencies" ? { 1: [later] } : {}, true);
      const sync = await fixture.post(route + "/sync", {});
      expect(sync.status).toBe(change === "outage" ? 409 : 200);
    }
    release(); expect((await pending).status).toBe(200);
    const sources = (await fixture.json(route)).sources;
    if (change === "priority") {
      const ordered = [...sources].sort((a: any, b: any) => a.number - b.number);
      const runs = await Promise.all(ordered.map((source: any) => fixture.json(`/implementations/${source.implementation_id}`).then(detail => detail.runs[0])));
      expect(runs.map(run => run.condition)).toEqual(["working", "working"]);
      expect(fixture.launches).toEqual(runs.map(run => run.id));
    } else {
      expect(fixture.launches).toEqual([]);
      for (const source of sources) expect((await fixture.json(`/implementations/${source.implementation_id}`)).runs).toEqual([]);
    }
  } finally { release(); await pending?.catch(() => {}); fixture.close(); }
}, 20_000);

test("failed automatic attempts await explicit Retry and uncertain attempts retain capacity across restarts", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route } = await synced(fixture);
    fixture.setLaunchOutcome("failed"); await enable(fixture, route);
    const source = (await fixture.json(route)).sources[0]; const path = `/implementations/${source.implementation_id}`;
    const failed = (await fixture.json(path)).runs[0]; expect(failed.condition).toBe("failed");
    await fixture.json(route + "/sync", {}); fixture.restart(); await fixture.json(route + "/sync", {});
    expect(fixture.launches).toEqual([failed.id]);
    fixture.setLaunchOutcome("lost");
    const scope = { source_id: source.id, source_revision: source.revision, graph_hash: source.planning.graph_hash };
    const next = await fixture.json(`/runs/${failed.id}/retry`, { idempotency_key: "explicit-automatic-retry", issue_scope: scope });
    expect(next).toMatchObject({ retry_of: failed.id, condition: "disconnected" });
    fixture.setHostOffline(true); fixture.restart();
    const later = { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Future trusted scope" };
    fixture.save([fixture.issue, later], false, {}, true); await fixture.renewLabels(route, [2]); await fixture.json(route + "/sync", {});
    expect((await fixture.json(route + "/queue")).implementing_count).toBe(1);
    expect(fixture.launches).toEqual([failed.id, next.id]);
    fixture.setLaunchOutcome("working"); fixture.setHostOffline(false); await fixture.json(`/runs/${next.id}/reconcile`, {}); await fixture.json(route + "/sync", {});
    expect((await fixture.json(path)).runs.at(-1)).toMatchObject({ id: next.id, condition: "working" });
    const independent = (await fixture.json(route)).sources.find((source: any) => source.number === 2);
    const independentRun = (await fixture.json(`/implementations/${independent.implementation_id}`)).runs[0];
    expect(independentRun.condition).toBe("working");
    expect(fixture.launches).toEqual([failed.id, next.id, independentRun.id]);
    expect((await fixture.json(path)).runs.map((run: any) => run.id)).toEqual([failed.id, next.id]);
  } finally { fixture.close(); }
}, 20_000);

test("automatic preview reuses an approved app plan and graph without a manual Prepare", async () => {
  const fixture = githubQueueFixture(true);
  try {
    const { route } = await synced(fixture);
    const source = (await fixture.json(route)).sources[0]; const path = `/implementations/${source.implementation_id}`;
    const issueScope = { source_id: source.id, source_revision: source.revision };
    const content = fixture.issue.body + "\n## Tickets\nThe approved API Ticket blocks the browser Ticket.";
    const specification = await fixture.json(path + "/specifications", { content });
    for (const kind of ["specification", "testing_seams"]) await fixture.json(path + "/approvals", { kind, revision: specification.id, scope: "Owned app-plan fixture", issue_scope: issueScope });
    const graph = await fixture.json(path + "/tickets", { specification_id: specification.id, tickets: [{ key: "api", title: "Greeting API", acceptance: "Greeting through HTTP", dependencies: [] }, { key: "browser", title: "Greeting UI", acceptance: "Greeting through browser", dependencies: ["api"] }] });
    await fixture.json(path + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Owned app graph", issue_scope: issueScope });
    const before = await fixture.json(path);
    await enable(fixture, route);
    const after = await fixture.json(path);
    expect(after.runs[0].manifest.issue_admission.planning).toMatchObject({ origin: "app_plan", content, graph_hash: graph.hash, specification_id: specification.id });
    expect(after.tickets).toEqual(before.tickets);
    expect(after.approvals).toEqual(before.approvals);
    for (const approval of after.approvals) expect(approval.issue_scope).toMatchObject(issueScope);
  } finally { fixture.close(); }
}, 20_000);

test("independent queued work starts before another Assignment retires while verified review still controls retirement", async () => {
  const { githubReviewFixture } = await import("../scripts/fixtures/github-review.ts");
  const fixture = githubReviewFixture();
  try {
    const { run, path, route, configuration } = await fixture.prepare();
    const second = { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Unrelated automatic work" };
    fixture.save([fixture.issue, second], false, {}, true); await fixture.renewLabels(route, [2]);
    await fixture.json(route + "/configure", { ...configuration, expected_revision: (await fixture.json(route)).policy.revision, sync_enabled: true });
    await enable(fixture, route);
    const source = (await fixture.json(route)).sources.find((source: any) => source.number === 2);
    const secondPath = `/implementations/${source.implementation_id}`;
    const independent = (await fixture.json(secondPath)).runs[0];
    expect(independent).toMatchObject({ condition: "working", manifest: { issue_admission: { source: { id: source.id } } } });
    expect((await fixture.json(route + "/queue")).dispatch_problem).toBeNull();
    await fixture.integrate(run); await fixture.json(`/runs/${run.id}/checks`, {});
    await fixture.review(run, "standards"); await fixture.review(run, "spec");
    await fixture.json(`/runs/${run.id}/reconcile`, {});
    const deadline = Date.now() + 14_000;
    let next;
    while (Date.now() < deadline) {
      next = (await fixture.json(path));
      if (next.implementation.activity === "awaiting_merge") break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect((await fixture.json(secondPath)).runs[0]).toMatchObject({ id: independent.id, condition: "ready", manifest: { issue_admission: { source: { id: source.id } } } });
    expect((await fixture.json(path)).implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "none" });
    expect((await fixture.json(secondPath)).runs).toHaveLength(1);
  } finally { fixture.close(); }
}, 30_000);
