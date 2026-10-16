import { expect, test } from "bun:test";
import { githubDeliveryResponses } from "../scripts/fixtures/github-delivery.ts";
import { deliveryFixture } from "./github-delivery-scope.fixture.ts";

test("withdrawing a published containing release retires completion until fresh publication and containment are verified", async () => {
  const f = await deliveryFixture({ requires: "release" });
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: "released" });
    const releasePath = "repos/fictional/project/releases/tags/v1";
    const draft = { id: 1042, node_id: "fictional-release-v1", tag_name: "v1", target_commitish: "main", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, prerelease: false, created_at: "2026-10-03T12:00:00Z", published_at: null };
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), [releasePath]: draft });
    const withdrawn = await f.fixture.json(f.route + "/sync", {});
    const retired = await f.fixture.json(path);
    expect(retired.implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" });
    expect(retired.implementation.delivery_evidence).toBeUndefined();
    expect(retired.events).toContainEqual(expect.objectContaining({ kind: "issue_delivery_invalidated", data: { source_id: f.target.id, evidence: completed.delivery_evidence } }));
    expect(withdrawn.sources.find((source: any) => source.number === 1).dependencies).toMatchObject({ satisfied: false, fresh: false, edges: [{ requires: "release", blocker: "release_unverified" }] });
    f.fixture.restart();
    f.fixture.save(f.issues, false, f.dependencies, false, f.issues, undefined, { api_fail: releasePath });
    f.coverageResponses();
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    expect((await f.fixture.json(path)).implementation).toEqual(retired.implementation);
    f.fixture.save(f.issues, false, f.dependencies);
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), [releasePath]: null });
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toEqual(retired.implementation);
    f.fixture.setApiResponses(githubDeliveryResponses({ containsRelease: false }));
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation.delivery_evidence).toBeUndefined();
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.coverageResponses();
    const published = await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: "released", delivery_evidence: { release: { tag: "v1", commit: "d".repeat(40) } } });
    expect(published.sources.find((source: any) => source.number === 1).dependencies).toMatchObject({ satisfied: true, fresh: true, edges: [{ blocker: null }] });
  } finally { f.fixture.close(); }
});

test.each([
  { name: "missing", response: null },
  { name: "missing publication field", response: { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true } },
  { name: "wrong tag", response: { tag_name: "v2", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, published_at: null } },
  { name: "wrong repository", response: { tag_name: "v1", html_url: "https://github.com/fictional/other/releases/tag/v1", draft: true, published_at: null } },
  { name: "malformed publication", response: { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, published_at: "unknown" } },
  { name: "malformed draft", response: { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: "true", published_at: null } },
])("$name release evidence blocks admission without inventing a withdrawal", async ({ response }) => {
  const f = await deliveryFixture({ requires: "release" });
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed.stage).toBe("done");
    f.fixture.setApiResponses({ ...githubDeliveryResponses(), "repos/fictional/project/releases/tags/v1": response });
    const view = await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toEqual(completed);
    expect((await f.fixture.json(path)).events.filter((event: any) => event.kind === "issue_delivery_invalidated")).toEqual([]);
    expect(view.sources.find((source: any) => source.number === 1).dependencies).toMatchObject({ satisfied: false, fresh: true, edges: [{ blocker: "release_unverified" }] });
    f.fixture.restart();
    expect((await f.fixture.json(path)).implementation).toEqual(completed);
    f.coverageResponses(); await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["branch", "release"] as const)("contradictory %s containment retires completion and preserves its proof across restart", async artifact => {
  const f = await deliveryFixture({ requires: artifact === "release" ? "release" : "merge" });
  try {
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const path = `/implementations/${f.target.implementation_id}`;
    const completed = (await f.fixture.json(path)).implementation;
    expect(completed).toMatchObject({ stage: "done", outcome: artifact === "release" ? "released" : "merged" });
    const responses = githubDeliveryResponses();
    responses["repos/fictional/project/compare/" + "c".repeat(40) + "..." + (artifact === "release" ? "d" : "f").repeat(40)] = { status: "behind", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "b".repeat(40) } };
    f.fixture.setApiResponses(responses);
    await f.fixture.json(f.route + "/sync", {});
    const retired = await f.fixture.json(path);
    expect(retired.implementation).toMatchObject({ stage: "review", activity: "awaiting_merge", outcome: "implementation_complete" });
    expect(retired.implementation.delivery_evidence).toBeUndefined();
    expect(retired.events).toContainEqual(expect.objectContaining({ kind: "issue_delivery_invalidated", data: { source_id: f.target.id, evidence: completed.delivery_evidence } }));
    expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(false);
    f.fixture.restart();
    expect((await f.fixture.json(path)).implementation).toEqual(retired.implementation);
    f.fixture.save(f.issues, true, f.dependencies); f.coverageResponses();
    expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
    expect((await f.fixture.json(path)).implementation.delivery_evidence).toBeUndefined();
    f.fixture.save(f.issues, false, f.dependencies); f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(path)).implementation).toMatchObject({ stage: "done", outcome: artifact === "release" ? "released" : "merged" });
  } finally { f.fixture.close(); }
});

