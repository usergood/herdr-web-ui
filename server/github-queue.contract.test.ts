import { expect, test } from "bun:test";
import { githubQueueFixture } from "../scripts/fixtures/github-queue.ts";

test("queue controls default off independently of GitHub synchronization", async () => {
  const fixture = githubQueueFixture();
  try {
    const { route, project } = await fixture.setup();
    const response = await fixture.get(route + "/queue");
    expect(response.status).toBe(200);
    const queue = await response.json();
    expect(queue).toMatchObject({ policy: { project_id: project.id, revision: null, automatic_implementation: false, paused: false, max_implementations: 1 }, global_limit: 6, eligible_count: 0, entries: [], preview: null, preview_current: false });
    fixture.restart();
    expect(await fixture.json(route + "/queue")).toMatchObject({ policy: queue.policy });
  } finally { fixture.close(); }
});

test("owner queue controls retain pause and bounded capacity without enabling implementation", async () => {
  const fixture = githubQueueFixture();
  try {
    const { route } = await fixture.setup();
    const config = { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 2 };
    for (const path of ["/queue", "/preview"]) {
      const refused = await fixture.post(route + path, config, { ...fixture.headers, "x-herdr-machine": "" });
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.code).toBe("invalid_origin");
      expect((await fixture.post(route + path, config, { ...fixture.headers, origin: "https://fictional.invalid" })).status).toBe(403);
    }
    const response = await fixture.post(route + "/queue", config);
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.policy).toMatchObject({ automatic_implementation: false, paused: true, max_implementations: 2 });
    expect(saved.policy.revision).toBeString();
    expect((await fixture.post(route + "/queue", config)).status).toBe(409);
    const proof = { ...config, expected_revision: saved.policy.revision };
    for (const max_implementations of [0, 7, 1.5]) expect((await fixture.post(route + "/queue", { ...proof, max_implementations })).status).toBe(400);
    const enable = await fixture.post(route + "/queue", { ...proof, automatic_implementation: true });
    expect(enable.status).toBe(409); expect((await enable.json()).error.code).toBe("queue_preview_required");
    fixture.restart();
    expect((await fixture.json(route + "/queue")).policy).toEqual(saved.policy);
  } finally { fixture.close(); }
});

test("backlog preview combines trusted scope, prepared planning and fresh dependencies", async () => {
  const fixture = githubQueueFixture();
  try {
    const { route, readiness } = await fixture.setup();
    const second = { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later greeting", html_url: "https://github.com/fictional/project/issues/2" };
    const blocked = { ...fixture.issue, number: 3, node_id: "fictional-3", title: "Blocked greeting", labels: [{ name: "ready-for-agent" }, { name: "blocked" }] };
    const undecided = { ...fixture.issue, number: 4, node_id: "fictional-4", title: "Missing seams", body: "## Scope\nShow hello.\n## Acceptance criteria\nHello.\n## Dependencies\nNone." };
    fixture.save([fixture.issue, second, blocked, undecided]);
    let view = await fixture.json(route + "/sync", {});
    for (const number of [1, 2, 4]) {
      const source = view.sources.find((source: any) => source.number === number);
      await fixture.json(route + `/issues/${number}/approve`, { source_revision: source.revision, policy_revision: readiness.revision });
      await fixture.json(route + `/issues/${number}/prepare`, { source_revision: source.revision });
    }
    await fixture.json(route + "/sync", {});
    const preview = await fixture.post(route + "/preview", {});
    expect(preview.status).toBe(200);
    const queue = await preview.json();
    expect(queue).toMatchObject({ eligible_count: 2, preview_current: true, preview: { revision: queue.revision, eligible_count: 2 } });
    expect(queue.entries.filter((entry: any) => entry.eligible).map((entry: any) => entry.number)).toEqual([1, 2]);
    expect(queue.entries.find((entry: any) => entry.number === 3)).toMatchObject({ eligible: false, lane: "inbox", reasons: expect.arrayContaining([expect.objectContaining({ code: "readiness_blocked" })]) });
    expect(queue.entries.find((entry: any) => entry.number === 4)).toMatchObject({ eligible: false, lane: "needs_you", reasons: expect.arrayContaining([expect.objectContaining({ code: "planning_needs_you" })]) });
    expect(queue.entries.find((entry: any) => entry.number === 1)).toMatchObject({ lane: "inbox", reasons: [] });
    for (const source of view.sources) {
      const detail = await fixture.json(`/implementations/${source.implementation_id}`);
      expect(detail.runs).toEqual([]);
      expect(detail.github_sources[0].intake).toEqual(queue.entries.find((entry: any) => entry.source_id === source.id));
    }
    const overview = await fixture.json("");
    expect(overview.implementations.find((entry: any) => entry.id === queue.entries.find((entry: any) => entry.number === 4).implementation_id).intake.lane).toBe("needs_you");
  } finally { fixture.close(); }
});

test("preview receipts become stale on priority, policy, planning, source and sync changes", async () => {
  const fixture = githubQueueFixture();
  try {
    const { route, readiness, configuration } = await fixture.setup();
    const second = { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later issue" };
    fixture.save([fixture.issue, second]);
    let view = await fixture.json(route + "/sync", {});
    const first = view.sources[0];
    await fixture.json(route + "/issues/1/approve", { source_revision: first.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: first.revision });
    await fixture.json(route + "/sync", {});
    let preview = await fixture.json(route + "/preview", {});
    expect(preview.eligible_count).toBe(1);
    await fixture.json(`/implementations/${view.sources[1].implementation_id}/order`, { before_id: first.implementation_id });
    let current = await fixture.json(route + "/queue");
    expect(current.preview_current).toBe(false);
    expect(current.preview.revision).toBe(preview.revision);
    expect(current.entries.map((entry: any) => entry.number)).toEqual([2, 1]);
    preview = await fixture.json(route + "/preview", {});
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: true, max_implementations: 2 });
    current = await fixture.json(route + "/queue"); expect(current.preview_current).toBe(false); expect(current.eligible_count).toBe(1);
    await fixture.json(route + "/preview", {});
    fixture.save([fixture.issue, second], true);
    expect((await fixture.post(route + "/sync", {})).status).toBe(409);
    current = await fixture.json(route + "/queue");
    expect(current.preview_current).toBe(false); expect(current.eligible_count).toBe(0);
    expect(current.entries[1].reasons).toContainEqual({ code: "dependencies_stale", detail: "" });
    fixture.save([fixture.issue, second]); await fixture.json(route + "/sync", {});
    expect((await fixture.json(route + "/preview", {})).eligible_count).toBe(1);
    await fixture.json(`/implementations/${first.implementation_id}/specifications`, { content: "Changed manual plan." });
    current = await fixture.json(route + "/queue"); expect(current.preview_current).toBe(false); expect(current.eligible_count).toBe(0);
    expect(current.entries[1].reasons).toContainEqual({ code: "planning_changed", detail: "" });
    await fixture.json(route + "/preview", {});
    fixture.issue.title = "Changed source"; fixture.issue.updated_at = "2026-10-03T12:00:00Z";
    fixture.save([fixture.issue, second]); await fixture.json(route + "/sync", {});
    current = await fixture.json(route + "/queue"); expect(current.preview_current).toBe(false); expect(current.entries[1].title).toBe("Changed source");
    await fixture.json(route + "/preview", {});
    view = await fixture.json(route);
    await fixture.json(route + "/configure", { ...configuration, expected_revision: view.policy.revision, import_issues: false });
    expect((await fixture.json(route + "/queue")).preview_current).toBe(false);
    fixture.restart(); current = await fixture.json(route + "/queue");
    expect(current.preview).not.toBeNull(); expect(current.preview_current).toBe(false);
    expect((await fixture.json(`/implementations/${first.implementation_id}`)).runs).toEqual([]);
  } finally { fixture.close(); }
});

