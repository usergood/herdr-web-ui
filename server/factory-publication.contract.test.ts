import { expect, it, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { factoryDeliveryFixture } from "./factory-delivery.fixture.ts";
import { machinePublicationFixture as publicationFixture, factoryPublicationFixture } from "./factory-publication.fixture.ts";
import { fictionalGitHubPull } from "../site/demo/github-fixtures.ts";


const routingCases = (["initial", "repaired"] as const).flatMap(candidate =>
  (["insteadOf", "pushInsteadOf"] as const).flatMap(kind =>
    (["local", "global", "system"] as const).map(scope => ({ candidate, kind, scope }))));
it.each(routingCases)("the $candidate automatic publication refuses $scope Git $kind routing before mutating either destination", async ({ candidate, kind, scope }) => {
  const f = await publicationFixture();
  try {
    let body = f.body, head = f.head;
    if (candidate === "repaired") {
      expect((await f.post(f.route + "publish", f.body)).status).toBe(409);
      expect((await f.post(f.route + "publish", f.body)).status).toBe(200);
      const repaired = await f.repair(); body = repaired.repairBody; head = repaired.repairedHead;
    }
    const intendedBefore = execFileSync("git", ["--git-dir", f.bare, "for-each-ref", "--format=%(objectname) %(refname)"], { encoding: "utf8" });
    const before = readFileSync(f.calls, "utf8"); f.rewrite(kind, scope);
    expect(f.git(["config", "--show-scope", "--get-regexp", "^url"]).startsWith(scope)).toBe(true);
    const response = await f.post(f.route + "publish", body); const result = await response.json();
    // Ref evidence is checked before the response: GitHub may reject only after an unsafe push.
    expect(f.redirectedRefs()).toBe("");
    expect(execFileSync("git", ["--git-dir", f.bare, "for-each-ref", "--format=%(objectname) %(refname)"], { encoding: "utf8" })).toBe(intendedBefore);
    expect(response.status).toBe(409); expect(result).toMatchObject({ error: { code: "publication_routing_changed" } });
    const requests = readFileSync(f.calls, "utf8").slice(before.length);
    expect(requests).not.toContain('"POST"'); expect(requests).not.toContain('"PATCH"');
    f.clearRewrites(); f.restart();
    // Reuse the same checked request; no replacement authority or evidence is needed.
    expect((await f.post(f.route + "publish", body)).status).toBe(409);
    expect(await f.post(f.route + "publish", body).then(r => r.json())).toMatchObject({ head, number: 27 });
    expect(execFileSync("git", ["--git-dir", f.bare, "rev-parse", `refs/heads/${f.branch}`], { encoding: "utf8" }).trim()).toBe(head);
    expect(f.redirectedRefs()).toBe("");
  } finally { f.close(); }
}, 20000);

it.each(["initial", "repaired"] as const)("the %s automatic publication rechecks Git routing after a held GitHub lookup", async candidate => {
  const f = await publicationFixture(); let publishing: Promise<Response> | undefined;
  try {
    let body = f.body;
    if (candidate === "repaired") {
      expect((await f.post(f.route + "publish", f.body)).status).toBe(409);
      expect((await f.post(f.route + "publish", f.body)).status).toBe(200);
      body = (await f.repair()).repairBody;
    }
    const before = readFileSync(f.calls, "utf8"); writeFileSync(f.control, JSON.stringify({ hold_lookup: true }));
    publishing = f.post(f.route + "publish", body); await waitFor(() => existsSync(f.waiting));
    f.rewrite("pushInsteadOf", "global"); writeFileSync(f.release, "release");
    const response = await publishing; expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "publication_routing_changed" } });
    expect(f.redirectedRefs()).toBe("");
    const requests = readFileSync(f.calls, "utf8").slice(before.length);
    expect(requests).not.toContain('"POST"'); expect(requests).not.toContain('"PATCH"');
  } finally { writeFileSync(f.release, "release"); await publishing?.catch(() => {}); f.close(); }
}, 20000);

