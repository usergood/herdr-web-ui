import { expect, test } from "bun:test";
import { factoryDeliveryFixture } from "./factory-delivery.fixture.ts";
import { factoryPublicationFixture } from "./factory-publication.fixture.ts";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fictionalGitHubPull } from "../site/demo/github-fixtures.ts";

test("implementation PR publication defaults off and requires its own explicit Project setting", async () => {
  const f = await factoryDeliveryFixture();
  try {
    expect(f.project.auto_publish_pr).toBe(false);
    const route = `/projects/${f.project.id}/configure`;
    expect((await f.request(route, { auto_publish_pr: "true" })).status).toBe(400);
    const enabled = await f.request(route, { auto_publish_pr: true }).then(r => r.json());
    expect(enabled.auto_publish_pr).toBe(true);
    const unchanged = await f.request(route, { delivery_policy: "release" }).then(r => r.json());
    expect(unchanged.auto_publish_pr).toBe(true);
    expect((await f.request(route, { auto_publish_pr: false }).then(r => r.json())).auto_publish_pr).toBe(false);
  } finally { await f.close(); }
});

test("only an explicitly published accepted head opens its scoped PR and retains Awaiting merge", async () => {
  const f = await factoryPublicationFixture();
  try {
    const proof = { head: f.head, title: "fix(factory): retain the reviewed result", body: "Completed work previously remained ambiguous. Preserve the accepted final change and its evidence." };
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    await f.verify();
    expect((await f.request(`/runs/${f.run.id}/accept`, proof)).status).toBe(200);
    expect(f.uploads).toHaveLength(0);
    const published = await f.request(f.route + "/publish", proof);
    expect(published.status).toBe(200);
    const receipt = await published.json();
    const created = f.calls().find(call => call.args.includes("--method"))!;
    expect(created.args).toContain(`title=${proof.title}`);
    const body = created.args.find(arg => arg.startsWith("body="))!;
    expect(body).toContain(proof.body); expect(body).toContain("git status --porcelain: exit 0");
    expect(body).toContain(`Validation at ${f.head}`); expect(body).toContain(`<!-- saurons-eye-pr:${receipt.id} -->`);
    expect(receipt).toMatchObject({ condition: "confirmed", head: f.head, repository: "fictional/project", target_branch: "main", branch: f.run.branch, pull: { number: 42 } });
    expect(f.uploads).toEqual([{ cwd: f.run.worktree!, repository: "fictional/project", branch: f.run.branch!, head: f.head }]);
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.implementation.delivery.pull_numbers).toEqual([42]);
    expect(detail.board).toMatchObject({ lane: "needs_you", activity: "awaiting_merge" });
    expect((await f.request(`/projects/${f.project.id}/queue`).then(r => r.json())).capacity.project_implementations).toBe(0);
    expect((await f.request(f.route + "/publish", proof).then(r => r.json())).id).toBe(receipt.id);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(1);
    expect(f.calls().every(call => call.scoped && !call.args.some(arg => /\/(merge|releases|deployments)$/.test(arg)))).toBe(true);
  } finally { await f.close(); }
}, 60_000);

test("GitHub's canonical repository casing still identifies the approved publication receipt", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.verify(); await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    f.github({ canonical_repository: "Fictional/Project" });
    const receipt = await f.request(f.route + "/publish", { head: f.head }).then(r => r.json());
    expect(receipt).toMatchObject({ condition: "confirmed", repository: "fictional/project", pull: { number: 42, url: "https://github.com/Fictional/Project/pull/42" } });
  } finally { await f.close(); }
}, 60_000);

