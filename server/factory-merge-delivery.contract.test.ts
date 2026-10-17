import { expect, it } from "bun:test";
import { mergeFixture } from "../scripts/factory-merge-fixture.ts";

it("Human Review preserves the Assignment release milestone when a later Run captures merge policy", async () => {
  const f = await mergeFixture({ milestone: "merge", assignmentMilestone: "release" });
  try {
    const merged = await f.post(f.route + "merge", f.body);
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ condition: "awaiting_release", head: f.head, release_tag: null });
    expect(f.calls().some(args => args[1]?.endsWith("/releases"))).toBe(true);
    f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "frozen-milestone-release", "main"]); f.change({ release: "frozen-milestone-release" });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "released", release_tag: "frozen-milestone-release" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    expect(f.calls().some(args => args.includes("POST"))).toBe(false);
  } finally { f.close(); }
}, 20000);

it.each(["before", "middle", "after"].flatMap(position => [false, true].map(advanceTarget => ({ position, advanceTarget }))))("Human Review recognizes additive containing release after restart %j", async ({ position, advanceTarget }) => {
  const f = await mergeFixture({ milestone: "release", candidateContent: "approved first\napproved second\n" });
  try {
    const merged = await f.post(f.route + "merge", f.body);
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ condition: "awaiting_release", release_tag: null });
    const merge = f.git(["rev-parse", "main"]);
    const lines = ["approved first", "approved second"];
    lines.splice(position === "before" ? 0 : position === "middle" ? 1 : 2, 0, "Independent later content");
    const content = lines.join("\n") + "\n";
    const containing = f.descendant(content, advanceTarget);
    f.git(["tag", "additive-release", containing]); f.change({ release: "additive-release" });
    expect(f.git(["show", "additive-release:result.txt"])).toBe(content.trim());
    f.restart();
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: "released", merge_sha: merge, release_tag: "additive-release", head: f.head });
    f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "released", merge_sha: merge, release_tag: "additive-release" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    expect(f.calls().some(args => args.includes("POST"))).toBe(false);
  } finally { f.close(); }
}, 20000);

it.each([
  { name: "changed approved line", content: "changed first\napproved second\n" },
  { name: "full revert plus unrelated addition", content: "before\nIndependent later content\n" },
  { name: "restored removed line alongside approved content", content: "before\napproved first\napproved second\nIndependent later content\n" },
])("Human Review refuses descendant content that undoes the candidate: $name", async ({ content }) => {
  const f = await mergeFixture({ milestone: "release", candidateContent: "approved first\napproved second\n" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "invalid-content", f.descendant(content)]); f.change({ release: "invalid-content" }); f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release", release_tag: null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each([false, true])("Human Review refuses restoring a reviewed deletion even with unrelated additions (colored Git diff: %s)", async colored => {
  const f = await mergeFixture({ milestone: "release", baselineContent: "removed line\nretained line\n", candidateContent: "retained line\n" });
  try {
    if (colored) f.git(["config", "color.diff", "always"]);
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "restored-deletion", f.descendant("removed line\nretained line\nIndependent later content\n")]); f.change({ release: "restored-deletion" }); f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release", release_tag: null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each([
  { name: "wrong hash", patch: { blob_patch: { sha: "f".repeat(40) } } },
  { name: "wrong size", patch: { blob_patch: { size: 1 } } },
  { name: "oversized blob", patch: { blob_patch: { size: 2 * 1024 * 1024 + 1 } } },
  { name: "unsupported encoding", patch: { blob_patch: { encoding: "utf8" } } },
  { name: "malformed base64", patch: { blob_patch: { content: "not base64" } } },
  { name: "wrong mode", patch: { tree_mode: "100755" } },
  { name: "incomplete tree", patch: { truncated_tree: true } },
])("Human Review rejects incomplete or changed descendant evidence: $name", async ({ patch }) => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "unverified-release", f.descendant("after\nIndependent later content\n")]); f.change({ release: "unverified-release", ...patch }); f.restart();
    const response = await f.post(f.route + "merge", f.body); const result = await response.json();
    expect([200, 409]).toContain(response.status);
    if (response.status === 409) expect(result).toMatchObject({ error: { code: "merge_coverage_unverified" } });
    else expect(result).toMatchObject({ condition: "awaiting_release", release_tag: null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each(["", "approved\0binary\n"])("Human Review keeps non-text or empty approved blobs on exact coverage", async candidateContent => {
  const f = await mergeFixture({ milestone: "release", candidateContent });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "non-text-extension", f.descendant(candidateContent + "Independent later content\n")]); f.change({ release: "non-text-extension" });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release", release_tag: null });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("Human Review refuses a containing release whose tag moves during blob verification", async () => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "moving-release", f.descendant("after\nIndependent later content\n")]); f.change({ release: "moving-release", move_tag_after_lookup: f.base });
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "merge_coverage_unverified" } });
    expect(f.git(["rev-parse", "moving-release"])).toBe(f.base);
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("Human Review does not treat a descendant release that reverts approved content as delivery", async () => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    const merge = f.git(["rev-parse", "main"]);
    const reverted = f.git(["commit-tree", f.git(["rev-parse", f.base + "^{tree}"]), "-p", merge, "-m", "Revert approved content"]);
    f.git(["tag", "reverted-release", reverted]); f.change({ release: "reverted-release" });
    expect(f.git(["show", "reverted-release:result.txt"])).toBe("before");
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release", release_tag: null });
    f.git(["tag", "containing-release", merge]); f.change({ release: "containing-release" }); f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "released", release_tag: "containing-release" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    expect(f.calls().some(args => args.includes("POST"))).toBe(false);
  } finally { f.close(); }
}, 20000);