test("global capacity reductions bound the effective Project limit and invalidate previews", async () => {
  const fixture = githubQueueFixture();
  try {
    const { route } = await fixture.setup();
    await fixture.json(route + "/queue", { expected_revision: null, automatic_implementation: false, paused: false, max_implementations: 3 });
    await fixture.json(route + "/preview", {});
    await fixture.json("/settings", { max_implementations: 2 });
    expect(await fixture.json(route + "/queue")).toMatchObject({ policy: { max_implementations: 3 }, global_limit: 2, effective_limit: 2, preview_current: false });
  } finally { fixture.close(); }
});

test("future imports use the same evaluation and unverified native prerequisites stay excluded", async () => {
  const fixture = githubQueueFixture();
  try {
    const { route, readiness, account } = await fixture.setup();
    const view = await fixture.json(route + "/sync", {});
    const source = view.sources[0];
    await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
    await fixture.json(route + "/sync", {});
    expect((await fixture.json(route + "/preview", {})).eligible_count).toBe(1);
    const later = { ...fixture.issue, number: 2, node_id: "fictional-2", title: "Later dependent", html_url: "https://github.com/fictional/project/issues/2" };
    fixture.save([fixture.issue, later], false, { 2: [fixture.issue] });
    const synced = await fixture.json(route + "/sync", {});
    const dependent = synced.sources.find((entry: any) => entry.number === 2);
    await fixture.json(route + "/issues/2/approve", { source_revision: dependent.revision, policy_revision: readiness.revision });
    await fixture.json(route + "/issues/2/prepare", { source_revision: dependent.revision });
    await fixture.json(route + "/sync", {});
    const queue = await fixture.json(route + "/queue");
    expect(queue).toMatchObject({ eligible_count: 1, preview_current: false });
    expect(queue.entries.find((entry: any) => entry.number === 2)).toMatchObject({ eligible: false, lane: "inbox", reasons: [{ code: "dependency_delivery_unverified", detail: "fictional/project #1" }] });
    await fixture.json(route + "/preview", {});
    const profiles = await fixture.json("/machines/local/accounts");
    const profile = profiles.profiles.find((entry: any) => entry.id === account.id);
    await fixture.json(`/machines/local/accounts/${profile.id}/disable`, { expected_revision: profile.revision });
    const unavailable = await fixture.json(route + "/queue");
    expect(unavailable).toMatchObject({ eligible_count: 0, preview_current: false });
    expect(unavailable.entries[0].reasons).toContainEqual({ code: "account_unavailable", detail: "" });
    expect((await fixture.json(`/implementations/${source.implementation_id}`)).runs).toEqual([]);
  } finally { fixture.close(); }
});
