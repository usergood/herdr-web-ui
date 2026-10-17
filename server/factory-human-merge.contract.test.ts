import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { FactoryStore } from "./factory-store.ts";
import { join } from "node:path";
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
import { releaseBrowserFixture } from "../scripts/factory-release-browser-fixture.ts";

it("fences owner context while the remote Machine validates an approved merge", async () => {
  const f = await releaseBrowserFixture(); let pending: Promise<Response> | undefined;
  const post = (suffix: string, body: unknown) => fetch(`http://localhost:${f.app.port}${f.prefix}${suffix}`, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
  try {
    const ready = await f.detail(); const review = ready.human_reviews[0];
    expect(ready.human_review_approvals).toEqual([]);
    f.core.change({ hold_graphql: true });
    pending = post("/human-review/approve", { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "context-during-remote-validation" });
    await until(async () => f.core.githubState(), state => state.graphql_waiting === true);
    const question = await post("/questions", { question: "Should this scope also publish private credentials?" });
    const response = await question.json();
    expect(question.status).toBe(409);
    expect(response).toMatchObject({ error: { code: "merge_context_busy" } });
    const held = await f.detail();
    expect(held.question_revision).toBe(ready.question_revision);
    expect(held.questions).toEqual(ready.questions);
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
    f.core.change({ hold_graphql: false });
    expect((await pending).status).toBe(200);
    const merged = await until(f.detail, d => d.human_review_approvals[0]?.condition === "awaiting_release");
    expect(merged.human_review_approvals).toHaveLength(1);
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    const after = await post("/questions", { question: "Should this scope also publish private credentials?" });
    expect(after.status).toBe(201);
    expect(await after.json()).toMatchObject({ answer: null, question: "Should this scope also publish private credentials?" });
  } finally { f.core.change({ hold_graphql: false }); await pending?.catch(() => {}); await f.close(); }
}, 20000);

type ContextFixture = Awaited<ReturnType<typeof releaseBrowserFixture>>;
const contextPost = (f: ContextFixture, path: string, body: unknown) => fetch(`http://localhost:${f.app.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) });
const retainRestartOutcome = (request: Promise<Response>) => request.then(response => ({ response, error: null }), error => ({ response: null, error }));
const assertRestartOutcome = (outcome: Awaited<ReturnType<typeof retainRestartOutcome>>) => {
  if (outcome.error) expect(outcome.error.code).toBe("ECONNRESET");
  else expect(outcome.response!.status).toBe(409);
};
const contextApproval = async (f: ContextFixture, key: string) => {
  const review = (await f.detail()).human_reviews[0];
  return { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: key };
};

it.each(["restart", "lost_ack", "retained_wait"])("retains the exact merge-context fence through %s without replaying a merge", async scenario => {
  const f = await releaseBrowserFixture(); let pending: ReturnType<typeof retainRestartOutcome> | undefined;
  try {
    const body = await contextApproval(f, `durable-context-${scenario}`);
    const ready = await f.detail(); expect(ready.human_review_approvals).toEqual([]);
    if (scenario === "lost_ack") {
      f.core.change({ lose: true });
      const uncertain = await contextPost(f, f.prefix + "/human-review/approve", body);
      expect(uncertain.status).toBe(200);
      expect(await uncertain.json()).toMatchObject({ condition: "uncertain", head: f.core.head });
      expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
      f.core.change({ hold_graphql: true, graphql_waiting: false });
    } else {
      f.core.change({ hold_graphql: true });
      if (scenario === "retained_wait") f.core.pull({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" });
      pending = retainRestartOutcome(contextPost(f, f.prefix + "/human-review/approve", body));
      await until(async () => f.core.githubState(), state => state.graphql_waiting === true);
    }
    const retained = (await f.detail()).human_review_approvals[0];
    f.restartConnection();
    const blocked = await contextPost(f, f.prefix + "/questions", { question: "Retain this proposed scope until the remote merge settles" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "merge_context_busy" } });
    expect((await f.detail()).question_revision).toBe(ready.question_revision);
    f.core.change({ hold_graphql: false }); if (pending) assertRestartOutcome(await pending);
    if (scenario === "retained_wait") {
      await until(f.detail, d => d.human_review_approvals[0]?.condition === "pending" && d.human_review_approvals[0]?.reason?.includes("required GitHub"));
      const waiting = await contextPost(f, f.prefix + "/human-review/approve", body);
      expect(waiting.status).toBe(200); expect(await waiting.json()).toMatchObject({ condition: "pending", id: retained.id });
      expect((await contextPost(f, f.prefix + "/questions", { question: "Still retain scope while the older request was unknown" })).status).toBe(409);
      expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
      f.core.pull({ mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" });
    }
    await contextPost(f, f.prefix + "/human-review/approve", body);
    const delivered = await until(f.detail, d => d.human_review_approvals[0]?.condition === "awaiting_release");
    expect(delivered.human_review_approvals).toHaveLength(1);
    expect(delivered.human_review_approvals[0]).toMatchObject({ id: retained.id, idempotency_key: body.idempotency_key, head: f.core.head, context_revision: ready.question_revision });
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    for (const request of f.mergeRequests) expect(request.approval).toMatchObject({ id: retained.id, idempotency_key: body.idempotency_key, context_revision: ready.question_revision });
    expect((await contextPost(f, f.prefix + "/questions", { question: "A subsequent owner decision after confirmed merge" })).status).toBe(201);
  } finally { f.core.change({ hold_graphql: false }); if (pending) assertRestartOutcome(await pending); await f.close(); }
}, 20000);

it("a confirmed Stop cannot recreate a context fence for a prior unsent CI wait", async () => {
  const f = await releaseBrowserFixture();
  try {
    const body = await contextApproval(f, "ci-wait-then-stop");
    f.core.pull({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" });
    const approval = await contextPost(f, f.prefix + "/human-review/approve", body);
    expect(approval.status).toBe(200); const receipt = await approval.json(); expect(receipt.condition).toBe("pending");
    const stopped = await contextPost(f, `/api/factory/runs/${f.core.id}/stop`, {});
    expect(stopped.status).toBe(200); expect(await stopped.json()).toMatchObject({ id: f.core.id, condition: "cancelled" });
    f.restartConnection();
    const observed = await contextPost(f, f.prefix + "/human-review/approve", body);
    expect(observed.status).toBe(200); expect(await observed.json()).toMatchObject({ id: receipt.id, condition: "blocked" });
    const question = await contextPost(f, f.prefix + "/questions", { question: "Retained scope after verified Stop" });
    expect(question.status).toBe(201);
    const detail = await f.detail(); expect(detail.human_review_approvals).toHaveLength(1);
    expect(detail.human_review_approvals[0]).toMatchObject({ id: receipt.id, idempotency_key: receipt.idempotency_key, provenance: receipt.provenance, head: receipt.head });
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
  } finally { await f.close(); }
}, 20000);

it("a positively denied fresh merge remains context-mutable across restart", async () => {
  const f = await releaseBrowserFixture();
  try {
    const body = await contextApproval(f, "denied-context-recovery");
    f.core.change({ deny: "Owned repository permission denial" });
    const response = await contextPost(f, f.prefix + "/human-review/approve", body);
    expect(response.status).toBe(200); const denied = await response.json();
    expect(denied).toMatchObject({ condition: "blocked", head: f.core.head });
    expect(f.core.git(["rev-parse", "main"])).toBe(f.core.base);
    expect((await contextPost(f, f.prefix + "/questions", { question: "Retained question after positive denial" })).status).toBe(201);
    f.restartConnection();
    expect((await contextPost(f, f.prefix + "/questions", { question: "Further context after restart of denied merge" })).status).toBe(201);
    const current = await f.detail(); expect(current.human_review_approvals).toHaveLength(1);
    expect(current.human_review_approvals[0]).toMatchObject({ id: denied.id, idempotency_key: denied.idempotency_key, head: denied.head, provenance: denied.provenance });
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
    expect(f.core.git(["rev-parse", "main"])).toBe(f.core.base);
  } finally { await f.close(); }
}, 20000);

it.each(["text", "confirmation"])("restored legacy %s answers cannot mutate context during an unknown remote merge", async answerKind => {
  const f = await releaseBrowserFixture(); let pending: ReturnType<typeof retainRestartOutcome> | undefined; let stopping: Promise<Response> | undefined;
  try {
    const body = await contextApproval(f, `legacy-context-${answerKind}`);
    f.core.change({ hold_graphql: true });
    pending = retainRestartOutcome(contextPost(f, f.prefix + "/human-review/approve", body));
    await until(async () => f.core.githubState(), state => state.graphql_waiting === true);
    const retained = (await f.detail()).human_review_approvals[0];
    f.restartConnection();
    // Historical fixture restoration only: authority above was created by the real public button API.
    const store = new FactoryStore(f.stateDir); const created = new Date(Date.now() - 60000).toISOString();
    const question = { ...store.record(), created_at: created, updated_at: created, implementation_id: f.id, run_id: f.core.id, question: "An unanswered question retained by an older bridge", answer_kind: answerKind, answer: null, revision: crypto.randomUUID() };
    store.put("questions", question, f.id); store.close();
    const before = await f.detail();
    const answered = await contextPost(f, `${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Retained caller answer" });
    expect(answered.status).toBe(409); expect(await answered.json()).toMatchObject({ error: { code: "merge_context_busy" } });
    if (answerKind === "text") {
      f.setTranscript({ source_id: "owned-release-history", version: "owner-reply", cursor: null, turns: [{ role: "user", ts: new Date(Date.parse(created) + 1000).toISOString(), parts: [{ kind: "text", text: "A genuine retained native owner reply" }] }] });
      const sync = await contextPost(f, `/api/factory/runs/${f.core.id}/import-conversation`, {});
      expect(sync.status).toBe(409); expect(await sync.json()).toMatchObject({ error: { code: "merge_context_busy" } });
    } else {
      const shared = await contextPost(f, f.prefix + "/approvals", { kind: "shared_understanding", revision: before.question_revision, scope: "Confirm this exact retained shared understanding" });
      expect(shared.status).toBe(409); expect(await shared.json()).toMatchObject({ error: { code: "merge_context_busy" } });
    }
    const unchanged = await f.detail();
    expect(unchanged.question_revision).toBe(before.question_revision);
    expect(unchanged.questions).toEqual(before.questions); expect(unchanged.approvals).toEqual(before.approvals);
    expect(unchanged.events.filter((event: any) => ["owner_answered", "owner_approved", "native_question_answered"].includes(event.kind))).toEqual(before.events.filter((event: any) => ["owner_answered", "owner_approved", "native_question_answered"].includes(event.kind)));
    const oldRequest = f.mergeRequests[0];
    stopping = contextPost(f, `/api/factory/runs/${f.core.id}/stop`, {});
    await until(async () => f.core.post(`factory-host/runs/${f.core.id}/reconcile`, {}).then(r => r.json()), d => d.condition === "disconnected");
    f.core.change({ hold_graphql: false }); assertRestartOutcome(await pending);
    const stopped = await stopping; expect(stopped.status).toBe(200); expect(await stopped.json()).toMatchObject({ condition: "cancelled", id: f.core.id });
    expect((await f.core.post(f.core.route + "merge", oldRequest)).status).toBe(409);
    await f.restart();
    expect((await f.core.post(f.core.route + "merge", oldRequest)).status).toBe(409);
    const after = await contextPost(f, `${f.prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Retained caller answer" });
    expect(after.status).toBe(200);
    const final = await f.detail(); expect(final.human_review_approvals).toHaveLength(1);
    expect(final.human_review_approvals[0]).toMatchObject({ id: retained.id, head: retained.head, idempotency_key: retained.idempotency_key, provenance: retained.provenance });
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
  } finally { f.core.change({ hold_graphql: false }); if (pending) assertRestartOutcome(await pending); await stopping?.catch(() => {}); await f.close(); }
}, 20000);

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
      f.pull({ baseRef: { branchProtectionRule: { isAdminEnforced: false, requiredApprovingReviewCount: 1, requiredStatusCheckContexts: ["Required CI"] } } });
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

it("preserves the frozen Project's trusted-reviewer count when administrators are exempt", async () => {
  const f = await mergeFixture();
  try {
    f.pull({ author: { login: "fixture" }, baseRef: { branchProtectionRule: { isAdminEnforced: false, requiredApprovingReviewCount: 2 } }, reviews: { pageInfo: { hasNextPage: false }, nodes: [
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


it("the owned Machine retains one approval while branch-only required CI is running with administrators exempt", async () => {
  const f = await mergeFixture();
  try {
    const protection = { isAdminEnforced: false, requiredApprovingReviewCount: 1, requiredStatusCheckContexts: ["Repository CI"] };
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
      f.pull({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", baseRef: { branchProtectionRule: { isAdminEnforced: false, requiredApprovingReviewCount: 1, requiredStatusCheckContexts: ["Repository CI"] } }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
        { name: "Required CI", status: "COMPLETED", conclusion: "SUCCESS" }, ...(context ? [context] : []),
      ], pageInfo: { hasNextPage: false } } } } }], pageInfo: { hasNextPage: false } } });
      const failed = context && ("state" in context && context.state === "FAILURE" || "conclusion" in context && context.conclusion === "CANCELLED");
      expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ error: { code: failed ? "merge_blocked" : "merge_waiting" } });
      expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
      expect(f.git(["rev-parse", "main"])).toBe(f.base);
    } finally { f.close(); }
  }
}, 20000);


it("the owned Machine merges a fully eligible protected candidate when administrators are exempt", async () => {
  const f = await mergeFixture();
  try {
    f.pull({ baseRef: { branchProtectionRule: { isAdminEnforced: false, requiredApprovingReviewCount: 1, requiredStatusCheckContexts: ["Required CI"] } } });
    const response = await f.post(f.route + "merge", f.body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ condition: "merged", head: f.head, merge_sha: f.git(["rev-parse", "refs/heads/main"]) });
    expect(f.git(["show", "refs/heads/main:result.txt"])).toBe("after");
    f.restart();
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "merged", head: f.head });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

// GitHub accepts these completed CheckRun conclusions as successful required checks.
it("the Machine merges completed successful required-check conclusions exactly once under exact authority", async () => {
  for (const conclusion of ["SUCCESS", "NEUTRAL", "SKIPPED"]) {
    const f = await mergeFixture();
    try {
      f.pull({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: "Required CI", status: "COMPLETED", conclusion }], pageInfo: { hasNextPage: false } } } } }], pageInfo: { hasNextPage: false } } });
      const stale = structuredClone(f.body); stale.approval.head = "f".repeat(40);
      const refused = await f.post(f.route + "merge", stale);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "merge_authority_changed" } });
      expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
      const response = await f.post(f.route + "merge", f.body);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ condition: "merged", head: f.head });
      f.restart();
      expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "merged", head: f.head });
      expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
      expect(f.git(["show", "main:result.txt"])).toBe("after");
    } finally { f.close(); }
  }
}, 20000);

it("the Machine retains pending checks and blocks unsuccessful conclusions without broadening commit-status success", async () => {
  const scenarios = [
    { context: { name: "Required CI", status: "IN_PROGRESS", conclusion: "NEUTRAL" }, code: "merge_waiting" },
    { context: { name: "Required CI", status: "QUEUED", conclusion: "SKIPPED" }, code: "merge_waiting" },
    { context: { name: "Required CI", status: "COMPLETED", conclusion: "FAILURE" }, code: "merge_blocked" },
    { context: { name: "Required CI", status: "COMPLETED", conclusion: "CANCELLED" }, code: "merge_blocked" },
    { context: { name: "Required CI", status: "COMPLETED", conclusion: "TIMED_OUT" }, code: "merge_blocked" },
    { context: { name: "Required CI", status: "COMPLETED", conclusion: "ACTION_REQUIRED" }, code: "merge_blocked" },
    { context: { name: "Required CI", status: "COMPLETED", conclusion: null }, code: "merge_blocked" },
    { context: { context: "Required CI", state: "PENDING" }, code: "merge_waiting" },
    { context: { context: "Required CI", state: "EXPECTED" }, code: "merge_waiting" },
    { context: { context: "Required CI", state: "FAILURE" }, code: "merge_blocked" },
    { context: { context: "Required CI", state: "ERROR" }, code: "merge_blocked" },
    { context: { context: "Required CI", state: "NEUTRAL" }, code: "merge_blocked" },
    { context: { context: "Required CI", state: "SKIPPED" }, code: "merge_blocked" },
  ];
  for (const scenario of scenarios) {
    const f = await mergeFixture();
    try {
      f.pull({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [scenario.context], pageInfo: { hasNextPage: false } } } } }], pageInfo: { hasNextPage: false } } });
      const response = await f.post(f.route + "merge", f.body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: scenario.code } });
      expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(0);
      expect(f.git(["rev-parse", "main"])).toBe(f.base);
    } finally { f.close(); }
  }
}, 30000);

it("the Machine continues to accept a successful required commit-status context", async () => {
  const f = await mergeFixture();
  try {
    f.pull({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ context: "Required CI", state: "SUCCESS" }], pageInfo: { hasNextPage: false } } } } }], pageInfo: { hasNextPage: false } } });
    expect(await f.post(f.route + "merge", f.body).then(r => r.json())).toMatchObject({ condition: "merged", head: f.head });
    expect(f.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.close(); }
}, 20000);


it("preserves delivered Done during a new Human Review discussion and a delayed assistant launch", async () => {
  for (const delayed of [false, true]) {
    const f = await capacityFixture({ advancingHeads: true }); f.setTranscript({ source_id: "delivered-discussion", version: "one", cursor: null, turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: "Retained discussion" }] }] }); let release: (() => void) | undefined;
    try {
      const { prefix, detail } = await published(f);
      const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const review = d.human_reviews[0];
      const approve = () => f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "delivered-discussion" });
      if (!delayed) expect((await approve()).status).toBe(200);
      const gate = delayed ? f.holdNextAllocation() : null; release = gate?.release;
      expect((await f.api(`${prefix}/human-review/messages`, { review_id: review.id, content: "Explain the delivered change", idempotency_key: "explain-delivered" })).status).toBe(202);
      if (gate) { await gate.started; expect((await approve()).status).toBe(200); gate.release(); }
      let discussed = await until(detail, d => d.human_review_deliveries?.[0]?.condition === "sent");
      expect(discussed.implementation).toMatchObject({ stage: "done", outcome: "merged" });
      expect(discussed.human_review_approvals[0].condition).toBe("merged");
      expect(discussed.runs.find((r: any) => r.action === "implement-spec").condition).toBe("completed");
      expect((await f.api(`${prefix}/archive`, {})).status).toBe(409);
      expect((await f.api(`${prefix}/pause`, {})).status).toBe(200);
      expect((await detail()).implementation.stage).toBe("done");
      expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
      f.runs.get(discussed.human_reviews[0].assistant_run_id)!.condition = "ready";
      f.restart();
      discussed = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review" && r.condition === "ready"));
      expect(discussed.implementation.stage).toBe("done");
      expect((await f.api(`${prefix}/delete`, {}).then(r => r.json())).condition).toBe("deleted");
      expect((await f.api(prefix)).status).toBe(404);
    } finally { release?.(); f.close(); }
  }
}, 30000);


it("finishes delivered execution and archives without manual Stop while retaining complete native history", async () => {
  const f = await capacityFixture({ advancingHeads: true, runTranscript: (_run, before) => ({ source_id: "delivered-history", version: before ? "older" : "latest", cursor: before ? null : "earlier", turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: before ? "Earlier implementation decisions" : "Delivered implementation result" }] }] }) });
  try {
    const { prefix, detail, run } = await published(f);
    const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = d.human_reviews[0];
    expect((await f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "deliver-and-archive" })).status).toBe(200);
    const delivered = await detail();
    expect(delivered.implementation).toMatchObject({ stage: "done", outcome: "merged" });
    expect(delivered.runs.find((r: any) => r.id === run.id).condition).toBe("completed");
    expect(delivered.native_snapshots.flatMap((s: any) => s.turns.flatMap((t: any) => t.parts.map((p: any) => p.text)))).toContain("Earlier implementation decisions");
    expect(delivered.native_snapshots.flatMap((s: any) => s.turns.flatMap((t: any) => t.parts.map((p: any) => p.text)))).toContain("Delivered implementation result");
    expect((await f.api(`${prefix}/archive`, {})).status).toBe(200);
    f.restart();
    const retained = await detail();
    expect(retained.implementation.archived_at).toBeTruthy();
    expect(retained.review_evidence).toHaveLength(2);
    expect(retained.native_snapshots.length).toBeGreaterThanOrEqual(delivered.native_snapshots.length);
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 20000);


it("settles a restored legacy context fence only after positive verified release observation", async () => {
  const f = await releaseBrowserFixture(); let pending: Promise<Response> | undefined;
  try {
    const body = await contextApproval(f, "legacy-release-fence");
    const first = await contextPost(f, f.prefix + "/human-review/approve", body); expect(first.status).toBe(200); const receipt = await first.json();
    expect(receipt.condition).toBe("awaiting_release");
    // Model only legacy fault metadata after genuine owner approval and a Machine-verified merge.
    f.app.stop(); const retained = new FactoryStore(f.stateDir);
    retained.put("human_review_approvals", { ...receipt, condition: "blocked", reason: "The owner context changed", next_observation_at: 0 }, f.id);
    retained.remove("merge_context_fences", receipt.id); retained.close();
    f.core.change({ hold_graphql: true }); f.restartConnection();
    pending = contextPost(f, f.prefix + "/human-review/approve", body);
    await until(async () => f.core.githubState(), state => state.graphql_waiting === true);
    const proposed = { question: "A later owner discussion after verified merge" };
    expect((await contextPost(f, f.prefix + "/questions", proposed)).status).toBe(409);
    f.core.change({ hold_graphql: false }); expect((await pending).status).toBe(200);
    const observed = await until(f.detail, d => d.human_review_approvals[0]?.condition === "awaiting_release");
    expect(observed.human_review_approvals[0]).toMatchObject({ id: receipt.id, context_revision: receipt.context_revision, merge_sha: receipt.merge_sha });
    expect((await contextPost(f, f.prefix + "/questions", proposed)).status).toBe(201);
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { f.core.change({ hold_graphql: false }); await pending?.catch(() => {}); await f.close(); }
}, 20000);

it("uses only the original verified Machine intent when live checks and workspace change", async () => {
  const f = await releaseBrowserFixture();
  try {
    const body = await contextApproval(f, "read-only-release-observation");
    const response = await contextPost(f, f.prefix + "/human-review/approve", body); expect(response.status).toBe(200); const receipt = await response.json();
    expect(receipt.condition).toBe("awaiting_release");
    f.core.change({ fail_check: true });
    const changedCheck = await f.core.post(f.core.route + "check", { check: { ...f.core.check, id: crypto.randomUUID(), commands: [], condition: "working" }, worker_id: null });
    const changedEvidence = await changedCheck.json();
    expect(changedCheck.status, JSON.stringify(changedEvidence)).toBe(200);
    expect(changedEvidence).toMatchObject({ head: f.core.head, condition: "failed" });
    f.core.git(["checkout", "--detach", f.core.base]);
    f.core.git(["tag", "owned-frozen-release", receipt.merge_sha]); f.core.change({ release: "owned-frozen-release" });
    const original = f.mergeRequests[0]!;
    const observed = await f.core.post(f.core.route + "merge", { ...original, approval: receipt, pull_request: { ...original.pull_request, check_id: "newer-unrelated-check", evidence_ids: [] }, check_id: "newer-unrelated-check", workspace_hash: "changed-live-workspace", evidence_ids: [], reports: [] });
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({ head: receipt.head, merge_sha: receipt.merge_sha, condition: "released", release_tag: "owned-frozen-release" });
    expect(f.core.git(["rev-parse", "HEAD"])).toBe(f.core.base);
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { await f.close(); }
}, 20000);

it.each(["prepared", "sending", "invalid-sha"])("refuses forged release observation of a %s intent without sending another merge", async condition => {
  const f = await releaseBrowserFixture();
  try {
    if (condition === "sending") f.core.change({ lose: true });
    else f.core.pull({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" });
    const body = await contextApproval(f, `refuse-observation-${condition}`);
    const response = await contextPost(f, f.prefix + "/human-review/approve", body); expect(response.status).toBe(200); const receipt = await response.json();
    expect(receipt.condition).toBe(condition === "sending" ? "uncertain" : "pending");
    const before = f.core.calls().filter(args => args[1]?.endsWith("/merge")).length;
    const original = f.mergeRequests[0]!;
    const observed = await f.core.post(f.core.route + "merge", { ...original, approval: { ...receipt, condition: "awaiting_release", merge_sha: condition === "invalid-sha" ? "invalid" : f.core.head } });
    expect(observed.status).toBe(409); expect(await observed.json()).toMatchObject({ error: { code: "merge_authority_changed" } });
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(before);
  } finally { await f.close(); }
}, 20000);

it("retains a typed release-observation fault and clears it under the original verified approval", async () => {
  const f = await releaseBrowserFixture();
  try {
    const body = await contextApproval(f, "release-observation-recovery");
    const response = await contextPost(f, f.prefix + "/human-review/approve", body); expect(response.status).toBe(200); const receipt = await response.json();
    expect(receipt.condition).toBe("awaiting_release"); expect(receipt.reason_is_error ?? false).toBe(false);
    f.core.change({ truncated_tree: true });
    const failed = await contextPost(f, f.prefix + "/human-review/approve", body); expect(failed.status).toBe(200); const fault = await failed.json();
    expect(fault).toMatchObject({ id: receipt.id, condition: "awaiting_release", merge_sha: receipt.merge_sha, reason_is_error: true });
    expect(fault.reason).toEqual(expect.any(String));
    f.core.git(["tag", "owned-release-recovered", receipt.merge_sha]); f.core.change({ truncated_tree: false, release: "owned-release-recovered" });
    await f.restart();
    const completed = await until(f.detail, d => d.human_review_approvals[0]?.condition === "released" && d.runs.find((run: any) => run.id === f.core.id)?.condition === "completed");
    expect(completed.human_review_approvals).toHaveLength(1);
    expect(completed.human_review_approvals[0]).toMatchObject({ id: receipt.id, context_revision: receipt.context_revision, head: receipt.head, merge_sha: receipt.merge_sha, condition: "released", reason: null, reason_is_error: false });
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { await f.close(); }
}, 20000);

it.each(["current", "historical-blocked"])("observes the original verified release after later owner context changes (%s) without another approval or merge", async state => {
  const f = await releaseBrowserFixture();
  try {
    const body = await contextApproval(f, "original-release-authority");
    const response = await contextPost(f, f.prefix + "/human-review/approve", body);
    expect(response.status).toBe(200); const approved = await response.json();
    expect(approved.condition).toBe("awaiting_release");
    const questionResponse = await contextPost(f, f.prefix + "/questions", { question: "Does this already merged result retain the approved scope?" });
    expect(questionResponse.status).toBe(201); const question = await questionResponse.json();
    const answer = await contextPost(f, f.prefix + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Yes, the approved scope is unchanged." });
    expect(answer.status).toBe(200);
    if (state === "historical-blocked") {
      // Restore only the old fault condition after a genuine public approval and verified Machine merge.
      f.app.stop(); const retained = new FactoryStore(f.stateDir);
      retained.put("human_review_approvals", { ...approved, condition: "blocked", reason: "The owner context changed; retain fresh evidence" }, f.id); retained.close();
    }
    f.core.git(["tag", "owned-postmerge-release", approved.merge_sha]); f.core.change({ release: "owned-postmerge-release" });
    await f.restart();
    const completed = await until(f.detail, d => state !== "historical-blocked" && d.human_review_approvals[0]?.condition === "blocked" || d.human_review_approvals[0]?.condition === "released" && d.runs.find((run: any) => run.id === f.core.id)?.condition === "completed", 45000);
    expect(completed.human_review_approvals).toHaveLength(1);
    expect(completed.human_review_approvals[0]).toMatchObject({ id: approved.id, idempotency_key: approved.idempotency_key, head: approved.head, context_revision: approved.context_revision, merge_sha: approved.merge_sha, condition: "released", release_tag: "owned-postmerge-release" });
    expect(completed.implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect(completed.runs.find((run: any) => run.id === f.core.id).condition).toBe("completed");
    expect(f.core.calls().filter(args => args[1]?.endsWith("/merge"))).toHaveLength(1);
  } finally { await f.close(); }
}, 45000);

it("retains verified delivery through unavailable history and uncertain shutdown, then completes without another merge", async () => {
  for (const problem of ["history", "shutdown", "lost-shutdown"] as const) {
    let historyAvailable = true;
    const f = await capacityFixture({ advancingHeads: true, runTranscript: () => historyAvailable ? { source_id: "delivery-recovery", version: "one", cursor: null, turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: "Complete retained implementation history" }] }] } : null });
    try {
      const { prefix, detail, run } = await published(f);
      const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = d.human_reviews[0];
      if (problem === "history") historyAvailable = false;
      if (problem === "shutdown") f.unavailableRunStop(true);
      if (problem === "lost-shutdown") f.loseNextRunStop();
      expect((await f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "recover-completion" })).status).toBe(200);
      const pending = await detail();
      expect(pending.implementation).toMatchObject({ stage: "done", outcome: "merged" });
      expect(pending.human_review_approvals[0].condition).toBe("merged");
      expect(pending.runs.find((r: any) => r.id === run.id).condition).not.toBe("completed");
      expect(pending.events.some((e: any) => e.kind === "delivery_completion_pending")).toBe(true);
      expect(pending.runs.find((r: any) => r.id === run.id).delivery_completion_error).toEqual(expect.any(String));
      expect((await f.api(`${prefix}/archive`, {})).status).toBe(409);
      if (problem === "history") {
        const current = await f.api(`${prefix}?view=current`).then(r => r.json());
        expect(current.runs.find((r: any) => r.id === run.id).delivery_completion_error).toBe(pending.runs.find((r: any) => r.id === run.id).delivery_completion_error);
        const fault = pending.runs.find((r: any) => r.id === run.id).delivery_completion_error;
        expect(current.board.delivery_completion_error).toBe(fault);
        const overview = await f.api("").then(r => r.json());
        expect(overview.board.find((item: any) => item.implementation_id === f.runs.get(run.id)!.implementation_id).delivery_completion_error).toBe(fault);
        expect(overview.progress.find((item: any) => item.implementation_id === f.runs.get(run.id)!.implementation_id).error_reasons).toContain(fault);
        const navigation = await f.api("?navigation=1").then(r => r.json());
        expect(navigation.board.find((item: any) => item.implementation_id === f.runs.get(run.id)!.implementation_id).delivery_completion_error).toBe(fault);
        await f.api(`/runs/${run.id}/reconcile`, {});
        expect((await detail()).runs.find((r: any) => r.id === run.id).delivery_completion_error).toBe(pending.runs.find((r: any) => r.id === run.id).delivery_completion_error);
      }
      const observations = f.mergeObservations.length;
      historyAvailable = true; f.unavailableRunStop(false); f.restart();
      const completed = await until(detail, d => d.runs.find((r: any) => r.id === run.id)?.condition === "completed");
      expect(completed.human_review_approvals[0].condition).toBe("merged");
      expect(completed.runs.find((r: any) => r.id === run.id).delivery_completion_error).toBeUndefined();
      expect((await f.api(`${prefix}?view=current`).then(r => r.json())).board.delivery_completion_error).toBeUndefined();
      expect((await f.api(`${prefix}/archive`, {})).status).toBe(200);
      expect(f.mergeEffects).toHaveLength(1);
      expect(f.mergeObservations).toHaveLength(observations);
    } finally { f.close(); }
  }
}, 30000);

it("keeps execution open until a frozen containing-release milestone is actually verified", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  f.setTranscript({ source_id: "release-delivery", version: "one", cursor: null, turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: "Retain release implementation" }] }] });
  try {
    const { prefix, detail, run } = await published(f, "release");
    const d = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = d.human_reviews[0];
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "release-completion" };
    expect((await f.api(`${prefix}/human-review/approve`, body)).status).toBe(200);
    const waiting = await detail();
    expect(waiting.implementation.stage).toBe("review");
    expect(waiting.human_review_approvals[0].condition).toBe("awaiting_release");
    expect(waiting.runs.find((r: any) => r.id === run.id).condition).toBe("ready");
    expect(waiting.events.some((e: any) => e.kind === "delivery_execution_completed")).toBe(false);
    expect((await f.api(`${prefix}/archive`, {})).status).toBe(409);
    f.releaseMerged(); await f.api(`${prefix}/human-review/approve`, body);
    const released = await until(detail, d => d.runs.find((r: any) => r.id === run.id)?.condition === "completed");
    expect(released.implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect((await f.api(`${prefix}/archive`, {})).status).toBe(200);
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("does not retain Human Review merge authority while an owner scope question is unanswered", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    const questionResponse = await f.api(`${prefix}/questions`, { question: "New scope: should this result also export progress?" });
    expect(questionResponse.status).toBe(201);
    const question = await questionResponse.json();
    const response = await f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "unanswered-owner-scope" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "answers_unready" } });
    const blocked = await detail();
    expect(blocked.questions).toContainEqual(expect.objectContaining({ id: question.id, answer: null }));
    expect(blocked.human_review_approvals).toHaveLength(0);
    expect(blocked.implementation.stage).toBe("review");
    expect(blocked.runs[0].condition).not.toBe("completed");
    expect(f.mergeObservations).toHaveLength(0);
    expect(f.mergeEffects).toHaveLength(0);
  } finally { f.close(); }
}, 20000);

it("requires fresh reviewed owner context after an answered scope question changes the candidate context", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    const question = await f.api(`${prefix}/questions`, { question: "New scope: retain the original export format?" }).then(r => r.json());
    expect((await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Retain the original format; review this decision" })).status).toBe(200);
    const response = await f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "changed-answered-context" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "fresh_evidence_required" } });
    const blocked = await detail();
    expect(blocked.questions).toContainEqual(expect.objectContaining({ id: question.id, answer: "Retain the original format; review this decision" }));
    expect(blocked.question_revision).not.toBe(ready.question_revision);
    expect(blocked.human_review_approvals).toHaveLength(0);
    expect(blocked.implementation.stage).toBe("review");
    expect(f.mergeEffects).toHaveLength(0);
    const oldWorkers = new Set(ready.workers.map((worker: { id: string }) => worker.id));
    for (const axis of ["standards", "spec"]) {
      const current = await until(detail, d => d.workers.some((worker: any) => worker.role === axis && !oldWorkers.has(worker.id) && worker.condition === "working"), 6000);
      const worker = current.workers.find((worker: any) => worker.role === axis && !oldWorkers.has(worker.id) && worker.condition === "working");
      const contract = await f.agent(ready.human_reviews[0].run_id, "contract").then(response => response.json());
      expect(contract.question_revision).toBe(blocked.question_revision);
      expect((await f.agent(ready.human_reviews[0].run_id, "consume", { revision: contract.question_revision, worker_id: worker.id })).status).toBe(200);
      f.workers.get(worker.id)!.condition = "ready";
    }
    const fresh = await until(detail, d => d.automatic_review[0]?.condition === "published" && d.automatic_review[0]?.context_revision === blocked.question_revision);
    expect(fresh.automatic_review[0].check_id).not.toBe(ready.automatic_review[0].check_id);
    expect(fresh.automatic_review[0].evidence_ids.every((id: string) => !ready.automatic_review[0].evidence_ids.includes(id))).toBe(true);
    expect(fresh.human_reviews[0]).toMatchObject({ id: review.id, head: review.head, snapshot_id: review.snapshot_id });
    expect(f.mergeEffects).toHaveLength(0);
    expect(fresh.human_review_approvals).toHaveLength(0);
    const approved = await f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "fresh-reviewed-owner-context" });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ context_revision: blocked.question_revision, condition: "merged" });
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

it("pins retained merge authority to the exact owner context and rechecks questions after the Machine head wait", async () => {
  const f = await capacityFixture({ advancingHeads: true }); let release = () => {}; let pending: Promise<Response> | undefined;
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    const gate = f.holdNextHead(); release = gate.release;
    pending = f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "question-during-head" });
    await gate.started;
    const retained = await detail();
    const question = await f.api(`${prefix}/questions`, { question: "New scope while head is observed: export this result?" }).then(r => r.json());
    release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(retained.human_review_approvals[0]).toMatchObject({ context_revision: ready.question_revision, condition: "pending" });
    expect(await response.json()).toMatchObject({ context_revision: ready.question_revision, condition: "blocked", reason: expect.stringContaining("pending owner questions") });
    const blocked = await detail();
    expect(blocked.questions).toContainEqual(expect.objectContaining({ id: question.id, answer: null }));
    expect(blocked.implementation.stage).toBe("review");
    expect(blocked.runs[0].condition).not.toBe("completed");
    expect(f.mergeObservations).toHaveLength(0);
    expect(f.mergeEffects).toHaveLength(0);
  } finally { release(); await pending?.catch(() => {}); f.close(); }
}, 20000);

it("fails closed on restored pending authority without a frozen owner-context revision", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "legacy-pending-context" };
    f.mergeFailure("merge_waiting");
    const receipt = await f.api(`${prefix}/human-review/approve`, body).then(r => r.json());
    expect(receipt).toMatchObject({ condition: "pending", context_revision: ready.question_revision });
    f.mergeFailure(null);
    f.restart(() => {
      // Arrange an older saved receipt only after shutdown and before createServer starts.
      const db = new Database(join(f.state, "factory", "records.sqlite"));
      try { db.query("UPDATE records SET data=json_remove(data, '$.context_revision') WHERE kind='human_review_approvals' AND id=?").run(receipt.id); }
      finally { db.close(); }
    });
    const stopped = await until(detail, d => ["blocked", "merged"].includes(d.human_review_approvals[0]?.condition));
    expect(stopped.human_review_approvals[0]).toMatchObject({ id: receipt.id, condition: "blocked", reason: expect.stringContaining("owner context") });
    expect(stopped.human_review_approvals[0].context_revision).toBeUndefined();
    expect(stopped.implementation.stage).toBe("review");
    expect(f.mergeObservations).toHaveLength(1);
    expect(f.mergeEffects).toHaveLength(0);
    await f.api(`${prefix}/human-review/approve`, { ...body, idempotency_key: "do-not-rebind-legacy" });
    expect((await detail()).human_review_approvals).toHaveLength(1);
    expect((await detail()).human_review_approvals[0].context_revision).toBeUndefined();
    expect(f.mergeEffects).toHaveLength(0);
  } finally { f.close(); }
}, 20000);

for (const answered of [false, true]) it(`blocks retained pending CI authority after a new ${answered ? "answered" : "unanswered"} owner question without rebinding it`, async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: `pending-context-${answered}` };
    f.mergeFailure("merge_waiting");
    const receipt = await f.api(`${prefix}/human-review/approve`, body).then(r => r.json());
    expect(receipt).toMatchObject({ condition: "pending", context_revision: ready.question_revision, merge_not_sent: true });
    const question = await f.api(`${prefix}/questions`, { question: "New owner decision while CI is pending: export this result?" }).then(r => r.json());
    if (answered) expect((await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "No export; review this answer before delivery" })).status).toBe(200);
    f.mergeFailure(null);
    f.restart();
    const stopped = await until(detail, d => ["blocked", "merged"].includes(d.human_review_approvals[0]?.condition));
    expect(stopped.human_review_approvals[0]).toMatchObject({ id: receipt.id, context_revision: ready.question_revision, condition: "blocked", merge_not_sent: true, reason: expect.stringContaining(answered ? "owner context" : "pending owner questions") });
    expect(stopped.questions).toContainEqual(expect.objectContaining({ id: question.id, answer: answered ? "No export; review this answer before delivery" : null }));
    expect(stopped.implementation.stage).toBe("review");
    expect(stopped.events.some((event: any) => event.kind === "answers_consumed")).toBe(false);
    expect(f.mergeObservations).toHaveLength(1);
    expect(f.mergeEffects).toHaveLength(0);
    const replay = await f.api(`${prefix}/human-review/approve`, body).then(r => r.json());
    expect(replay).toMatchObject({ id: receipt.id, context_revision: ready.question_revision, condition: "blocked" });
    expect((await detail()).human_review_approvals).toHaveLength(1);
    expect(f.mergeObservations).toHaveLength(1);
    expect(f.mergeEffects).toHaveLength(0);
    if (answered) {
      const ids = new Set(ready.workers.map((worker: { id: string }) => worker.id));
      for (const axis of ["standards", "spec"]) {
        const current = await until(detail, d => d.workers.some((worker: any) => worker.role === axis && !ids.has(worker.id) && worker.condition === "working"));
        const worker = current.workers.find((worker: any) => worker.role === axis && !ids.has(worker.id) && worker.condition === "working");
        const contract = await f.agent(review.run_id, "contract").then(response => response.json());
        expect((await f.agent(review.run_id, "consume", { revision: contract.question_revision, worker_id: worker.id })).status).toBe(200);
        f.workers.get(worker.id)!.condition = "ready";
      }
      const fresh = await until(detail, d => d.automatic_review[0]?.condition === "published" && d.automatic_review[0]?.context_revision === stopped.question_revision);
      expect(f.mergeEffects).toHaveLength(0);
      const response = await f.api(`${prefix}/human-review/approve`, { ...body, idempotency_key: "fresh-after-owner-context" });
      expect(response.status).toBe(200);
      const renewed = await response.json();
      expect(renewed).toMatchObject({ condition: "merged", context_revision: fresh.question_revision });
      expect(renewed.id).not.toBe(receipt.id);
      const done = await detail();
      expect(done.human_review_approvals).toHaveLength(2);
      expect(done.human_review_approvals[0]).toMatchObject({ id: receipt.id, idempotency_key: body.idempotency_key, context_revision: ready.question_revision, condition: "blocked", merge_not_sent: true });
      expect(f.mergeEffects).toHaveLength(1);
    }
  } finally { f.close(); }
}, 20000);

it("keeps fresh owner context fenced while its new evidence generation is being checked", async () => {
  const f = await capacityFixture({ advancingHeads: true }); let gate: ReturnType<typeof f.holdNextHead> | undefined;
  try {
    const { prefix, detail, run } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    const question = await f.api(`${prefix}/questions`, { question: "Confirm unchanged behavior before refreshed review" }).then(response => response.json());
    gate = f.holdNextHead();
    expect((await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Keep the accepted behavior and review this context" })).status).toBe(200);
    await gate.started;
    const boundary = await detail();
    expect(boundary.automatic_review[0].context_revision).toBe(boundary.question_revision);
    expect(boundary.pull_requests[0].check_id).toBe(ready.pull_requests[0].check_id);
    const authority = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head };
    const plain = await f.api(`${prefix}/human-review/approve`, { ...authority, idempotency_key: "premature-refresh" });
    expect(plain.status).toBe(409);
    expect((await plain.json()).error.code).toBe("fresh_evidence_required");
    const comment = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Retain this anchored draft through refresh" }).then(response => response.json());
    const comments = await f.api(`${prefix}/human-review/submit`, { ...authority, disposition: "approve", comment_ids: [comment.id], idempotency_key: "premature-refresh-comments" });
    expect(comments.status).toBe(409);
    expect((await detail()).human_review_approvals).toHaveLength(0);
    expect((await detail()).human_feedback_batches).toHaveLength(0);
    expect(f.mergeEffects).toHaveLength(0);
    gate.release();
    for (const axis of ["standards", "spec"]) {
      const current = await until(detail, d => d.workers.some((worker: any) => worker.role === axis && !ready.workers.some((old: any) => old.id === worker.id) && worker.condition === "working"));
      const worker = current.workers.find((worker: any) => worker.role === axis && worker.condition === "working");
      const contract = await f.agent(run.id, "contract").then(response => response.json());
      expect((await f.agent(run.id, "consume", { revision: contract.question_revision, worker_id: worker.id })).status).toBe(200);
      f.workers.get(worker.id)!.condition = "ready";
    }
    const fresh = await until(detail, d => d.automatic_review[0]?.condition === "published" && d.automatic_review[0]?.context_revision === boundary.question_revision);
    expect(fresh.comments).toContainEqual(expect.objectContaining({ id: comment.id, snapshot_id: review.snapshot_id, status: "draft" }));
    expect(fresh.human_reviews[0].snapshot_id).toBe(review.snapshot_id);
    expect(f.mergeEffects).toHaveLength(0);
  } finally { gate?.release(); f.close(); }
}, 20000);

for (const pause of [false, true]) it(`retains a fresh-context check across ${pause ? "Pause and Resume" : "restart and a lost acknowledgment"} without replaying completed work`, async () => {
  const f = await capacityFixture({ advancingHeads: true }); let gate: ReturnType<typeof f.holdNextCheck> | undefined;
  try {
    const { prefix, detail, run } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const originalChecks = [...f.executedChecks]; const originalWorkers = [...f.workerLaunches];
    const question = await f.api(`${prefix}/questions`, { question: "Confirm the original behavior after publication" }).then(response => response.json());
    gate = f.holdNextCheck("integration");
    if (!pause) f.loseNextCheck();
    expect((await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Keep the original behavior; freshly verify it" })).status).toBe(200);
    await gate.started;
    const checking = await detail(); const check = checking.checks.at(-1);
    expect(check.id).not.toBe(ready.pull_requests[0].check_id);
    expect(check.condition).toBe("working");
    if (pause) expect((await f.api(`${prefix}/pause`, {}).then(response => response.json())).pause.condition).toBe("paused");
    f.restart();
    if (pause) {
      expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
      await until(detail, d => !d.runs.find((candidate: any) => candidate.id === run.id).suspension);
      f.runs.get(run.id)!.condition = "ready";
    } else {
      const retained = await until(detail, d => d.automatic_review[0]?.condition === "waiting");
      expect(retained.automatic_review[0].reason).toContain("fresh-context check");
      expect(f.executedChecks).toEqual([...originalChecks, check.id]);
      expect(retained.checks.at(-1).id).toBe(check.id);
    }
    gate.release();
    for (const axis of ["standards", "spec"]) {
      const current = await until(detail, d => d.workers.some((worker: any) => worker.role === axis && !ready.workers.some((old: any) => old.id === worker.id) && worker.condition === "working"));
      const worker = current.workers.find((worker: any) => worker.role === axis && worker.condition === "working");
      const contract = await f.agent(run.id, "contract").then(response => response.json());
      expect((await f.agent(run.id, "consume", { revision: contract.question_revision, worker_id: worker.id })).status).toBe(200);
      f.workers.get(worker.id)!.condition = "ready";
    }
    const fresh = await until(detail, d => d.automatic_review[0]?.condition === "published" && d.automatic_review[0]?.context_revision === checking.question_revision);
    expect(fresh.checks.find((candidate: any) => candidate.id === check.id).condition).toBe(pause ? "cancelled" : "passed");
    expect(f.executedChecks).toHaveLength(originalChecks.length + (pause ? 2 : 1));
    expect(f.workerLaunches.slice(0, originalWorkers.length)).toEqual(originalWorkers);
    expect(fresh.workers.filter((worker: any) => worker.role === "implementer")).toHaveLength(1);
    expect(fresh.human_reviews[0].snapshot_id).toBe(ready.human_reviews[0].snapshot_id);
    expect(fresh.human_review_approvals).toHaveLength(0);
    expect(f.publications.size).toBe(1); expect(f.mergeEffects).toHaveLength(0);
  } finally { gate?.release(); f.close(); }
}, 30000);