it("the owned Machine publishes the exact commit and reconciles a lost GitHub create acknowledgment without another POST", async () => {
  const f = await publicationFixture();
  const { calls, id, route, body, head, branch, bare, post } = f;
  try {
    const untrusted = await fetch(`http://localhost:${f.app.port}/api/${route}publish`, { method: "POST", headers: { authorization: "Bearer owned-publication", "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
    expect(untrusted.status).toBe(403);
    const forged = await post(route + "publish", { ...body, check_id: "unverified-check" });
    expect((await forged.json()).error.code).toBe("fresh_evidence_required");
    const first = await post(route + "publish", body);
    expect(first.status).toBe(409);
    f.restart();
    const second = await post(route + "publish", body);
    const result = await second.json();
    expect(result).not.toHaveProperty("error");
    expect(second.status).toBe(200);
    expect(result).toMatchObject({ run_id: id, head, number: 27, base_branch: "main" });
    expect((await post(route + "publish", body)).status).toBe(200);
    expect(readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(args => args.includes("POST"))).toHaveLength(1);
    // Verify the effect through Git's public interface, never the factory store.
    expect(execFileSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim()).toBe(head);
    expect((await post(route + "publish", { ...body, head: "f".repeat(40) })).status).toBe(409);
    const { repairedHead, repairBody } = await f.repair();
    await post(route + "publish", repairBody); // Lost PATCH acknowledgment must reconcile without replay.
    f.restart();
    const updated = await post(route + "publish", repairBody);
    expect(await updated.json()).toMatchObject({ run_id: id, head: repairedHead, number: 27 });
    expect(updated.status).toBe(200);
    expect(execFileSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim()).toBe(repairedHead);
    const requests = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(args => args.includes("POST"))).toHaveLength(1);
    expect(requests.filter(args => args.includes("PATCH"))).toHaveLength(1);

  } finally { f.close(); }
}, 20000);

it.each(["initial", "repaired"] as const)("the %s publication push excludes reachable release tags despite repository followTags", async (candidate) => {
  const f = await publicationFixture();
  try {
    let body = f.body;
    let head = f.head;
    if (candidate === "repaired") {
      expect((await f.post(f.route + "publish", f.body)).status).toBe(409);
      expect((await f.post(f.route + "publish", f.body)).status).toBe(200);
      const repaired = await f.repair();
      body = repaired.repairBody;
      head = repaired.repairedHead;
    }
    f.git(["config", "push.followTags", "true"]);
    f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "tag", "-a", "v999.0.0-owned-publication-fixture", "-m", "Owned unpublished release fixture", head]);
    // Both create and repair lose their acknowledgment; retry must observe the same receipt.
    expect((await f.post(f.route + "publish", body)).status).toBe(409);
    f.restart();
    const observed = await f.post(f.route + "publish", body);
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({ head, number: 27 });
    expect(execFileSync("git", ["--git-dir", f.bare, "rev-parse", `refs/heads/${f.branch}`], { encoding: "utf8" }).trim()).toBe(head);
    expect(execFileSync("git", ["--git-dir", f.bare, "for-each-ref", "--format=%(refname)", "refs/tags/"], { encoding: "utf8" }).trim()).toBe("");
    const mutations = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(mutations.filter(args => args.includes("POST"))).toHaveLength(1);
    expect(mutations.filter(args => args.includes("PATCH"))).toHaveLength(candidate === "repaired" ? 1 : 0);
  } finally { f.close(); }
}, 20000);

