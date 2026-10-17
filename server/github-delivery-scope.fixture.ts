import { expect } from "bun:test";
import { githubQueueFixture } from "../scripts/fixtures/github-queue.ts";

export async function deliveryFixture({ requires = "merge", closed = false, readyLabel = false }: { requires?: "merge" | "release"; closed?: boolean; readyLabel?: boolean } = {}) {
  const fixture = githubQueueFixture(true);
  try {
    const { route, configuration } = await fixture.setup();
    const prerequisite = { ...fixture.issue, number: 2, node_id: "fictional-prerequisite", title: "Prerequisite", labels: readyLabel ? [{ name: "ready-for-agent" }] : [] as { name: string }[], state: closed ? "closed" : "open", html_url: "https://github.com/fictional/project/issues/2" };
    if (requires === "release") fixture.issue.body = fixture.issue.body.replace("## Dependencies\nNone.", '## Dependencies\n[{"repository":"fictional/project","number":2,"requires":"release"}]');
    const issues = [fixture.issue, prerequisite];
    const dependencies = { 1: [prerequisite] };
    const pull = { number: 27, html_url: "https://github.com/fictional/project/pull/27", merged: false, merged_at: "2026-10-03T12:00:00Z", merge_commit_sha: "c".repeat(40), head: { sha: "a".repeat(40) }, base: { ref: "main", repo: { full_name: "fictional/project" } } };
    function coverageResponses() {
      fixture.setApiResponses({
        "repos/fictional/project/pulls/27": pull,
        "repos/fictional/project/releases/tags/v1": { tag_name: "v1", html_url: "https://github.com/fictional/project/releases/tag/v1", draft: false, published_at: "2026-10-04T12:00:00Z" },
        "repos/fictional/project/git/ref/tags/v1": { ref: "refs/tags/v1", object: { type: "commit", sha: "d".repeat(40) } },
        ["repos/fictional/project/compare/" + "c".repeat(40) + "..." + "d".repeat(40)]: { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } },
        "repos/fictional/project/branches/main": { name: "main", commit: { sha: "f".repeat(40) } },
        ["repos/fictional/project/compare/" + "c".repeat(40) + "..." + "f".repeat(40)]: { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } },
      });
    }
    fixture.save(issues, false, dependencies); coverageResponses();
    await fixture.json(route + "/configure", { ...configuration, expected_revision: (await fixture.json(route)).policy.revision, sync_enabled: true });
    const view = await fixture.json(route + "/sync", {});
    const dependent = view.sources.find((source: any) => source.number === 1);
    const target = view.sources.find((source: any) => source.number === 2);
    await fixture.json(route + "/issues/1/approve", { source_revision: dependent.revision, policy_revision: view.readiness_policy.revision });
    await fixture.json(route + "/issues/1/prepare", { source_revision: dependent.revision });
    const coverage = { source_revision: target.revision, expected_revision: null, target_branch: "main", intended_prs: [{ number: 27, head: "a".repeat(40) }], release_tag: requires === "release" ? "v1" : null };
    await fixture.json(route + "/issues/2/delivery", coverage);
    const preview = await fixture.json(route + "/preview", {});
    expect(preview.entries.find((entry: any) => entry.number === 1)).toMatchObject({ eligible: false, reasons: [{ code: "dependency_delivery_unverified", detail: "fictional/project #2" }] });
    return { fixture, route, prerequisite, issues, dependencies, pull, coverageResponses, target, dependent, coverage, preview };
  } catch (error) { fixture.close(); throw error; }
}

