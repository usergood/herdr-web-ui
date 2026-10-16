import { expect, test } from "bun:test";
import { factoryMergeFixture } from "./factory-merge.fixture.ts";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("a published release containing the required merge completes the frozen release milestone through its selected Machine", async () => {
  const f = await factoryMergeFixture(true, "release");
  try {
    const release = { id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z", target_commitish: "main" };
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [release];
    f.data["repos/fictional/project/releases/42"] = release;
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: f.tip };
    f.respond();
    await f.request(`/projects/${f.project.id}/configure`, { delivery_policy: "merge", delivery_branch: "future" });
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const response = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    expect(response.status).toBe(200);
    const delivery = await response.json();
    expect(delivery.condition).toBe("released");
    expect(delivery.release).toMatchObject({ id: 42, tag: "v1.0.0", commit: f.tip, url: "https://github.com/fictional/project/releases/tag/v1.0.0", published_at: "2026-10-14T12:00:00Z", merge_commits: [f.merge] });
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.implementation.delivery_scope).toMatchObject({ milestone: "release", branch: "main" });
    expect(detail.implementation.outcome).toBe("released");
    expect(detail.board).toMatchObject({ lane: "done", busy: false, sidebar_hidden: true });
    expect(await f.request(f.prefix + "/delivery").then(r => r.json())).toEqual(delivery);
    const events = detail.events.filter((event: { kind: string }) => event.kind === "assignment_delivered");
    expect(events).toHaveLength(1);
    await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    expect((await f.request(f.prefix).then(r => r.json())).events.filter((event: { kind: string }) => event.kind === "assignment_delivered")).toEqual(events);
    expect(f.calls().every(call => !call.args.includes("--method") && call.scoped && call.token === null)).toBe(true);
  } finally { await f.close(); }
});

test("verified release completion remains verified merge evidence for the synchronized upstream follow-up", async () => {
  const f = await factoryMergeFixture(false, "release", true, {}, true);
  try {
    const route = `/projects/${f.project.id}/github/schedules`;
    f.data["repos/fictional/upstream/releases?per_page=30&page=1"] = [{ id: 102, tag_name: "v2", draft: false, published_at: "2026-10-13T09:00:00Z" }];
    f.data["repos/fictional/upstream/commits/v2"] = { sha: "9".repeat(40) }; f.respond();
    const before = await f.request(route + "/run", { job: "upstream_sync" }).then(r => r.json());
    expect(before.upstream.active.implementation_id).toBe(f.run.implementation_id);
    expect(before.upstream.candidate.release_id).toBe("102");
    const release = { id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z" };
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [release];
    f.data["repos/fictional/project/releases/42"] = release;
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: f.tip }; f.respond();
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const delivery = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(delivery.condition).toBe("released");
    const after = await f.request(route).then(r => r.json());
    expect(after.upstream.active.release.release_id).toBe("102");
    expect(after.upstream.candidate).toBeNull();
  } finally { await f.close(); }
});

test("a containing release must include every linked delivery merge before completing the Assignment", async () => {
  const f = await factoryMergeFixture(false, "release");
  try {
    f.commit("second.md", "A second intended change\n");
    const second = f.git(["rev-parse", "HEAD:second.md"], f.run.worktree!).trim();
    const merge13 = "f".repeat(40), released = "e".repeat(40);
    const finalTree = { ...f.tree, tree: [...f.tree.tree, { path: "second.md", mode: "100644", type: "blob", sha: second }] };
    f.data[`repos/fictional/project/git/trees/${f.tip}?recursive=1`] = finalTree;
    f.data["repos/fictional/project/pulls/13"] = { ...f.pull, number: 13, merge_commit_sha: merge13 };
    f.data["repos/fictional/project/pulls/13/files?per_page=100&page=1"] = [{ filename: "second.md", status: "added", sha: second }];
    f.data[`repos/fictional/project/git/trees/${merge13}?recursive=1`] = finalTree;
    f.data[`repos/fictional/project/compare/${merge13}...${f.tip}`] = { status: "ahead", merge_base_commit: { sha: merge13 } };
    const release = { id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z" };
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [release];
    f.data["repos/fictional/project/releases/42"] = release;
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: released };
    f.data[`repos/fictional/project/git/trees/${released}?recursive=1`] = finalTree;
    f.data[`repos/fictional/project/compare/${f.merge}...${released}`] = { status: "ahead", merge_base_commit: { sha: f.merge } };
    f.data[`repos/fictional/project/compare/${merge13}...${released}`] = { status: "diverged", merge_base_commit: { sha: f.merge } }; f.respond();
    const linked = await f.request(f.prefix + "/delivery", { ...f.links, pull_numbers: [12, 13] }).then(r => r.json());
    const partial = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(partial.condition).toBe("merged");
    expect((await f.request(f.prefix).then(r => r.json())).board).toMatchObject({ lane: "running", activity: "awaiting_release", busy: false });
    f.data[`repos/fictional/project/compare/${merge13}...${released}`] = { status: "ahead", merge_base_commit: { sha: merge13 } }; f.respond();
    const delivered = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(delivered.release.merge_commits).toEqual([f.merge, merge13]);
    expect((await f.request(f.prefix).then(r => r.json())).implementation.outcome).toBe("released");
  } finally { await f.close(); }
});