it.each([
  [undefined, "feat(factory): Fixture"],
  ["Improve fictional publication", "feat(factory): Improve fictional publication"],
  ["fix(review): retain the exact candidate", "fix(review): retain the exact candidate"],
  ["feat(factory)!: change the fictional contract", "feat(factory)!: change the fictional contract"],
] as const)("publication title %s has the required scope without nesting a valid title", async (assignmentTitle, expected) => {
  const f = await publicationFixture(assignmentTitle);
  try {
    expect((await f.post(f.route + "publish", f.body)).status).toBe(409);
    f.restart();
    expect((await f.post(f.route + "publish", f.body)).status).toBe(200);
    const creates = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(args => args.includes("POST"));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain(`title=${expected}`);
  } finally { f.close(); }
}, 20000);

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Owned publication observation deadline"); await Bun.sleep(10); }
}

it("Stop retains publication held at its final account check and prevents PR creation afterward", async () => {
  const f = await publicationFixture(); let publishing: Promise<Response> | undefined; let stopping: Promise<Response> | undefined;
  try {
    writeFileSync(f.control, JSON.stringify({ hold_account: true }));
    publishing = f.post(f.route + "publish", f.body); await waitFor(() => existsSync(f.waiting));
    let stopAnswered = false;
    stopping = f.post(`factory-host/runs/${f.id}/stop`, {}).then(response => { stopAnswered = true; return response; });
    await waitFor(() => f.closed);
    // The fake native boundary proves Stop took ownership before the final account gate opens.
    writeFileSync(f.release, "release");
    const stopped = await stopping; expect(stopped.status).toBe(200); expect(await stopped.json()).toMatchObject({ condition: "cancelled" });
    const refused = await publishing; expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: { code: "run_stopping" } });
    const mutations = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(args => args.includes("POST") || args.includes("PATCH"));
    expect(mutations).toHaveLength(0); expect(stopAnswered).toBe(true);
  } finally { writeFileSync(f.release, "release"); await publishing?.catch(() => {}); await stopping?.catch(() => {}); f.close(); }
}, 20000);

it("Stop waits for an already dispatched uncertain PR create before releasing its owned Run", async () => {
  const f = await publicationFixture(); let publishing: Promise<Response> | undefined; let stopping: Promise<Response> | undefined;
  try {
    writeFileSync(f.control, JSON.stringify({ hold_mutation: true }));
    publishing = f.post(f.route + "publish", f.body); await waitFor(() => existsSync(f.waiting));
    stopping = f.post(`factory-host/runs/${f.id}/stop`, {}); await waitFor(() => f.closed);
    const retained = await f.post(`factory-host/runs/${f.id}/reconcile`, {}).then(r => r.json());
    expect(retained.condition).not.toBe("cancelled");
    writeFileSync(f.release, "release");
    const uncertain = await publishing; expect(uncertain.status).toBe(409); expect(await uncertain.json()).toMatchObject({ error: { code: "publication_uncertain" } });
    expect(await (await stopping).json()).toMatchObject({ condition: "cancelled" });
    f.restart(); expect((await f.post(f.route + "publish", f.body)).status).toBe(409);
    const mutations = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(args => args.includes("POST"));
    expect(mutations).toHaveLength(1);
    expect(execFileSync("git", ["--git-dir", f.bare, "rev-parse", `refs/heads/${f.branch}`], { encoding: "utf8" }).trim()).toBe(f.head);
  } finally { writeFileSync(f.release, "release"); await publishing?.catch(() => {}); await stopping?.catch(() => {}); f.close(); }
}, 20000);