test("failed configured checks cannot authorize acceptance or PR publication", async () => {
  const f = await factoryPublicationFixture({ checks: [["git", "rev-parse", "--verify", "refs/heads/missing-owned-ref"]] });
  try {
    expect((await f.request(`/runs/${f.run.id}/checks`, {}).then(r => r.json())).condition).toBe("failed");
    expect((await f.request(`/runs/${f.run.id}/accept`, { head: f.head })).status).toBe(409);
    expect((await f.request(f.route + "/publish", { head: f.head })).status).toBe(409);
    expect(f.uploads).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

test("a failing independent review cannot authorize acceptance or PR publication", async () => {
  const f = await factoryPublicationFixture();
  try {
    f.setReviewOutcome("failed"); await f.verify();
    const detail = await f.request(f.prefix).then(r => r.json());
    expect(detail.review_evidence.map((report: { outcome: string }) => report.outcome)).toEqual(["failed", "failed"]);
    expect((await f.request(`/runs/${f.run.id}/accept`, { head: f.head })).status).toBe(409);
    expect((await f.request(f.route + "/publish", { head: f.head })).status).toBe(409);
    expect(f.uploads).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

test("changed heads, workspace contents, branches, repositories and required checks block publication without remote writes", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.verify();
    const proof = { head: f.head };
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    await f.request(`/runs/${f.run.id}/accept`, proof);
    expect((await f.request(f.route + "/publish", { head: "0".repeat(40) })).status).toBe(409);
    const dirty = join(f.run.worktree!, "unreviewed.md"); writeFileSync(dirty, "Unreviewed owned change\n");
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409); rmSync(dirty);
    f.git(["branch", "-m", "unapproved-owned-branch"], f.run.worktree!);
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    f.git(["branch", "-m", f.run.branch!], f.run.worktree!);
    f.git(["remote", "set-url", "origin", "https://github.com/fictional/other.git"], f.run.worktree!);
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    f.git(["remote", "set-url", "origin", "https://github.com/fictional/project.git"], f.run.worktree!);
    await f.request(`/projects/${f.project.id}/configure`, { checks: [["git", "diff", "--exit-code"]] });
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    await f.request(`/projects/${f.project.id}/configure`, { checks: [["git", "status", "--porcelain"]] });
    writeFileSync(dirty, "Committed after acceptance\n"); f.git(["add", "unreviewed.md"], f.run.worktree!);
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "unreviewed commit"], f.run.worktree!);
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    expect((await f.request(f.route).then(r => r.json())).eligible).toBe(false);
    expect(f.uploads).toHaveLength(0);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

test("an uncertain implementation PR requires manual merge even when legacy GitHub automation would merge it", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.verify();
    await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    expect((await f.legacyPolicy()).status).toBe(200);
    // Implementation opt-in and existing PR policy do not authorize publication.
    expect(f.uploads).toHaveLength(0);
    expect((await f.request("").then(r => r.json())).projects[0].auto_publish_pr).toBe(false);
    f.github({ lose_receipt: true });
    const intent = await f.request(f.route + "/publish", { head: f.head }).then(r => r.json());
    expect(intent.condition).toBe("uncertain");
    const pull = structuredClone(fictionalGitHubPull);
    Object.assign(pull, { number: 42, id: "owned-implementation-pr", headRefOid: f.head, headRefName: f.run.branch, author: { login: "fictional-owner" }, body: `<!-- saurons-eye-pr:${intent.id} -->`, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", viewerCanUpdate: true });
    pull.reviewRequests.nodes = [];
    pull.reviews.nodes = [{ id: "owned-trusted-review", state: "APPROVED", body: "Reviewed", submittedAt: "2026-10-14T12:00:00Z", author: { login: "fictional-reviewer" }, commit: { oid: f.head } }];
    f.github({ graphql_pulls: [pull] });
    expect((await f.request(`/projects/${f.project.id}/github/sync`, {})).status).toBe(200);
    expect(f.calls().filter(call => call.args.some(arg => arg.endsWith("/merge")))).toHaveLength(0);
    expect((await f.request(f.prefix).then(r => r.json())).board.activity).toBe("awaiting_merge");
  } finally { await f.close(); }
}, 60_000);

test("restarting during branch upload retains an uncertain publication and never resumes creation automatically", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.verify();
    await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    f.afterUpload(async () => { f.restart(); });
    await f.request(f.route + "/publish", { head: f.head }).catch(() => null);
    const view = await f.request(f.route).then(r => r.json());
    expect(view.publication.condition).toBe("uncertain");
    expect((await f.request(f.route + "/publish", { head: f.head }).then(r => r.json())).id).toBe(view.publication.id);
    expect(f.uploads).toHaveLength(1);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(0);
    await f.request(f.route + "/reconcile", {});
    expect((await f.request(f.route).then(r => r.json())).publication.condition).toBe("prepared");
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(0);
    const resumed = await f.request(f.route + "/publish", { head: f.head }).then(r => r.json());
    expect(resumed).toMatchObject({ id: view.publication.id, condition: "confirmed", pull: { number: 42 } });
    expect(f.uploads).toHaveLength(1);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(1);
  } finally { await f.close(); }
}, 60_000);

test("reviewed runtime scaffolding cannot be published as Assignment changes", async () => {
  const f = await factoryPublicationFixture();
  try {
    writeFileSync(join(f.run.worktree!, ".saurons-eye-owned-fixture.json"), '{"fixture":true}');
    f.git(["add", ".saurons-eye-owned-fixture.json"], f.run.worktree!);
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "owned runtime data"], f.run.worktree!);
    const head = f.git(["rev-parse", "HEAD"], f.run.worktree!).trim(); f.setReviewHead(head);
    await f.verify();
    expect((await f.request(`/runs/${f.run.id}/accept`, { head })).status).toBe(200);
    expect((await f.request(f.route + "/publish", { head })).status).toBe(409);
    expect(f.uploads).toHaveLength(0);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

test("disabling automatic publication during upload prevents PR creation and retains the uncertain intent", async () => {
  const f = await factoryPublicationFixture();
  try {
    const projectRoute = `/projects/${f.project.id}/configure`;
    await f.request(projectRoute, { auto_publish_pr: true });
    await f.verify();
    f.afterUpload(async () => { await f.request(projectRoute, { auto_publish_pr: false }); });
    await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    expect((await f.request(f.route).then(r => r.json())).publication.condition).toBe("uncertain");
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(0);
    expect((await f.request(f.prefix).then(r => r.json())).implementation.outcome).toBe("implementation_complete");
  } finally { await f.close(); }
}, 60_000);

test("a lost PR receipt survives restart, blocks replay and reconciles the same remotely created PR", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.verify();
    await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
    f.github({ lose_receipt: true });
    const uncertain = await f.request(f.route + "/publish", { head: f.head }).then(r => r.json());
    expect(uncertain).toMatchObject({ condition: "uncertain", pull: null, head: f.head });
    f.restart();
    expect((await f.request(f.route).then(r => r.json())).publication.id).toBe(uncertain.id);
    expect((await f.request(f.route + "/publish", { head: f.head }).then(r => r.json())).condition).toBe("uncertain");
    const confirmed = await f.request(f.route + "/reconcile", {}).then(r => r.json());
    expect(confirmed).toMatchObject({ id: uncertain.id, condition: "confirmed", pull: { number: 42 } });
    expect(f.uploads).toHaveLength(1);
    expect(f.calls().filter(call => call.args.includes("--method"))).toHaveLength(1);
    expect((await f.request(f.prefix).then(r => r.json())).implementation.delivery.pull_numbers).toEqual([42]);
  } finally { await f.close(); }
}, 60_000);

test("a separate automatic publication opt-in publishes only after acceptance with passing checks and both reviews", async () => {
  const f = await factoryPublicationFixture();
  try {
    await f.request(`/projects/${f.project.id}/configure`, { auto_publish_pr: true });
    expect((await f.request(`/runs/${f.run.id}/accept`, { head: f.head })).status).toBe(409);
    expect(f.uploads).toHaveLength(0);
    await f.verify();
    expect((await f.request(`/runs/${f.run.id}/accept`, { head: f.head })).status).toBe(200);
    expect((await f.request(f.route).then(r => r.json())).publication).toMatchObject({ authority: "project", condition: "confirmed", head: f.head });
    expect(f.uploads).toHaveLength(1);
    expect((await f.request(f.prefix).then(r => r.json())).implementation.outcome).toBe("pr_open");
  } finally { await f.close(); }
}, 60_000);
