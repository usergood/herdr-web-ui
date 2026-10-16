import { expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { published, until } from "../scripts/factory-human-review-fixture.ts";

it("approves and verifies one checked Human Review merge without a spare agent slot", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const other = await f.assignment("Occupied merge capacity");
    await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "occupy" });
    const review = d.human_reviews[0];
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "approve-result" };
    const response = await f.api(`${prefix}/human-review/approve`, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ review_id: review.id, head: review.head, condition: "merged" });
    expect((await detail()).implementation).toMatchObject({ stage: "done", outcome: "merged" });
    f.restart();
    expect((await f.api(`${prefix}/human-review/approve`, body)).status).toBe(200);
    expect((await detail()).human_review_approvals).toHaveLength(1);
    expect(f.launches).toHaveLength(2);
  } finally { f.close(); }
}, 20000);

import { mergeFixture } from "../scripts/factory-merge-fixture.ts";

it("the Machine replaces only a positively unsent intent for fresh approval at an unchanged repaired head", async () => {
  for (const sent of [false, true]) {
    const f = await mergeFixture();
    try {
      if (sent) f.change({ lose: true }); else f.pull({ mergeStateStatus: "DIRTY" });
      const first = await f.post(f.route + "merge", f.body);
      expect(first.status).toBe(sent ? 200 : 409);
      const fresh = structuredClone(f.body);
      fresh.approval.id = crypto.randomUUID(); fresh.approval.idempotency_key = "fresh-owner-approval";
      fresh.approval.snapshot_id = crypto.randomUUID();
      f.pull({ mergeStateStatus: "CLEAN" }); f.restart();
      const response = await f.post(f.route + "merge", fresh);
      expect(response.status).toBe(sent ? 409 : 200);
      if (sent) expect((await response.json()).error.code).toBe("merge_authority_changed");
      else expect(await response.json()).toMatchObject({ condition: "merged", head: f.head });
      expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    } finally { f.close(); }
  }
}, 20000);

it("the owned Machine verifies a squash merge after a lost acknowledgment and restart without merging twice", async () => {
  const f = await mergeFixture();
  try {
    f.change({ lose: true });
    const first = await f.post(f.route + "merge", f.body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ condition: "uncertain" });
    f.restart();
    const second = await f.post(f.route + "merge", f.body);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ condition: "merged", head: f.head, merge_sha: f.git(["rev-parse", "main"]) });
    expect(f.git(["show", "main:result.txt"])).toBe("after");
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("a frozen release milestone remains incomplete until a published tag contains the verified merge", async () => {
  const f = await mergeFixture({ milestone: "release" });
  try {
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: "awaiting_release", release_tag: null });
    f.git(["tag", "old-release", f.base]); f.change({ release: "old-release" });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "awaiting_release" });
    f.git(["tag", "fixture-release", "main"]); f.change({ release: "fixture-release" });
    f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "released", release_tag: "fixture-release" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    expect(f.calls().some(args => args.includes("POST"))).toBe(false);
  } finally { f.close(); }
}, 20000);

it("retains a concrete repository refusal and never reports a permission denial as merged", async () => {
  const f = await mergeFixture();
  try {
    f.change({ deny: "Protected branch or permission refused" });
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "merge_denied", message: "GitHub refused this merge under its repository permissions, protection or conflict rules; inspect the PR before further action" } });
    f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "uncertain" });
    expect(f.git(["rev-parse", "main"])).toBe(f.base);
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("rejects approval when a newer configured check fails after the PR was published", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail, run } = await published(f);
    const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    f.failNextCheck();
    expect((await f.api(`/runs/${run.id}/checks`, {}).then(r => r.json())).condition).toBe("failed");
    const review = d.human_reviews[0];
    const response = await f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "failed-evidence" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "fresh_evidence_required" } });
    expect(f.mergeEffects).toHaveLength(0);
  } finally { f.close(); }
}, 20000);

