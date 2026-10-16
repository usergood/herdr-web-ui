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
  const f = await githubScheduleFixture({ version: async () => "owned-upstream-provider" });
  try {
    await f.request(f.route + "/configure", { ...f.policy, upstream_repository: "fictional/upstream" });
    writeFileSync(f.responses, JSON.stringify({ releases: [{ id: 11, tag_name: "v1", draft: false, published_at: "2026-10-11T09:00:00Z" }], release_heads: { v1: "a".repeat(40) } }));
    const detected = (await f.request(f.route + "/schedules/run", { job: "upstream_sync" })).body.upstream;
    const prefix = `/implementations/${detected.active.implementation_id}`;
    const blocked = async () => {
      const result = await f.request(prefix + "/runs", { action: "work", idempotency_key: "prepare-approved-upstream" });
      expect(result).toMatchObject({ status: 409, body: { error: { code: "scope_unaccepted" } } });
      expect((await f.request(prefix)).body.runs).toHaveLength(0);
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
    const missingChecks = await f.request(prefix + "/runs", { action: "work", idempotency_key: "prepare-approved-upstream" });
    expect(missingChecks.status).toBe(409);
    expect(missingChecks.body.error.code).toBe("project_setup_required");
    expect((await f.request(prefix)).body.runs).toHaveLength(0);
    const projectId = f.route.split("/")[2]!;
    await f.request(`/projects/${projectId}/configure`, { checks: [["git", "status", "--porcelain"]], permissions: "Only this owned upstream fixture" });
    await f.request(prefix + "/questions", { question: "The release needs a new compatibility decision before preparation. Which behavior should be retained?" });
    const unanswered = await f.request(prefix + "/runs", { action: "work", idempotency_key: "prepare-approved-upstream" });
    expect(unanswered.status).toBe(409);
    expect(unanswered.body.error.code).toBe("answers_unready");
    expect((await f.request(prefix)).body).toMatchObject({ runs: [], board: { lane: "needs_you" } });
    expect(f.calls().every(args => !args.includes("--method"))).toBe(true);
  } finally { f.close(); }
});