test("unavailable release ancestry remains Needs you rather than implying an unrelated release was fully inspected", async () => {
  const f = await factoryMergeFixture(false, "release");
  try {
    const released = "e".repeat(40);
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [{ id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z" }];
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: released };
    f.data[`repos/fictional/project/compare/${f.merge}...${released}`] = {}; f.respond();
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const delivery = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(delivery.condition).toBe("merged");
    expect(delivery.problem).toContain("incomplete");
    expect((await f.request(f.prefix).then(r => r.json())).board).toMatchObject({ lane: "needs_you", activity: "awaiting_release", busy: false });
  } finally { await f.close(); }
});

test.each(["additional work", "removed work"])("repository changes made while release evidence is read cannot be completed by the earlier merge coverage: %s", async scenario => {
  const f = await factoryMergeFixture(false, "release");
  try {
    const released = "e".repeat(40);
    const release = { id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z" };
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [release];
    f.data["repos/fictional/project/releases/42"] = release;
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: released };
    f.data[`repos/fictional/project/compare/${f.merge}...${released}`] = { status: "ahead", merge_base_commit: { sha: f.merge } };
    f.data[`repos/fictional/project/git/trees/${released}?recursive=1`] = f.tree;
    f.data.pause = `repos/fictional/project/git/trees/${released}?recursive=1`; f.respond();
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const pending = f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(f.githubRoot, "reading")) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(f.githubRoot, "reading"))).toBe(true);
    if (scenario === "additional work") f.commit("later.md", "Work added during release verification\n");
    else f.git(["reset", "--hard", f.run.base!], f.run.worktree!);
    writeFileSync(join(f.githubRoot, "continue"), "continue");
    const delivery = await (await pending).json();
    expect(delivery.condition).toBe("needs_you");
    expect(delivery.release).toBeUndefined();
    expect(delivery.problem).toContain("changes");
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.implementation.outcome).toBe("none");
    expect(detail.board.lane).toBe("needs_you");
  } finally { writeFileSync(join(f.githubRoot, "continue"), "continue"); await f.close(); }
});

test("an owner action requested during passive release waiting cannot be hidden by a later containing release", async () => {
  const f = await factoryMergeFixture(false, "release");
  try {
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    const question = await f.request(f.prefix + "/questions", { question: "Resolve the release publication action" }).then(r => r.json());
    const release = { id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z" };
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [release];
    f.data["repos/fictional/project/releases/42"] = release;
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: f.tip }; f.respond();
    await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.implementation.outcome).toBe("none");
    expect(detail.board).toMatchObject({ lane: "needs_you", activity: "awaiting_release", waiting_reason: question.question, busy: false });
  } finally { await f.close(); }
});

test("a required owner answer takes precedence over release completion until that answer is retained", async () => {
  const f = await factoryMergeFixture(false, "release");
  try {
    const release = { id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z" };
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [release];
    f.data["repos/fictional/project/releases/42"] = release;
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: f.tip }; f.respond();
    const question = await f.request(f.prefix + "/questions", { question: "Confirm the required release action is resolved" }).then(r => r.json());
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    const waiting = await f.request(f.prefix).then(r => r.json());
    expect(waiting.board).toMatchObject({ lane: "needs_you", activity: "awaiting_release", busy: false, waiting_reason: question.question });
    expect(waiting.implementation.outcome).toBe("none");
    expect(waiting.events.some((event: { kind: string }) => event.kind === "assignment_delivered")).toBe(false);
    expect((await f.request(f.prefix + `/questions/${question.id}/answer`, { revision: question.revision, answer: "The required action is resolved" })).status).toBe(200);
    await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    expect((await f.request(f.prefix).then(r => r.json())).board.lane).toBe("done");
  } finally { await f.close(); }
});