it("Human Review retains an uncertain merge when its target later reverts the intended changes", async () => {
  const f = await mergeFixture();
  try {
    f.change({ lose: true });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "uncertain" });
    const merged = f.git(["rev-parse", "main"]);
    const reverted = f.git(["commit-tree", f.git(["rev-parse", f.base + "^{tree}"]), "-p", merged, "-m", "Revert merged result"]);
    f.git(["update-ref", "refs/heads/main", reverted]); f.restart();
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "merge_coverage_unverified" } });
    f.git(["update-ref", "refs/heads/main", merged]);
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "merged", merge_sha: merged });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { published, until } from "../scripts/factory-human-review-fixture.ts";

it("the connection server retains release authority when an older Machine returns merge-only delivery", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  f.setTranscript({ source_id: "frozen-release-history", version: "one", cursor: null, turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Retained delivered result" }] }] });
  try {
    const { prefix, detail, run } = await published(f, "release");
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    expect(ready.implementation.delivery_scope.milestone).toBe("release");
    expect((await f.api(`/projects/${ready.implementation.project_id}/configure`, { delivery_policy: "merge" })).status).toBe(200);
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "older-machine-merge" };
    const project = (f.runs.get(run.id)!.manifest as { project: { delivery_policy: string } }).project;
    project.delivery_policy = "merge";
    let response: Response;
    try { response = await f.api(`${prefix}/human-review/approve`, body); }
    finally { project.delivery_policy = "release"; }
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: "awaiting_release", merge_sha: "a".repeat(40), release_tag: null });
    const waiting = await detail();
    expect(waiting.implementation.stage).toBe("review");
    expect(waiting.runs.find((r: any) => r.id === run.id).condition).not.toBe("completed");
    expect((await f.api(`${prefix}/archive`, {})).status).toBe(409);
    f.restart();
    expect((await f.api(`${prefix}/human-review/approve`, body).then(r => r.json())).condition).toBe("awaiting_release");
    f.releaseMerged();
    expect((await f.api(`${prefix}/human-review/approve`, body).then(r => r.json())).condition).toBe("released");
    const released = await until(detail, d => d.runs.find((r: any) => r.id === run.id)?.condition === "completed");
    expect(released.implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect(released.human_review_approvals).toHaveLength(1);
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("the connection server refuses release completion without a nonempty verified release tag", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  f.setTranscript({ source_id: "release-tag-history", version: "one", cursor: null, turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Retained release result" }] }] });
  try {
    const { prefix, detail, run } = await published(f, "release");
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "missing-release-tag" };
    expect((await f.api(`${prefix}/human-review/approve`, body).then(r => r.json())).condition).toBe("awaiting_release");
    f.releaseMerged("");
    const malformed = await f.api(`${prefix}/human-review/approve`, body).then(r => r.json());
    expect(malformed.condition).not.toBe("released");
    const pending = await detail();
    expect(pending.implementation.stage).toBe("review");
    expect(pending.runs.find((r: any) => r.id === run.id).condition).not.toBe("completed");
    expect((await f.api(`${prefix}/archive`, {})).status).toBe(409);
    f.releaseMerged("verified-tag");
    expect(await f.api(`${prefix}/human-review/approve`, body).then(r => r.json())).toMatchObject({ condition: "released", release_tag: "verified-tag" });
    expect((await detail()).implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it.each([{ branch: "other-target" }, { github_repository: "fictional/other" }, { repository: "unrelated-checkout" }])("the Machine refuses a candidate outside its frozen Assignment destination %j", async assignmentScope => {
  const f = await mergeFixture({ assignmentScope });
  try {
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "merge_authority_changed" } });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
    expect(f.git(["rev-parse", "main"])).toBe(f.base);
  } finally { f.close(); }
}, 20000);
