import { expect, test } from "bun:test";
import { factoryPublicationFixture } from "./factory-publication.fixture.ts";
import { upstreamConflictFixture } from "./upstream-conflict.fixture.ts";

test("approved upstream preparation retains its isolated diff and requires current checks and both reviews before explicit publication", async () => {
  const f = await factoryPublicationFixture({ upstream: true });
  try {
    const release = { repository: "fictional/upstream", release_id: "101", tag: "v1", revision: f.upstreamRevision };
    expect(f.run.manifest.specification.upstream_update).toMatchObject(release);
    expect(f.run.manifest.implementation.upstream_update).toMatchObject(release);
    expect(f.run.machine_id).toBe("delivery-host");
    expect(f.run.manifest.account_snapshot.profiles.find((p: { service: string }) => p.service === "github").id).toBe(f.profile.id);
    const snapshot = await f.request(f.prefix + "/snapshots", { run_id: f.run.id, mode: "branch" }).then(r => r.json());
    expect(snapshot.files.map((file: { path: string }) => file.path)).toEqual(["feature.md"]);
    expect(f.git(["rev-parse", "HEAD"] ).trim()).toBe(f.run.base);
    const proof = { head: f.head };
    expect((await f.request(`/runs/${f.run.id}/accept`, proof)).status).toBe(409);
    await f.request(`/runs/${f.run.id}/checks`, {});
    expect((await f.request(`/runs/${f.run.id}/accept`, proof)).status).toBe(409);
    await f.verify();
    expect((await f.request(`/runs/${f.run.id}/accept`, proof)).status).toBe(200);
    expect(f.uploads).toHaveLength(0);
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.checks.at(-1)).toMatchObject({ condition: "passed", head: f.head });
    expect(detail.review_evidence.map((r: { axis: string; head: string }) => [r.axis, r.head])).toEqual([["standards", f.head], ["spec", f.head]]);
    expect(detail.board).toMatchObject({ lane: "needs_you", activity: "awaiting_merge" });
    expect((await f.request(f.route + "/publish", proof)).status).toBe(200);
    expect(f.uploads).toHaveLength(1);
    expect(f.calls().every(call => call.scoped && !call.args.some(arg => /\/(merge|releases|deployments)$/.test(arg)))).toBe(true);
  } finally { await f.close(); }
}, 60_000);

test("an upstream conflict preserves the same workspace and release until an answered resolution is checked and reviewed", async () => {
  const f = await upstreamConflictFixture();
  try {
    expect((await f.request(f.prefix).then(r => r.json())).board.lane).toBe("needs_you");
    f.restart();
    const retained = await f.request(f.prefix).then(r => r.json());
    expect(retained.runs[0]).toMatchObject({ id: f.run.id, condition: "needs_you", worktree: f.run.worktree, branch: f.run.branch });
    expect(retained.questions[0]).toMatchObject({ id: f.question.id, answer: null });
    expect((await f.request(f.prefix + "/runs", { action: "work", idempotency_key: "approved-upstream-work" }).then(r => r.json())).id).toBe(f.run.id);
    expect((await f.request(`/runs/${f.run.id}/publication/publish`, { head: f.head })).status).toBe(409);
    expect((await f.request(f.prefix + `/questions/${f.question.id}/answer`, { revision: f.question.revision, answer: "Keep the fork behavior and incorporate only v1." })).status).toBe(200);
    const contract = await f.agent("contract").then(r => r.json());
    expect((await f.agent("consume", { revision: contract.question_revision })).status).toBe(200);
    const head = f.resolve();
    await f.verify();
    expect((await f.request(`/runs/${f.run.id}/accept`, { head })).status).toBe(200);
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0].manifest.specification.upstream_update.revision).toBe(f.upstreamRevision);
    expect(detail.checks.at(-1)).toMatchObject({ condition: "passed", head });
    expect(detail.review_evidence.every((e: { head: string }) => e.head === head)).toBe(true);
    expect(detail.board).toMatchObject({ lane: "needs_you", activity: "awaiting_merge" });
    expect(f.git(["rev-parse", "HEAD"]).trim()).toBe(f.run.base);
    expect(f.uploads).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

test("a new upstream design decision retains Needs you and owned preparation despite otherwise passing evidence", async () => {
  const f = await factoryPublicationFixture({ upstream: true });
  try {
    await f.verify();
    const question = await f.agent("question", { question: "The release changes a fork behavior. Should the prepared resolution retain the fork's behavior?" }).then(r => r.json());
    const response = await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("answers_unready");
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.board.lane).toBe("needs_you");
    expect(detail.questions).toContainEqual(expect.objectContaining({ id: question.id, answer: null }));
    expect(detail.runs[0]).toMatchObject({ worktree: f.run.worktree, branch: f.run.branch, condition: "needs_you" });
    expect((await f.request(`/projects/${f.project.id}/queue`).then(r => r.json())).capacity.project_implementations).toBe(1);
    expect(f.uploads).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);