it("does not bypass Human Review merge verification through legacy implementation acceptance", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { detail, run } = await published(f);
    const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const response = await f.api(`/runs/${run.id}/accept`, { head: d.human_reviews[0].head });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "human_review_required" } });
    expect((await detail()).implementation.stage).toBe("review");
  } finally { f.close(); }
}, 20000);

it("requires owner origin and exact review provenance and preserves existing draft comments", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail, run } = await published(f);
    const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = d.human_reviews[0];
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "draft-safe-approval" };
    const url = `http://localhost:${f.app.port}/api/factory${prefix}/human-review/approve`;
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${f.token}`, origin: "https://untrusted.invalid", "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) })).status).toBe(403);
    expect((await f.api(`${prefix}/human-review/approve`, { ...body, head: "f".repeat(40) })).status).toBe(409);
    expect((await f.agent(run.id, "human-review/approve", body)).status).not.toBe(200);
    expect((await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", change: "branch:M", side: "new", line_start: 1, line_end: 1, content: "Keep this complete feedback batch" })).status).toBe(201);
    const response = await f.api(`${prefix}/human-review/approve`, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "review_comments_pending" } });
    expect((await detail()).comments).toHaveLength(1);
    expect((await detail()).human_review_approvals).toHaveLength(0);
    expect(f.mergeEffects).toHaveLength(0);
  } finally { f.close(); }
}, 20000);

it("reconciles a lost merge reply after restart and never promotes merge-only evidence to a required release", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f, "release");
    const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = d.human_reviews[0];
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "lost-result" };
    f.loseNextMerge();
    const response = await f.api(`${prefix}/human-review/approve`, body);
    expect(response.status).toBe(200);
    expect((await response.json()).condition).toBe("uncertain");
    f.restart();
    const waiting = await until(detail, d => d.human_review_approvals?.[0]?.condition === "awaiting_release");
    expect(waiting.implementation).toMatchObject({ stage: "review", outcome: "merged" });
    expect((await f.api(`${prefix}/human-review/approve`, { ...body, idempotency_key: "same-candidate" })).status).toBe(200);
    expect((await detail()).human_review_approvals).toHaveLength(1);
    f.releaseMerged();
    await f.api(`${prefix}/human-review/approve`, body);
    const released = await until(detail, d => d.implementation.stage === "done");
    expect(released.implementation.outcome).toBe("released");
    expect(f.mergeEffects).toHaveLength(1);
    expect(f.launches).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("the Machine refuses protected/conflicting targets, stale candidates, untrusted evidence and forged authority", async () => {
  for (const scenario of ["protected", "conflict", "required-check", "changed-head", "changed-target", "wrong-source", "no-approval", "dirty"] as const) {
    const f = await mergeFixture();
    try {
      const body = structuredClone(f.body);
      if (scenario === "protected") f.pull({ mergeStateStatus: "BLOCKED" });
      if (scenario === "conflict") f.pull({ mergeStateStatus: "DIRTY" });
      if (scenario === "required-check") f.pull({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" });
      if (scenario === "changed-head") f.pull({ headRefOid: "f".repeat(40) });
      if (scenario === "changed-target") f.pull({ baseRefName: "other" });
      if (scenario === "wrong-source") body.reports[0]!.source_id = "forged-source";
      if (scenario === "no-approval") (body as any).approval = null;
      if (scenario === "dirty") f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Unreviewed change"]);
      const response = await f.post(f.route + "merge", body);
      expect(response.status).toBe(409);
      expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
      expect(f.git(["rev-parse", "main"])).toBe(f.base);
    } finally { f.close(); }
  }
}, 20000);

it("rejects approval after a fresh independent review finds a regression at the same published head", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail, run } = await published(f);
    const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const response = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "later-independent-review" });
    const reviewer = await response.json();
    f.workers.get(reviewer.id)!.condition = "ready"; f.reviewOutcomes.set(reviewer.id, "failed");
    const report = await f.api(`/runs/${run.id}/workers/${reviewer.id}/review-evidence`, {}).then(r => r.json());
    expect(report.outcome).toBe("failed");
    const review = d.human_reviews[0];
    expect((await f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "failed-review" })).status).toBe(409);
    expect(f.mergeEffects).toHaveLength(0);
  } finally { f.close(); }
}, 20000);

it("automatically observes a temporarily busy Machine merge without another approval", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = d.human_reviews[0];
    f.mergeFailure("merge_busy");
    const response = await f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "busy-merge" });
    expect((await response.json()).condition).toBe("uncertain");
    f.mergeFailure(null);
    const done = await until(detail, d => d.implementation.stage === "done");
    expect(done.human_review_approvals).toHaveLength(1);
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("preserves the frozen Project's trusted-reviewer count under repository protection", async () => {
  const f = await mergeFixture();
  try {
    f.pull({ author: { login: "fixture" }, baseRef: { branchProtectionRule: { isAdminEnforced: true, requiredApprovingReviewCount: 2 } }, reviews: { pageInfo: { hasNextPage: false }, nodes: [
      { state: "APPROVED", author: { login: "reviewer" }, commit: { oid: f.head } },
      { state: "APPROVED", author: { login: "other-reviewer" }, commit: { oid: f.head } },
    ] } });
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "merge_waiting" } });
    expect(f.git(["rev-parse", "main"])).toBe(f.base);
  } finally { f.close(); }
}, 20000);

it("verifies coverage of the authorized target branch even when a tag has the same name", async () => {
  const f = await mergeFixture();
  try {
    expect((await f.post(f.route + "merge", f.body)).status).toBe(200);
    f.git(["tag", "main", "refs/heads/main"]);
    f.git(["update-ref", "refs/heads/main", f.base]);
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "merge_coverage_unverified" } });
    expect(f.git(["rev-parse", "refs/heads/main"])).toBe(f.base);
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("blocks a pending merge when its checked evidence is superseded during GitHub observation", async () => {
  const f = await mergeFixture(); let pending: Promise<Response> | undefined;
  try {
    f.change({ hold_graphql: true });
    pending = f.post(f.route + "merge", f.body);
    await until(async () => f.githubState(), s => s.graphql_waiting === true);
    f.change({ fail_check: true });
    const next = await f.post(f.route + "check", { check: { ...f.check, id: crypto.randomUUID(), head: "", workspace_hash: "", commands: [], condition: "working" } });
    expect((await next.json()).condition).toBe("failed");
    f.change({ hold_graphql: false });
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "fresh_evidence_required" } });
    expect(f.git(["rev-parse", "refs/heads/main"])).toBe(f.base);
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
  } finally { f.change({ hold_graphql: false }); await pending?.catch(() => {}); f.close(); }
}, 20000);


it("retains approval while GitHub CI or reviews are pending and merges automatically when they pass", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = d.human_reviews[0];
    f.mergeFailure("merge_waiting");
    const response = await f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "pending-ci" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: "pending", observations: 0 });
    expect(f.mergeEffects).toHaveLength(0);
    f.restart();
    await until(detail, () => f.mergeObservations.length >= 7, 20000);
    expect((await detail()).human_review_approvals[0]).toMatchObject({ condition: "pending", observations: 0 });
    f.mergeFailure(null);
    const done = await until(detail, d => d.implementation.stage === "done");
    expect(done.human_review_approvals).toHaveLength(1);
    expect(done.human_review_approvals[0]).toMatchObject({ head: review.head, condition: "merged" });
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 30000);


it("the owned Machine distinguishes pending GitHub checks and reviews from failed checks", async () => {
  for (const waiting of ["ci", "review"] as const) {
    const f = await mergeFixture();
    try {
      if (waiting === "ci") f.pull({ mergeStateStatus: "BLOCKED", commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: "Required CI", status: "IN_PROGRESS", conclusion: null }], pageInfo: { hasNextPage: false } } } } }], pageInfo: { hasNextPage: false } } });
      else f.pull({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", reviewRequests: { nodes: [{ __typename: "User" }], pageInfo: { hasNextPage: false } } });
      const response = await f.post(f.route + "merge", f.body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "merge_waiting" } });
      expect(f.git(["rev-parse", "main"])).toBe(f.base);
      if (waiting === "ci") {
        f.pull({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: "Required CI", status: "COMPLETED", conclusion: "FAILURE" }], pageInfo: { hasNextPage: false } } } } }], pageInfo: { hasNextPage: false } } });
        expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ error: { code: "merge_blocked" } });
      }
      f.pull({ mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: "Required CI", status: "COMPLETED", conclusion: "SUCCESS" }], pageInfo: { hasNextPage: false } } } } }], pageInfo: { hasNextPage: false } } });
      expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "merged" });
      expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    } finally { f.close(); }
  }
}, 20000);


it("pending required CI remains recoverable while GitHub reports unstable or unknown mergeability", async () => {
  for (const state of ["UNSTABLE", "UNKNOWN"]) {
    const f = await mergeFixture();
    try {
      f.pull({ mergeStateStatus: state, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: "Required CI", status: "IN_PROGRESS", conclusion: null }], pageInfo: { hasNextPage: false } } } } }], pageInfo: { hasNextPage: false } } });
      expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ error: { code: "merge_waiting" } });
      expect(f.git(["rev-parse", "main"])).toBe(f.base);
    } finally { f.close(); }
  }
}, 20000);


it("the owned Machine retains one approval while branch-only required CI is running", async () => {
  const f = await mergeFixture();
  try {
    const protection = { isAdminEnforced: true, requiredApprovingReviewCount: 1, requiredStatusCheckContexts: ["Repository CI"] };
    const commits = (status: string, conclusion: string | null) => ({ nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { name: "Required CI", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Repository CI", status, conclusion },
    ], pageInfo: { hasNextPage: false } } } } }], pageInfo: { hasNextPage: false } });
    f.pull({ baseRef: { branchProtectionRule: protection }, mergeStateStatus: "BLOCKED", commits: commits("IN_PROGRESS", null) });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ error: { code: "merge_waiting" } });
    expect(f.git(["rev-parse", "main"])).toBe(f.base);
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
    f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ error: { code: "merge_waiting" } });
    f.pull({ mergeStateStatus: "CLEAN", commits: commits("COMPLETED", "SUCCESS") });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "merged" });
    f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "merged" });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);


it("the owned Machine observes missing or pending branch checks and blocks genuine failures even during review waits", async () => {
  for (const context of [null, { context: "Repository CI", state: "PENDING" }, { context: "Repository CI", state: "EXPECTED" }, { context: "Repository CI", state: "FAILURE" }, { name: "Repository CI", status: "COMPLETED", conclusion: "CANCELLED" }]) {
    const f = await mergeFixture();
    try {
      f.pull({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", baseRef: { branchProtectionRule: { isAdminEnforced: true, requiredApprovingReviewCount: 1, requiredStatusCheckContexts: ["Repository CI"] } }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
        { name: "Required CI", status: "COMPLETED", conclusion: "SUCCESS" }, ...(context ? [context] : []),
      ], pageInfo: { hasNextPage: false } } } } }], pageInfo: { hasNextPage: false } } });
      const failed = context && ("state" in context && context.state === "FAILURE" || "conclusion" in context && context.conclusion === "CANCELLED");
      expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ error: { code: failed ? "merge_blocked" : "merge_waiting" } });
      expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
      expect(f.git(["rev-parse", "main"])).toBe(f.base);
    } finally { f.close(); }
  }
}, 20000);
