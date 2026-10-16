import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { published, until } from "../scripts/factory-human-review-fixture.ts";

describe("Human Review Decline through authenticated HTTP", () => {
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