test.each([
  { order: "dependent first", outage: false },
  { order: "own completion first", outage: false },
  { order: "dependent first", outage: true },
])("a later merge contradiction revokes earlier and later consumers with $order (later outage: $outage)", async ({ order, outage }) => {
  const f = await deliveryFixture();
  try {
    const releaseConsumer = { ...f.fixture.issue, number: 3, node_id: "fictional-release-consumer", html_url: "https://github.com/fictional/project/issues/3", body: f.fixture.issue.body.replace("## Dependencies\nNone.", '## Dependencies\n[{"repository":"fictional/project","number":2,"requires":"release"}]') };
    const laterConsumer = { ...f.fixture.issue, number: 4, node_id: "fictional-later-consumer", html_url: "https://github.com/fictional/project/issues/4" };
    // Import order is durable. Recreate the fixture for the own-completion-first variant
    // by using a second prerequisite whose own proof precedes all its consumers.
    const targetIssue = order === "own completion first" ? { ...f.prerequisite, number: 5, node_id: "fictional-first-prerequisite", html_url: "https://github.com/fictional/project/issues/5" } : f.prerequisite;
    releaseConsumer.body = releaseConsumer.body.replace('"number":2', '"number":' + targetIssue.number);
    const unrelated = { ...f.prerequisite, number: 6, node_id: "fictional-fallible-delivery", html_url: "https://github.com/fictional/project/issues/6" };
    const issues = [...f.issues, ...(order === "own completion first" ? [targetIssue] : []), releaseConsumer, laterConsumer, ...(outage ? [unrelated] : [])];
    const dependencies = { 1: order === "dependent first" ? [targetIssue] : [], 4: [targetIssue] };
    f.fixture.save(issues, false, dependencies); f.coverageResponses();
    let view = await f.fixture.json(f.route + "/sync", {});
    const target = view.sources.find((source: any) => source.number === targetIssue.number);
    if (targetIssue.number !== 2) {
      const original = view.sources.find((source: any) => source.number === 2);
      await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, expected_revision: original.delivery.revision, intended_prs: [] });
      await f.fixture.json(f.route + `/issues/${targetIssue.number}/delivery`, { ...f.coverage, source_revision: target.revision });
    }
    const release = view.sources.find((source: any) => source.number === 3);
    const path = `/implementations/${release.implementation_id}`;
    const spec = await f.fixture.json(path + "/specifications", { content: releaseConsumer.body });
    for (const kind of ["specification", "testing_seams"]) await f.fixture.json(path + "/approvals", { kind, revision: spec.id, scope: "Require the released prerequisite", issue_scope: { source_id: release.id, source_revision: release.revision } });
    f.pull.merged = true; f.coverageResponses();
    await f.fixture.json(f.route + "/sync", {});
    const targetPath = `/implementations/${target.implementation_id}`;
    expect((await f.fixture.json(targetPath)).implementation.stage).toBe("done");
    if (outage) {
      const other = (await f.fixture.json(f.route)).sources.find((source: any) => source.number === 6);
      await f.fixture.json(f.route + "/issues/6/delivery", { ...f.coverage, source_revision: other.revision, intended_prs: [{ number: 28, head: "b".repeat(40) }] });
      f.fixture.save(issues, false, dependencies, false, issues, undefined, { api_fail: "repos/fictional/project/pulls/28" });
    }
    const responses = githubDeliveryResponses();
    const branch = "repos/fictional/project/branches/main";
    // The merge-only proof uses f; the release verification subsequently sees
    // a force push to e excluding the same merge. All later merge consumers share it.
    responses["repos/fictional/project/compare/" + "c".repeat(40) + "..." + "e".repeat(40)] = { status: "diverged", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "b".repeat(40) } };
    f.fixture.setApiResponses(responses, { [branch]: [{ name: "main", commit: { sha: "f".repeat(40) } }, { name: "main", commit: { sha: "e".repeat(40) } }] });
    if (outage) {
      expect((await f.fixture.post(f.route + "/sync", {})).status).toBe(409);
      view = await f.fixture.json(f.route);
    } else view = await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(targetPath)).implementation.delivery_evidence).toBeUndefined();
    for (const number of order === "dependent first" ? [1, 3, 4] : [3, 4]) expect(view.sources.find((source: any) => source.number === number).dependencies).toMatchObject({ satisfied: false, fresh: false });
    f.fixture.restart();
    expect((await f.fixture.json(targetPath)).implementation.stage).not.toBe("done");
    f.fixture.save(issues, false, dependencies); f.coverageResponses(); await f.fixture.json(f.route + "/sync", {});
    expect((await f.fixture.json(targetPath)).implementation.stage).toBe("done");
    expect((await f.fixture.json(f.route)).sources.find((source: any) => source.number === 4).dependencies.satisfied).toBe(true);
    if (order === "dependent first") expect((await f.fixture.json(f.route + "/queue")).entries.find((entry: any) => entry.number === 1).eligible).toBe(true);
  } finally { f.fixture.close(); }
});

