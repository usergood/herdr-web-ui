import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { published, until } from "../scripts/factory-human-review-fixture.ts";

describe("Human Review Decline through authenticated HTTP", () => {
  it("yields a discussion whose candidate was submitted during Machine admission", async () => {
    const f = await capacityFixture({ advancingHeads: true }); let release: (() => void) | undefined;
    try {
      const { prefix, detail } = await published(f);
      const original = (await until(detail, d => d.human_reviews?.[0]?.condition === "ready")).human_reviews[0];
      const gate = f.holdNextAdmission(); release = gate.release;
      await f.api(`${prefix}/human-review/messages`, { review_id: original.id, content: "Discuss after admission", idempotency_key: "admission-discussion" });
      await gate.started;
      const comment = await f.api(`${prefix}/comments`, { snapshot_id: original.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Submit before admission finishes" }).then(r => r.json());
      expect((await f.api(`${prefix}/human-review/submit`, { review_id: original.id, snapshot_id: original.snapshot_id, head: original.head, disposition: "decline", comment_ids: [comment.id], idempotency_key: "admission-decline" })).status).toBe(202);
      gate.release();
      const next = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review") || d.workers.some((w: any) => w.review_origin === "human" && w.condition === "working"));
      expect(next.human_reviews[0].condition).toBe("repairing");
      expect(next.runs.some((r: any) => r.conversation_kind === "human_review")).toBe(false);
      expect(next.human_review_deliveries[0].condition).toBe("queued");
    } finally { release?.(); f.close(); }
  }, 20000);
  for (const lostResponse of [false, true]) it(`returns submitted repairs after a delayed assistant launch with ${lostResponse ? "lost" : "confirmed"} acknowledgment`, async () => {
    const f = await capacityFixture({ advancingHeads: true });
    let release: (() => void) | undefined;
    try {
      const { prefix, detail } = await published(f);
      const original = (await until(detail, d => d.human_reviews?.[0]?.condition === "ready")).human_reviews[0];
      const gate = f.holdNextAllocation(); release = gate.release;
      if (lostResponse) f.loseNextLaunch();
      const discussion = { review_id: original.id, content: "Explain before fixing", idempotency_key: "delayed-discussion" };
      const message = await f.api(`${prefix}/human-review/messages`, discussion).then(r => r.json());
      const assistantId = await gate.started;
      const comment = await f.api(`${prefix}/comments`, { snapshot_id: original.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Repair while discussion is starting" }).then(r => r.json());
      const submission = { review_id: original.id, snapshot_id: original.snapshot_id, head: original.head, disposition: "decline", comment_ids: [comment.id], idempotency_key: "decline-during-launch" };
      const response = await f.api(`${prefix}/human-review/submit`, submission);
      expect(response.status).toBe(202); const batch = await response.json();
      expect((await detail()).human_reviews[0].condition).toBe("repairing");
      gate.release();
      const delivered = await until(detail, d => d.human_review_deliveries.some((m: any) => m.id === message.id && ["sent", "uncertain"].includes(m.condition)));
      expect(delivered.human_review_deliveries.find((m: any) => m.id === message.id).condition).toBe(lostResponse ? "uncertain" : "sent");
      expect(delivered.human_reviews[0]).toMatchObject({ id: original.id, condition: "repairing", assistant_run_id: assistantId });
      f.runs.get(assistantId)!.condition = "ready";
      await f.api(`/runs/${assistantId}/reconcile`, {});
      f.restart();
      expect((await f.api(`${prefix}/human-review/submit`, submission).then(r => r.json())).id).toBe(batch.id);
      for (const role of ["implementer", "standards", "spec"]) {
        const d = await until(detail, d => d.workers.some((w: any) => w.role === role && w.condition === "working"));
        f.workers.get(d.workers.find((w: any) => w.role === role && w.condition === "working").id)!.condition = "ready";
      }
      const repaired = await until(detail, d => d.human_reviews[0].condition === "ready" && d.human_feedback_batches[0]?.resolution);
      const current = repaired.human_reviews[0];
      expect(current).toMatchObject({ id: original.id, conversation_id: original.conversation_id, assistant_run_id: assistantId });
      expect(current.head).not.toBe(original.head); expect(current.snapshot_id).not.toBe(original.snapshot_id);
      expect(repaired.messages.filter((m: any) => m.content === discussion.content)).toHaveLength(1);
      expect(repaired.comments[0]).toMatchObject({ id: comment.id, snapshot_id: original.snapshot_id, status: "resolved", batch_id: batch.id });
      expect(repaired.snapshots.some((s: any) => s.id === original.snapshot_id)).toBe(true);
      expect(repaired.human_feedback_batches).toHaveLength(1); expect(f.launches.filter(id => id === assistantId)).toHaveLength(1);
      expect(f.mergeEffects).toHaveLength(0);
      const approval = await f.api(`${prefix}/human-review/approve`, { review_id: current.id, snapshot_id: current.snapshot_id, head: current.head, idempotency_key: "approve-repaired" });
      expect(approval.status).toBe(200); expect(await approval.json()).toMatchObject({ condition: "merged", head: current.head });
      expect(f.mergeEffects).toHaveLength(1);
    } finally { release?.(); f.close(); }
  }, 30000);
  for (const noOp of [false, true]) it(`retains obsolete blocked authority while allowing explicit approval after ${noOp ? "unchanged-head" : "changed-head"} Decline repairs`, async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const original = (await until(detail, d => d.human_reviews?.[0]?.condition === "ready")).human_reviews[0];
      const approve = (review: any, key: string) => f.api(`${prefix}/human-review/approve`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: key });
      f.mergeFailure("merge_blocked");
      const old = await approve(original, "original-authority").then(r => r.json());
      expect(old.condition).toBe("blocked");
      const comment = await f.api(`${prefix}/comments`, { snapshot_id: original.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Repair the blocked candidate" }).then(r => r.json());
      const response = await f.api(`${prefix}/human-review/submit`, { review_id: original.id, snapshot_id: original.snapshot_id, head: original.head, disposition: "decline", comment_ids: [comment.id], idempotency_key: "decline-blocked" });
      expect(response.status).toBe(202); const batch = await response.json();
      for (const role of ["implementer", "standards", "spec"]) {
        const d = await until(detail, d => d.workers.some((w: any) => w.role === role && w.condition === "working"));
        const worker = f.workers.get(d.workers.find((w: any) => w.role === role && w.condition === "working").id)!;
        if (noOp && role === "implementer") worker.head = original.head;
        worker.condition = "ready";
      }
      const repaired = await until(detail, d => d.human_reviews[0].condition === "ready" && d.human_feedback_batches[0]?.resolution);
      expect(repaired.human_reviews[0].head === original.head).toBe(noOp);
      expect(repaired.human_reviews[0].snapshot_id).not.toBe(original.snapshot_id);
      const current = repaired.human_reviews[0]; expect(current.id).toBe(original.id);
      expect(f.mergeEffects).toHaveLength(0);
      expect((await approve(current, "original-authority")).status).toBe(409);
      f.restart(); f.mergeFailure(null);
      const fresh = await approve(current, "repaired-authority"); expect(fresh.status).toBe(200);
      expect(await fresh.json()).toMatchObject({ condition: "merged", head: current.head, snapshot_id: current.snapshot_id });
      const final = await detail(); expect(final.human_review_approvals).toHaveLength(2);
      expect(final.human_review_approvals.find((a: any) => a.id === old.id)).toMatchObject({ head: original.head, snapshot_id: original.snapshot_id, condition: "blocked", superseded_by_batch_id: batch.id });
      expect(f.mergeEffects).toHaveLength(1);
    } finally { f.close(); }
  }, 30000);
  it("rejects incomplete or stale feedback atomically and claims concurrent retries only once", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
      const comments = [];
      for (const content of ["First feedback", "Second feedback"]) comments.push(await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content }).then(r => r.json()));
      const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "decline", comment_ids: comments.map(c => c.id), idempotency_key: "atomic-batch" };
      const incomplete = await f.api(`${prefix}/human-review/submit`, { ...body, comment_ids: [comments[0].id] });
      expect(incomplete.status).toBe(409);
      expect((await incomplete.json()).error.code).toBe("draft_batch_changed");
      expect((await detail()).comments.map((c: any) => c.status)).toEqual(["draft", "draft"]);
      expect((await detail()).human_feedback_batches).toHaveLength(0);
      const stale = await f.api(`${prefix}/human-review/submit`, { ...body, head: "e".repeat(40) });
      expect(stale.status).toBe(409);
      expect((await stale.json()).error.code).toBe("review_stale");
      const [one, two] = await Promise.all([f.api(`${prefix}/human-review/submit`, body), f.api(`${prefix}/human-review/submit`, body)]);
      expect([one.status, two.status]).toEqual([202, 202]);
      expect((await one.json()).id).toBe((await two.json()).id);
      const conflict = await f.api(`${prefix}/human-review/submit`, { ...body, head: "e".repeat(40) });
      expect((await conflict.json()).error.code).toBe("batch_conflict");
      expect((await detail()).human_feedback_batches).toHaveLength(1);
    } finally { f.close(); }
  }, 20000);
  it("blocks a queued repair if the integration head changes outside its reviewed lineage", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail, run } = await published(f);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
      const other = await f.assignment("Occupied stale repair capacity");
      await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "occupy" });
      const c = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Keep this exact candidate" }).then(r => r.json());
      const batch = await f.api(`${prefix}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "decline", comment_ids: [c.id], idempotency_key: "stale-decline" }).then(r => r.json());
      await until(detail, d => d.capacity_waiting.some((w: any) => !w.continuation));
      f.changeHead(run.id, "f".repeat(40));
      f.runs.get(f.launches.at(-1)!)!.condition = "ready";
      const stopped = await until(detail, d => d.automatic_review[0].condition === "blocked" || d.workers.some((w: any) => w.rework_batch_id === batch.id));
      expect(stopped.workers.some((w: any) => w.rework_batch_id === batch.id)).toBe(false);
      expect(stopped.automatic_review[0].condition).toBe("blocked");
      expect(stopped.comments[0].snapshot_id).toBe(review.snapshot_id);
    } finally { f.close(); }
  }, 20000);
  it("yields queued discussion to fixes when normal capacity is saturated", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
      const other = await f.assignment("Occupied feedback capacity");
      await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "occupy" });
      await f.api(`${prefix}/human-review/messages`, { review_id: review.id, content: "Discuss after fixes", idempotency_key: "queued-discussion" });
      const c = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Fix before discussion" }).then(r => r.json());
      const batch = await f.api(`${prefix}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "decline", comment_ids: [c.id], idempotency_key: "queued-decline" }).then(r => r.json());
      f.runs.get(f.launches.at(-1)!)!.condition = "ready";
      const next = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review") || d.workers.some((w: any) => w.rework_batch_id === batch.id && w.condition === "working"));
      expect(next.runs.some((r: any) => r.conversation_kind === "human_review")).toBe(false);
      expect(next.workers.find((w: any) => w.rework_batch_id === batch.id)?.condition).toBe("working");
    } finally { f.close(); }
  }, 20000);
  it("repeats feedback rounds while preserving discussion history and launches a fresh assistant at the repaired head", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const initial = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      await f.api(`${prefix}/human-review/messages`, { review_id: initial.human_reviews[0].id, content: "Explain the candidate", idempotency_key: "before-fixes" });
      const started = await until(detail, d => d.runs.length === 2);
      const assistant = started.runs.find((r: any) => r.conversation_kind === "human_review");
      f.runs.get(assistant.id)!.condition = "ready";
      await f.api(`/runs/${assistant.id}/reconcile`, {});
      for (let round = 0; round < 2; round++) {
        const before = await detail(); const review = before.human_reviews[0];
        const c = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: `Feedback round ${round}` }).then(r => r.json());
        const result = await f.api(`${prefix}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "decline", comment_ids: [c.id], idempotency_key: `round-${round}` });
        expect(result.status).toBe(202); const batch = await result.json();
        const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id === batch.id && w.condition === "working"));
        f.workers.get(fixing.workers.find((w: any) => w.rework_batch_id === batch.id).id)!.condition = "ready";
        for (const axis of ["standards", "spec"]) {
          const d = await until(detail, d => d.workers.some((w: any) => w.role === axis && w.condition === "working"));
          f.workers.get(d.workers.find((w: any) => w.role === axis && w.condition === "working").id)!.condition = "ready";
        }
        await until(detail, d => d.human_reviews[0].condition === "ready" && d.human_reviews[0].head !== review.head);
      }
      const repaired = await detail();
      expect(repaired.human_feedback_batches).toHaveLength(2);
      expect(repaired.comments.map((c: any) => c.status)).toEqual(["resolved", "resolved"]);
      await f.api(`${prefix}/human-review/messages`, { review_id: initial.human_reviews[0].id, content: "Explain the repaired candidate", idempotency_key: "after-fixes" });
      const continued = await until(detail, d => d.runs.some((r: any) => r.conversation_kind === "human_review" && r.condition === "working"));
      const context = continued.runs.find((r: any) => r.conversation_kind === "human_review" && r.condition === "working");
      expect(context.base).toBe(repaired.human_reviews[0].head);
      expect(context.id).not.toBe(assistant.id);
    } finally { f.close(); }
  }, 30000);
  it("submits every draft once, repairs at capacity one and returns fresh evidence to the same review without merge authority", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { prefix, detail } = await published(f);
      const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
      const review = ready.human_reviews[0];
      const comment = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Keep the progress durable" }).then(r => r.json());
      const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "decline", comment_ids: [comment.id], idempotency_key: "decline-one" };
      const response = await f.api(`${prefix}/human-review/submit`, body);
      expect(response.status).toBe(202);
      const batch = await response.json();
      expect(batch).toMatchObject({ disposition: "decline", head: review.head, snapshot_id: review.snapshot_id, comment_ids: [comment.id], merge_authorized: false });
      f.restart();
      expect((await f.api(`${prefix}/human-review/submit`, body).then(r => r.json())).id).toBe(batch.id);
      const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id === batch.id && w.condition === "working"));
      const fix = fixing.workers.find((w: any) => w.rework_batch_id === batch.id);
      expect(fix.review_origin).toBe("human");
      expect(f.workerContexts.get(fix.id).findings[0]).toMatchObject({ id: comment.id, snapshot_id: review.snapshot_id, content: comment.content });
      expect(fixing.conversations.find((c: any) => c.contexts.some((ctx: any) => ctx.worker_id === fix.id)).parent_id).toBe(review.conversation_id);
      f.loseNextIntegration();
      f.loseNextPublication();
      f.workers.get(fix.id)!.condition = "ready";
      for (const role of ["standards", "spec"]) {
        const d = await until(detail, d => d.workers.some((w: any) => w.role === role && w.condition === "working"));
        const reviewer = d.workers.find((w: any) => w.role === role && w.condition === "working");
        const feedback = f.workerContexts.get(reviewer.id).human_feedback;
        expect(feedback?.batch.id).toBe(batch.id);
        expect(feedback.comments[0]).toMatchObject({ id: comment.id, snapshot_id: review.snapshot_id, content: comment.content });
        f.workers.get(reviewer.id)!.condition = "ready";
      }
      const returned = await until(detail, d => d.human_reviews?.[0]?.condition === "ready" && d.human_reviews[0].head !== review.head);
      expect(returned.human_reviews[0]).toMatchObject({ id: review.id, conversation_id: review.conversation_id });
      const resolution = returned.human_feedback_batches[0].resolution;
      expect(resolution.head).toBe(returned.human_reviews[0].head);
      expect(Array.isArray(resolution.evidence_ids)).toBe(true);
      expect(returned.checks.find((c: any) => c.id === resolution.check_id)).toMatchObject({ head: resolution.head, condition: "passed" });
      expect(returned.review_evidence.filter((e: any) => resolution.evidence_ids.includes(e.id)).map((e: any) => [e.axis, e.head, e.outcome])).toEqual([["standards", resolution.head, "passed"], ["spec", resolution.head, "passed"]]);
      expect(returned.comments[0]).toMatchObject({ batch_id: batch.id, snapshot_id: review.snapshot_id, status: "resolved" });
      expect(returned.approvals.some((a: any) => a.kind === "review")).toBe(false);
      expect(returned.implementation.stage).toBe("review");
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(0);
      expect(returned.workers.filter((w: any) => w.rework_batch_id === batch.id)).toHaveLength(1);
    } finally { f.close(); }
  }, 30000);
});

for (const answered of [false, true]) it(`does not authorize conditional repairs against a new ${answered ? "answered" : "unanswered"} owner scope`, async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    const comment = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Retain this exact feedback draft" }).then(r => r.json());
    const question = await f.api(`${prefix}/questions`, { question: "Owner scope decision before conditional approval: export progress?" }).then(r => r.json());
    if (answered) expect((await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "No; retain the accepted behavior" })).status).toBe(200);
    const launches = [...f.workerLaunches];
    const response = await f.api(`${prefix}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "approve", comment_ids: [comment.id], idempotency_key: `new-owner-scope-${answered}` });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: answered ? "fresh_evidence_required" : "answers_unready" } });
    const blocked = await detail();
    expect(blocked.comments).toContainEqual(expect.objectContaining({ id: comment.id, status: "draft", batch_id: null }));
    expect(blocked.human_review_approvals).toHaveLength(0);
    expect(blocked.human_feedback_batches).toHaveLength(0);
    expect(blocked.questions).toContainEqual(expect.objectContaining({ id: question.id, answer: answered ? "No; retain the accepted behavior" : null }));
    expect(f.workerLaunches).toEqual(launches);
    expect(f.mergeEffects).toHaveLength(0);
  } finally { f.close(); }
}, 20000);

