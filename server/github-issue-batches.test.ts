import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { batchProposal, githubIssueBatchFixture } from "./github-issue-batches.fixture.ts";

const fixtures: Awaited<ReturnType<typeof githubIssueBatchFixture>>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
async function fixture() { const f = await githubIssueBatchFixture(); fixtures.push(f); return f; }

test("a planning proposal retains the whole deliverable graph for review without writing to GitHub", async () => {
  const f = await fixture();
  const proposed = await f.request(f.route, batchProposal);
  expect(proposed.status).toBe(201);
  expect(proposed.body.condition).toBe("proposed");
  expect(proposed.body.items).toEqual(batchProposal.items);
  expect(proposed.body.implementation_id).toBe(f.assignment.id);
  expect(proposed.body.dispatch_ready).toBe(false);
  const inspected = await f.request(f.route);
  expect(inspected.body.batches).toEqual([proposed.body]);
  expect(f.calls().filter(args => args.includes("POST") || args.includes("PATCH"))).toEqual([]);
  expect((await f.request(`/implementations/${f.assignment.id}`)).body.runs).toEqual([]);
});

test("the owner reviews an exact batch and Project policy revision before any publication", async () => {
  const f = await fixture();
  const policy = (await f.request(f.githubRoute + "/configure", f.policy)).body;
  const batch = (await f.request(f.route, batchProposal)).body;
  const proof = { revision: batch.revision, policy_revision: policy.revision };
  const denied = await f.request(`${f.route}/${batch.id}/publish`, proof);
  expect(denied.status).toBe(409);
  expect(denied.body.error.code).toBe("issue_batch_review_required");
  const reviewed = await f.request(`${f.route}/${batch.id}/review`, proof);
  expect(reviewed.status).toBe(200);
  expect(reviewed.body.condition).toBe("reviewed");
  expect(reviewed.body.review).toMatchObject({ revision: batch.revision, policy_revision: policy.revision, repository: "fictional/schedules", account_profile_id: f.policy.account_profile_id });
  expect(reviewed.body.dispatch_ready).toBe(false);
  expect(f.calls().filter(args => args.includes("POST") || args.includes("PATCH"))).toEqual([]);
  const edited = (await f.request(f.route, { ...batchProposal, batch_id: batch.id, expected_revision: batch.revision, title: "Revised deliverable plan" })).body;
  expect(edited.review).toBeNull();
  const stale = await f.request(`${f.route}/${batch.id}/review`, proof);
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe("issue_batch_changed");
});

test("explicit publication confirms issue identities and dependencies before releasing the batch", async () => {
  const f = await fixture();
  const policy = (await f.request(f.githubRoute + "/configure", { ...f.policy, auto_implement: true, triage_labels: { "ready-for-agent": "factory-ready" } })).body;
  const batch = (await f.request(f.route, batchProposal)).body;
  const proof = { revision: batch.revision, policy_revision: policy.revision };
  await f.request(`${f.route}/${batch.id}/review`, proof);
  const published = await f.request(`${f.route}/${batch.id}/publish`, proof);
  expect(published.status).toBe(200);
  expect(published.body.condition).toBe("confirmed");
  expect(published.body.dispatch_ready).toBe(true);
  expect(published.body.issues.map((issue: { key: string; number: number; links_confirmed: boolean }) => ({ key: issue.key, number: issue.number, links_confirmed: issue.links_confirmed }))).toEqual([{ key: "notes", number: 101, links_confirmed: true }, { key: "history", number: 102, links_confirmed: true }]);
  expect(published.body.intents.every((intent: { condition: string }) => intent.condition === "confirmed")).toBe(true);
  const github = (await f.request(f.githubRoute)).body;
  expect(github.sources).toHaveLength(2);
  const history = github.sources.find((source: { number: number }) => source.number === 102);
  expect(history.issue.body).toContain("https://github.com/fictional/schedules/issues/101");
  expect(history.issue.body).toContain(batch.id);
  expect(history.issue.body).toContain(batch.revision);
  expect(history.issue.body).toContain(`/#factory/${f.assignment.id}`);
  expect(history.readiness.approval.plan.dependencies).toEqual([{ repository: "fictional/schedules", issue_number: 101, requires: "merge" }]);
  expect(history.readiness.eligible).toBe(true);
  expect(history.issue.labels).toEqual(["factory-ready"]);
  for (const source of github.sources) expect((await f.request(`/implementations/${source.implementation_id}`)).body.runs).toEqual([]);
  const calls = f.calls().length;
  expect((await f.request(`${f.route}/${batch.id}/publish`, proof)).body.id).toBe(batch.id);
  expect(f.calls()).toHaveLength(calls);
  await f.request(f.githubRoute + "/sync", {});
  expect((await f.request(f.githubRoute)).body.sources).toHaveLength(2);
});