it("Stop prevents a repaired PR PATCH after its final account verification resumes", async () => {
  const f = await publicationFixture(); let publishing: Promise<Response> | undefined; let stopping: Promise<Response> | undefined;
  try {
    expect((await f.post(f.route + "publish", f.body)).status).toBe(409);
    expect((await f.post(f.route + "publish", f.body)).status).toBe(200);
    const { repairedHead, repairBody } = await f.repair();
    writeFileSync(f.control, JSON.stringify({ hold_account: true }));
    publishing = f.post(f.route + "publish", repairBody); await waitFor(() => existsSync(f.waiting));
    stopping = f.post(`factory-host/runs/${f.id}/stop`, {}); await waitFor(() => f.closed);
    writeFileSync(f.release, "release");
    expect(await (await stopping).json()).toMatchObject({ condition: "cancelled" });
    const refused = await publishing;
    const mutations = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(mutations.filter(args => args.includes("POST"))).toHaveLength(1);
    expect(mutations.filter(args => args.includes("PATCH"))).toHaveLength(0);
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: { code: "run_stopping" } });
    expect(execFileSync("git", ["--git-dir", f.bare, "rev-parse", `refs/heads/${f.branch}`], { encoding: "utf8" }).trim()).toBe(repairedHead);
  } finally { writeFileSync(f.release, "release"); await publishing?.catch(() => {}); await stopping?.catch(() => {}); f.close(); }
}, 20000);

it("Stop also retains publication waiting for its initial frozen account verification", async () => {
  const f = await publicationFixture(); let publishing: Promise<Response> | undefined; let stopping: Promise<Response> | undefined;
  try {
    writeFileSync(f.control, JSON.stringify({ arm_user: true }));
    publishing = f.post(f.route + "publish", f.body); await waitFor(() => existsSync(f.waiting));
    stopping = f.post(`factory-host/runs/${f.id}/stop`, {}); await waitFor(() => f.closed);
    expect((await f.post(`factory-host/runs/${f.id}/reconcile`, {}).then(r => r.json())).condition).not.toBe("cancelled");
    writeFileSync(f.release, "release");
    expect((await publishing).status).toBe(409);
    expect(await (await stopping).json()).toMatchObject({ condition: "cancelled" });
    expect(readFileSync(f.calls, "utf8")).not.toContain('"POST"');
    expect(readFileSync(f.calls, "utf8")).not.toContain('"PATCH"');
  } finally { writeFileSync(f.release, "release"); await publishing?.catch(() => {}); await stopping?.catch(() => {}); f.close(); }
}, 20000);

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
  const held = f.holdParentPrompt();
  try {
    const proof = { head: f.head, title: "fix(factory): retain the reviewed result", body: "Completed work previously remained ambiguous. Preserve the accepted final change and its evidence." };
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    const reviewerResponse = await f.request(`/runs/${f.run.id}/workers`, { role: "standards", idempotency_key: "publication-standards" });
    expect(reviewerResponse.ok).toBe(true);
    const reviewer = await reviewerResponse.json();
    expect(reviewer).toMatchObject({ run_id: f.run.id, role: "standards" });
    expect((await f.request(`/runs/${f.run.id}/workers/${reviewer.id}/reconcile`, {})).ok).toBe(true);
    expect((await f.request(`/runs/${f.run.id}/reconcile`, {})).ok).toBe(true);
    await Promise.race([held.waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("Owned parent continuation did not reach native prompt")), 8000))]);
    const sending = await f.request(f.prefix).then(response => response.json());
    expect(sending.runs.find((run: { id: string }) => run.id === f.run.id)).toMatchObject({ id: f.run.id, condition: "accepted", continuation: { kind: "children", condition: "sending" } });
    expect((await f.request(`/runs/${f.run.id}/workers/${reviewer.id}/review-evidence`, {})).status).toBe(409);
    expect((await f.request(f.route + "/publish", proof)).status).toBe(409);
    expect(f.uploads).toHaveLength(0);
    // Releasing native delivery does not immediately settle the coordinator's reservation.
    held.release();
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
  } finally { held.release(); await f.close(); }
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


test("Machine PR publication rejects a foreign owner origin before dispatch", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "publication-origin-"));
  const app = createServer({ port: 0, stateDir, token: "", machines: false, factory: { accountDiscoveryHome: stateDir, native: { version: async () => null } } });
  try {
    const response = await fetch(`http://localhost:${app.port}/api/factory-host/publication`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1", origin: "https://foreign.example.invalid" }, body: "{}" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_origin" } });
  } finally { app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