it("recovers changed owner context through explicit Decline, consumed fresh reviews and a new approval without reviving old authority", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail, run } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    const original = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, idempotency_key: "before-owner-decision" };
    f.mergeFailure("merge_waiting");
    const receipt = await f.api(`${prefix}/human-review/approve`, original).then(r => r.json());
    expect(receipt).toMatchObject({ condition: "pending", merge_not_sent: true, context_revision: ready.question_revision });
    const question = await f.api(`${prefix}/questions`, { question: "Owner decision: should the accepted result also export progress?" }).then(r => r.json());
    expect((await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "No export; keep and freshly review the original behavior" })).status).toBe(200);
    const stopped = await until(detail, d => d.human_review_approvals[0]?.condition === "blocked");
    expect(stopped.human_review_approvals[0]).toMatchObject({ id: receipt.id, context_revision: ready.question_revision, merge_not_sent: true });
    expect(f.mergeEffects).toHaveLength(0);
    f.mergeFailure(null);
    const context = await f.agent(run.id, "contract").then(r => r.json());
    expect((await f.agent(run.id, "consume", { revision: context.question_revision })).status).toBe(200);
    const comment = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Recheck the original behavior after this owner decision" }).then(r => r.json());
    const declined = await f.api(`${prefix}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "decline", comment_ids: [comment.id], idempotency_key: "fresh-owner-review" });
    expect(declined.status).toBe(202);
    const batch = await declined.json();
    expect(batch.merge_authorized).toBe(false);
    for (const role of ["implementer", "standards", "spec"]) {
      const current = await until(detail, d => d.workers.some((w: any) => w.role === role && w.condition === "working"));
      const worker = current.workers.find((w: any) => w.role === role && w.condition === "working");
      const contract = await f.agent(run.id, "contract").then(r => r.json());
      expect((await f.agent(run.id, "consume", { revision: contract.question_revision, worker_id: worker.id })).status).toBe(200);
      f.workers.get(worker.id)!.condition = "ready";
    }
    const fresh = await until(detail, d => d.human_reviews[0]?.condition === "ready" && d.human_feedback_batches[0]?.resolution);
    expect(f.mergeEffects).toHaveLength(0);
    const candidate = fresh.human_reviews[0];
    expect(candidate.snapshot_id).not.toBe(review.snapshot_id);
    expect(fresh.human_review_approvals[0]).toMatchObject({ id: receipt.id, context_revision: ready.question_revision, condition: "blocked", superseded_by_batch_id: batch.id });
    expect((await f.api(`${prefix}/human-review/approve`, original)).status).toBe(409);
    const response = await f.api(`${prefix}/human-review/approve`, { review_id: candidate.id, snapshot_id: candidate.snapshot_id, head: candidate.head, idempotency_key: "approve-new-owner-context" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ context_revision: context.question_revision, condition: "merged" });
    const done = await until(detail, d => d.implementation.stage === "done");
    expect(done.human_review_approvals).toHaveLength(2);
    expect(done.human_review_approvals[0]).toMatchObject({ id: receipt.id, context_revision: ready.question_revision, condition: "blocked", superseded_by_batch_id: batch.id });
    expect(done.questions).toContainEqual(expect.objectContaining({ id: question.id, answer: "No export; keep and freshly review the original behavior" }));
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 30000);

it("binds conditional repair authority to the original owner context and merges unchanged-context repairs without another approval", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = ready.human_reviews[0];
    const comment = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Retain this approved repair lineage" }).then(r => r.json());
    const response = await f.api(`${prefix}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "approve", comment_ids: [comment.id], idempotency_key: "bound-conditional-context" });
    expect(response.status).toBe(202);
    const batch = await response.json();
    expect((await detail()).human_review_approvals[0]).toMatchObject({ repair_batch_id: batch.id, context_revision: ready.question_revision, condition: "repairing" });
    for (const role of ["implementer", "standards", "spec"]) {
      const current = await until(detail, d => d.workers.some((w: any) => w.role === role && w.condition === "working"));
      f.workers.get(current.workers.find((w: any) => w.role === role && w.condition === "working").id)!.condition = "ready";
    }
    const done = await until(detail, d => d.implementation.stage === "done");
    expect(done.human_review_approvals).toHaveLength(1);
    expect(done.human_review_approvals[0]).toMatchObject({ repair_batch_id: batch.id, context_revision: ready.question_revision, condition: "merged" });
    expect(done.questions).toEqual(ready.questions);
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 30000);