test("scope drift during publication holds every issue from dispatch even after readiness labels were applied", async () => {
  const f = await fixture();
  writeFileSync(f.responses, JSON.stringify({ drift_after_label: 102 }));
  const policy = (await f.request(f.githubRoute + "/configure", { ...f.policy, auto_implement: true })).body;
  const batch = (await f.request(f.route, batchProposal)).body;
  const proof = { revision: batch.revision, policy_revision: policy.revision };
  await f.request(`${f.route}/${batch.id}/review`, proof);
  const published = (await f.request(`${f.route}/${batch.id}/publish`, proof)).body;
  expect(published.condition).toBe("held");
  expect(published.dispatch_ready).toBe(false);
  expect(published.issues).toHaveLength(2);
  const sources = (await f.request(f.githubRoute)).body.sources;
  expect(sources).toHaveLength(2);
  for (const source of sources) {
    expect(source.readiness.eligible).toBe(false);
    expect(source.readiness.reasons).toContain("batch_incomplete");
  }
});

test("a partial publication retains successful issues, uncertain receipts and the whole-batch hold across restart", async () => {
  const f = await fixture();
  writeFileSync(f.responses, JSON.stringify({ fail_label_number: 102 }));
  const policy = (await f.request(f.githubRoute + "/configure", { ...f.policy, auto_implement: true })).body;
  const batch = (await f.request(f.route, batchProposal)).body;
  const proof = { revision: batch.revision, policy_revision: policy.revision };
  await f.request(`${f.route}/${batch.id}/review`, proof);
  const published = (await f.request(`${f.route}/${batch.id}/publish`, proof)).body;
  expect(published.condition).toBe("held");
  expect(published.issues).toHaveLength(2);
  expect(published.intents.some((intent: { item_key: string; condition: string }) => intent.item_key === "history" && intent.condition === "uncertain")).toBe(true);
  f.restart();
  expect((await f.request(f.route)).body.batches[0]).toEqual(published);
  const first = (await f.request(f.githubRoute)).body.sources.find((source: { number: number }) => source.number === 101);
  expect(first.readiness.approval.plan.acceptance_criteria).toBe("The owner's notes survive repeated imports.");
  expect(first.readiness.eligible).toBe(false);
  expect(first.readiness.reasons).toContain("batch_incomplete");
  const before = f.calls().length;
  expect((await f.request(`${f.route}/${batch.id}/publish`, proof)).body.error.code).toBe("issue_batch_uncertain");
  expect(f.calls()).toHaveLength(before);
  expect((await f.request(f.githubRoute)).body.sources).toHaveLength(2);
});

test("malformed proposals fail as invalid owner input without retaining a batch or sending remote mutations", async () => {
  const f = await fixture();
  const malformed = await f.request(f.route, { ...batchProposal, items: [null] });
  expect(malformed.status).toBe(400);
  expect(malformed.body.error.code).toBe("invalid_issue_batch");
  expect((await f.request(f.route)).body.batches).toEqual([]);
  expect(f.calls().some(args => args.includes("POST") || args.includes("PATCH"))).toBe(false);
});
