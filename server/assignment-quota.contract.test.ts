import { expect, test } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { githubQueueFixture } from "../scripts/fixtures/github-queue.ts";
import { FactoryStore } from "./factory-store.ts";

test("a restored Project Assignment quota does not block independent work while global Agent capacity still queues", async () => {
  const f = await capacityFixture();
  try {
    await f.api("/settings", { max_agents: 2, max_builds: 1 });
    const first = await f.assignment("First independent work");
    const projectId = (await f.api(`/implementations/${first}?view=current`).then(r => r.json())).implementation.project_id;
    const next = async (title: string) => (await f.api("/implementations", { title, description: "Owned quota migration", project_id: projectId }).then(r => r.json())).id;
    const second = await next("Second independent work"), third = await next("Third waits for Agent capacity");
    const store = new FactoryStore(f.state);
    store.put("project_queues", { id: projectId, revision: "obsolete-project-cap", paused: false, max_implementations: 1 }, projectId); store.close();
    f.restart();
    const start = (id: string) => f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "owned-start" }).then(r => r.json());
    expect(await start(first)).toMatchObject({ condition: "working" });
    expect(await start(second)).toMatchObject({ condition: "working" });
    expect(await start(third)).toMatchObject({ condition: "queued", reason: expect.stringContaining("agent capacity") });
    const queue = await f.api(`/projects/${projectId}/queue`).then(r => r.json());
    expect(queue.capacity).toMatchObject({ agents: 2, max_agents: 2, builds: 0, max_builds: 1 });
    expect(queue).not.toHaveProperty("max_implementations");
    expect(queue).not.toHaveProperty("effective_limit");
    expect(queue.paused).toBe(false);
  } finally { f.close(); }
});

test("local Project queue configuration rejects the removed Assignment quota", async () => {
  const f = await capacityFixture();
  try {
    const id = await f.assignment("Owned configuration validation");
    const projectId = (await f.api(`/implementations/${id}?view=current`).then(r => r.json())).implementation.project_id;
    for (const max_implementations of [1, 6, null]) {
      const response = await f.api(`/projects/${projectId}/queue/configure`, { expected_revision: null, paused: false, max_implementations });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_queue");
    }
  } finally { f.close(); }
});

test("restored local and GitHub Assignment quotas do not serialize approved independent issues", async () => {
  const f = githubQueueFixture(true);
  try {
    const { route, project, readiness, configuration } = await f.setup();
    await f.json(route + "/configure", { ...configuration, expected_revision: (await f.json(route)).policy.revision, sync_enabled: true });
    const second = { ...f.issue, number: 2, node_id: "quota-second", title: "Second independent approved issue", html_url: "https://github.com/fictional/project/issues/2" };
    f.save([f.issue, second], false, {}, true);
    await f.renewLabels(route, [1, 2]);
    const sources = (await f.json(route + "/sync", {})).sources;
    for (const source of sources) {
      await f.json(route + `/issues/${source.number}/approve`, { source_revision: source.revision, policy_revision: readiness.revision });
      await f.json(route + `/issues/${source.number}/prepare`, { source_revision: source.revision });
    }
    f.restart(() => {
      const store = new FactoryStore(f.root);
      store.put("project_queues", { id: project.id, revision: "obsolete-local-cap", paused: false, max_implementations: 1 }, project.id);
      store.put("github_queue_policies", { id: project.id, project_id: project.id, revision: "obsolete-issue-cap", automatic_implementation: true, paused: false, max_implementations: 1 }, project.id);
      store.close();
    });
    await f.json(route + "/sync", {});
    for (const source of sources) expect((await f.json(`/implementations/${source.implementation_id}`)).runs).toMatchObject([{ action: "implement-spec", condition: "working" }]);
    expect(f.launches).toHaveLength(2);
    const queue = await f.json(route + "/queue");
    expect(queue.policy).toMatchObject({ automatic_implementation: true, paused: false });
    expect(queue.policy).not.toHaveProperty("max_implementations");
    for (const field of ["global_limit", "effective_limit", "available_slots"]) expect(queue).not.toHaveProperty(field);
    expect(queue.implementing_count).toBe(2);
    expect((await f.json("")).capacity.normal).toMatchObject({ limit: 6, used: 2 });
    for (const max_implementations of [1, 6, null]) expect((await f.post(route + "/queue", { expected_revision: queue.policy.revision, automatic_implementation: true, paused: false, max_implementations })).status).toBe(400);
  } finally { f.close(); }
}, 30_000);

test("a competing top-level Start cannot replay after owner Stop without a fresh explicit request", async () => {
  const f = await capacityFixture();
  try {
    await f.api("/settings", { max_agents: 1 });
    const id = await f.assignment("Exclusive owned Assignment");
    const start = (key: string) => f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: key });
    const first = await start("first").then(response => response.json());
    expect(first.condition).toBe("working");
    const competing = await start("competing-before-stop");
    expect(competing.status).toBe(409); expect((await competing.json()).error.code).toBe("implementation_owned");
    expect((await f.api(`/runs/${first.id}/stop`, {}).then(response => response.json())).condition).toBe("cancelled");
    // Reading the old key drains pending work too: it must remain visibly blocked.
    const replay = await start("competing-before-stop");
    expect(replay.status).toBe(202); expect(await replay.json()).toMatchObject({ condition: "blocked", idempotency_key: "competing-before-stop", run_id: null });
    expect((await f.api(`/implementations/${id}`).then(response => response.json())).runs).toMatchObject([{ id: first.id, condition: "cancelled" }]);
    expect(f.launches).toEqual([first.id]);
    const fresh = await start("fresh-after-stop").then(response => response.json());
    expect(fresh).toMatchObject({ condition: "working", idempotency_key: "fresh-after-stop" });
    expect(fresh.id).not.toBe(first.id);
    expect(f.launches).toEqual([first.id, fresh.id]);
  } finally { f.close(); }
}, 15_000);