test.each(["ancestry", "withdrawal"] as const)("a release-only %s contradiction preserves merge consumers and unrelated source completion", async contradiction => {
  const f = await deliveryFixture();
  try {
    const consumer = { ...f.fixture.issue, number: 3, node_id: "fictional-release", html_url: "https://github.com/fictional/project/issues/3", body: f.fixture.issue.body.replace("## Dependencies\nNone.", '## Dependencies\n[{"repository":"fictional/project","number":2,"requires":"release"}]') };
    const unrelated = { ...f.prerequisite, number: 4, node_id: "fictional-independent", html_url: "https://github.com/fictional/project/issues/4" };
    const later = { ...f.fixture.issue, number: 5, node_id: "fictional-later-merge", html_url: "https://github.com/fictional/project/issues/5" };
    const otherBranch = { ...f.prerequisite, number: 6, node_id: "fictional-other-branch", html_url: "https://github.com/fictional/project/issues/6" };
    f.fixture.save([...f.issues, consumer, unrelated, later, otherBranch], false, { ...f.dependencies, 5: [f.prerequisite] });
    f.coverageResponses();
    let view = await f.fixture.json(f.route + "/sync", {});
    const release = view.sources.find((source: any) => source.number === 3);
    const path = `/implementations/${release.implementation_id}`;
    const spec = await f.fixture.json(path + "/specifications", { content: consumer.body });
    for (const kind of ["specification", "testing_seams"]) await f.fixture.json(path + "/approvals", { kind, revision: spec.id, scope: "Released prerequisite", issue_scope: { source_id: release.id, source_revision: release.revision } });
    const original = view.sources.find((source: any) => source.number === 2);
    await f.fixture.json(f.route + "/issues/2/delivery", { ...f.coverage, expected_revision: original.delivery.revision, release_tag: "v1" });
    const other = view.sources.find((source: any) => source.number === 4);
    await f.fixture.json(f.route + "/issues/4/delivery", { ...f.coverage, source_revision: other.revision });
    const maintenance = view.sources.find((source: any) => source.number === 6);
    await f.fixture.json(f.route + "/issues/6/delivery", { ...f.coverage, source_revision: maintenance.revision, target_branch: "maintenance", intended_prs: [{ number: 28, head: "b".repeat(40) }] });
    // Supply a positive contradiction, rather than merely unavailable evidence.
    const responses = githubDeliveryResponses();
    responses["repos/fictional/project/branches/maintenance"] = { name: "maintenance", commit: { sha: "f".repeat(40) } };
    responses["repos/fictional/project/pulls/28"] = { ...f.pull, number: 28, html_url: "https://github.com/fictional/project/pull/28", merged: true, head: { sha: "b".repeat(40) }, base: { ref: "maintenance", repo: { full_name: "fictional/project" } } };
    if (contradiction === "withdrawal") responses["repos/fictional/project/releases/tags/v1"] = { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: true, published_at: null };
    else responses["repos/fictional/project/compare/" + "c".repeat(40) + "..." + "d".repeat(40)] = { status: "diverged", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "b".repeat(40) } };
    f.fixture.setApiResponses(responses);
    view = await f.fixture.json(f.route + "/sync", {});
    for (const number of [1, 5]) expect(view.sources.find((source: any) => source.number === number).dependencies).toMatchObject({ satisfied: true, fresh: true, edges: [{ requires: "merge", blocker: null }] });
    expect(view.sources.find((source: any) => source.number === 3).dependencies).toMatchObject({ satisfied: false, fresh: false });
    expect((await f.fixture.json(`/implementations/${other.implementation_id}`)).implementation).toMatchObject({ stage: "done", outcome: "merged" });
    expect((await f.fixture.json(`/implementations/${maintenance.implementation_id}`)).implementation).toMatchObject({ stage: "done", outcome: "merged" });
    expect((await f.fixture.json(`/implementations/${f.target.implementation_id}`)).implementation.stage).not.toBe("done");
  } finally { f.fixture.close(); }
});
