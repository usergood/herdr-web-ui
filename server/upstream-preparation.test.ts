import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { githubScheduleFixture } from "./github-schedules.fixture.ts";

test("an upstream Specification retains the detected release instead of a later candidate or caller replacement", async () => {
  const f = await githubScheduleFixture({ version: async () => "owned-upstream-provider" });
  try {
    await f.request(f.route + "/configure", { ...f.policy, upstream_repository: "fictional/upstream" });
    writeFileSync(f.responses, JSON.stringify({ releases: [{ id: 11, tag_name: "v1", draft: false, published_at: "2026-10-11T09:00:00Z" }], release_heads: { v1: "a".repeat(40) } }));
    const detected = (await f.request(f.route + "/schedules/run", { job: "upstream_sync" })).body.upstream;
    const prefix = `/implementations/${detected.active.implementation_id}`;
    const release = { repository: "fictional/upstream", release_id: "11", tag: "v1", revision: "a".repeat(40), published_at: "2026-10-11T09:00:00Z", url: "https://github.com/fictional/upstream/releases/tag/v1" };
    const spec = await f.request(prefix + "/specifications", { content: "Prepare the approved upstream release in isolation.", upstream_update: { ...release, revision: "b".repeat(40) } });
    expect(spec.status).toBe(201);
    expect(spec.body.upstream_update).toEqual(release);
    writeFileSync(f.responses, JSON.stringify({ releases: [{ id: 12, tag_name: "v2", draft: false, published_at: "2026-10-12T09:00:00Z" }], release_heads: { v2: "c".repeat(40) } }));
    await f.request(f.route + "/schedules/run", { job: "upstream_sync" });
    f.restart();
    const detail = (await f.request(prefix)).body;
    expect(detail.specifications[0].upstream_update).toEqual(release);
    expect(detail.implementation.upstream_update).toEqual(release);
    expect((await f.request(f.route + "/schedules")).body.upstream.candidate.tag).toBe("v2");
    expect(detail.runs).toHaveLength(0);
  } finally { f.close(); }
});

test("upstream preparation requires accepted Specification, testing seams and Tickets even for direct Work", async () => {
  let allocations = 0;
  const f = await githubScheduleFixture({ version: async () => "owned-upstream-provider", createWorkspace: async () => { allocations++; throw new Error("Blocked upstream preparation must never allocate native work"); } });
  try {
    await f.request(f.route + "/configure", { ...f.policy, upstream_repository: "fictional/upstream" });
    writeFileSync(f.responses, JSON.stringify({ releases: [{ id: 11, tag_name: "v1", draft: false, published_at: "2026-10-11T09:00:00Z" }], release_heads: { v1: "a".repeat(40) } }));
    const detected = (await f.request(f.route + "/schedules/run", { job: "upstream_sync" })).body.upstream;
    const prefix = `/implementations/${detected.active.implementation_id}`;
    let attempt = 0;
    const blocked = async (code = "scope_unaccepted", reason = "Accept the upstream release's Specification", condition: "blocked" | "queued" = "blocked") => {
      // A material planning change needs a fresh explicit Start. Reusing an old
      // key only observes its retained block; it cannot authorize new work.
      const request = { action: "work", idempotency_key: `prepare-approved-upstream-${++attempt}` };
      const result = await f.request(prefix + "/runs", request);
      if (condition === "blocked") expect(result).toMatchObject({ status: 409, body: { error: { code } } });
      else expect(result).toMatchObject({ status: 202, body: { condition, run_id: null } });
      const retained = await f.request(prefix + "/runs", request);
      expect(retained).toMatchObject({ status: 202, body: { implementation_id: detected.active.implementation_id, idempotency_key: request.idempotency_key, action: "work", condition, run_id: null } });
      expect(retained.body.reason).toContain(reason);
      expect((await f.request(prefix)).body.runs).toHaveLength(0);
      expect(allocations).toBe(0);
      return { request, retained: retained.body };
    };
    await blocked();
    const spec = (await f.request(prefix + "/specifications", { content: "Integrate only v1 in owned worktrees. Ask about conflicts." })).body;
    await blocked();
    await f.request(prefix + "/approvals", { kind: "specification", revision: spec.id, scope: "Owned release approval" });
    await blocked();
    await f.request(prefix + "/approvals", { kind: "testing_seams", revision: spec.id, scope: "Public HTTP/API and browser journeys" });
    await blocked();
    const graph = (await f.request(prefix + "/tickets", { specification_id: spec.id, tickets: [{ key: "upstream", title: "Prepare v1", acceptance: "Retain isolated diff, checks and reviews", dependencies: [] }] })).body;
    await blocked();
    await f.request(prefix + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "Owned upstream Ticket graph approval" });
    const missingChecks = await blocked("project_setup_required", "Configure known Project checks and execution permissions");
    const projectId = f.route.split("/")[2]!;
    await f.request(`/projects/${projectId}/configure`, { checks: [["git", "status", "--porcelain"]], permissions: "Only this owned upstream fixture" });
    await f.request(prefix + "/questions", { question: "The release needs a new compatibility decision before preparation. Which behavior should be retained?" });
    // Renewing setup cannot replay the older refused preparation request.
    const retainedSetup = await f.request(prefix + "/runs", missingChecks.request);
    expect(retainedSetup).toEqual({ status: 202, body: missingChecks.retained });
    await blocked("answers_unready", "Answer pending owner questions", "queued");
    f.restart();
    expect(allocations).toBe(0);
    expect((await f.request(prefix)).body).toMatchObject({ runs: [], board: { lane: "needs_you" } });
    expect(f.calls().every(args => !args.includes("--method"))).toBe(true);
  } finally { f.close(); }
});