test("published containing releases remain discoverable beyond a page of unpublished drafts", async () => {
  const f = await factoryMergeFixture(false, "release");
  try {
    const release = { id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z" };
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, tag_name: `draft-${i}`, draft: true, published_at: null }));
    f.data["repos/fictional/project/releases?per_page=100&page=2"] = [release];
    f.data["repos/fictional/project/releases/42"] = release;
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: f.tip }; f.respond();
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const delivery = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(delivery).toMatchObject({ condition: "released", release: { id: 42 } });
    expect((await f.request(f.prefix).then(r => r.json())).board.lane).toBe("done");
  } finally { await f.close(); }
});

test("incomplete release evidence needs owner repair while retaining verified merges", async () => {
  const f = await factoryMergeFixture(false, "release");
  try {
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [{ id: 42, tag_name: "v1.0.0", published_at: "2026-10-14T12:00:00Z" }]; f.respond();
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const delivery = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(delivery.condition).toBe("merged");
    expect(delivery.problem).toContain("incomplete");
    expect(delivery.pulls.map((pull: { number: number }) => pull.number)).toEqual([12]);
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.implementation.outcome).toBe("none");
    expect(detail.board).toMatchObject({ lane: "needs_you", activity: "awaiting_release", busy: false });
  } finally { await f.close(); }
});

test.each(["moved tag", "withdrawn release"])("publication changed during release verification retains Needs you and no completion receipt: %s", async scenario => {
  const f = await factoryMergeFixture(false, "release");
  try {
    const released = "e".repeat(40);
    const release = { id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z" };
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [release];
    f.data["repos/fictional/project/releases/42"] = release;
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: released };
    f.data[`repos/fictional/project/compare/${f.merge}...${released}`] = { status: "ahead", merge_base_commit: { sha: f.merge } };
    f.data[`repos/fictional/project/git/trees/${released}?recursive=1`] = f.tree;
    f.data.pause = `repos/fictional/project/git/trees/${released}?recursive=1`; f.respond();
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const pending = f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(f.githubRoot, "reading")) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(f.githubRoot, "reading"))).toBe(true);
    if (scenario === "moved tag") f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: "d".repeat(40) };
    else f.data["repos/fictional/project/releases/42"] = { ...release, draft: true, published_at: null };
    f.respond();
    writeFileSync(join(f.githubRoot, "continue"), "continue");
    const delivery = await (await pending).json();
    expect(delivery.condition).toBe("merged");
    expect(delivery.release).toBeUndefined();
    expect(delivery.problem).toContain("changed");
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.board).toMatchObject({ lane: "needs_you", activity: "awaiting_release", busy: false });
    expect(detail.events.some((event: { kind: string }) => event.kind === "assignment_delivered")).toBe(false);
  } finally { writeFileSync(join(f.githubRoot, "continue"), "continue"); await f.close(); }
});

test("a release that reverted the intended content cannot finish merely because its history contains the merge", async () => {
  const f = await factoryMergeFixture(false, "release");
  try {
    const reverted = "e".repeat(40);
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [{ id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z" }];
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: reverted };
    f.data[`repos/fictional/project/compare/${f.merge}...${reverted}`] = { status: "ahead", merge_base_commit: { sha: f.merge } };
    f.data[`repos/fictional/project/git/trees/${reverted}?recursive=1`] = { truncated: false, tree: [] };
    f.respond();
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const delivery = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(delivery.condition).toBe("merged");
    expect(delivery.release).toBeUndefined();
    expect((await f.request(f.prefix).then(r => r.json())).board).toMatchObject({ lane: "running", activity: "awaiting_release", busy: false });
  } finally { await f.close(); }
});

test("unrelated published tags leave merged work Running and Awaiting release without a busy state", async () => {
  const f = await factoryMergeFixture(false, "release");
  try {
    const older = "d".repeat(40);
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [{ id: 41, tag_name: "v0.9.0", draft: false, published_at: "2026-10-13T12:00:00Z", target_commitish: "main" }];
    f.data["repos/fictional/project/commits/tags%2Fv0.9.0"] = { sha: older };
    f.data[`repos/fictional/project/compare/${f.merge}...${older}`] = { status: "behind", merge_base_commit: { sha: older } };
    f.respond();
    const linked = await f.request(f.prefix + "/delivery", f.links).then(r => r.json());
    const delivery = await f.request(f.prefix + "/delivery/sync", { expected_revision: linked.revision }).then(r => r.json());
    expect(delivery).toMatchObject({ condition: "merged", problem: null });
    expect(delivery.release).toBeUndefined();
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.implementation.outcome).toBe("none");
    expect(detail.board).toMatchObject({ lane: "running", activity: "awaiting_release", busy: false });
    const overview = await f.request("").then(r => r.json());
    expect(overview.board.find((item: { implementation_id: string }) => item.implementation_id === f.run.implementation_id)).toEqual(detail.board);
  } finally { await f.close(); }
});
