import { expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { published, until } from "../scripts/factory-human-review-fixture.ts";

it("approves the complete comment batch once and merges only its freshly checked and independently reviewed repairs", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const initial = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = initial.human_reviews[0];
    const comment = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Preserve the reviewed progress" }).then(r => r.json());
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "approve", comment_ids: [comment.id], idempotency_key: "approve-comments" };
    const response = await f.api(`${prefix}/human-review/submit`, body);
    expect(response.status).toBe(202);
    const batch = await response.json();
    expect(batch).toMatchObject({ disposition: "approve", merge_authorized: true, comment_ids: [comment.id] });
    expect(f.mergeEffects).toHaveLength(0);
    f.restart();
    expect((await f.api(`${prefix}/human-review/submit`, body).then(r => r.json())).id).toBe(batch.id);
    const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id === batch.id && w.condition === "working"));
    const fix = fixing.workers.find((w: any) => w.rework_batch_id === batch.id);
    expect(fix.review_origin).toBe("human");
    expect(f.workerContexts.get(fix.id).findings[0].id).toBe(comment.id);
    f.loseNextIntegration();
    f.workers.get(fix.id)!.condition = "ready";
    for (const axis of ["standards", "spec"]) {
      const d = await until(detail, d => d.workers.some((w: any) => w.role === axis && w.condition === "working"));
      const worker = d.workers.find((w: any) => w.role === axis && w.condition === "working");
      expect(f.workerContexts.get(worker.id).human_feedback.batch.id).toBe(batch.id);
      expect(f.mergeEffects).toHaveLength(0);
      f.workers.get(worker.id)!.condition = "ready";
    }
    const merged = await until(detail, d => d.implementation.stage === "done");
    const resolution = merged.human_feedback_batches[0].resolution;
    expect(resolution.head).not.toBe(review.head);
    expect(merged.human_review_approvals).toHaveLength(1);
    expect(merged.human_review_approvals[0]).toMatchObject({ repair_batch_id: batch.id, head: resolution.head, condition: "merged", original_candidate: { head: review.head, snapshot_id: review.snapshot_id } });
    expect(merged.checks.find((c: any) => c.id === resolution.check_id)).toMatchObject({ head: resolution.head, condition: "passed" });
    expect(merged.review_evidence.filter((e: any) => resolution.evidence_ids.includes(e.id)).map((e: any) => [e.axis, e.head, e.outcome])).toEqual([["standards", resolution.head, "passed"], ["spec", resolution.head, "passed"]]);
    expect(merged.workers.filter((w: any) => w.rework_batch_id === batch.id)).toHaveLength(1);
    expect(f.mergeEffects).toHaveLength(1);
    f.restart();
    expect((await f.api(`${prefix}/human-review/submit`, body).then(r => r.json())).id).toBe(batch.id);
    expect((await detail()).implementation.outcome).toBe("merged");
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 30000);

it("does not let an unrelated checked head inherit approval from the submitted repair lineage", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
    const c = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Repair only this feedback" }).then(r => r.json());
    const response = await f.api(`${prefix}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "approve", comment_ids: [c.id], idempotency_key: "unrelated-head" });
    expect(response.status).toBe(202); const batch = await response.json();
    const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id === batch.id && w.condition === "working"));
    f.changeAfterNextIntegration("f".repeat(40));
    f.workers.get(fixing.workers.find((w: any) => w.rework_batch_id === batch.id).id)!.condition = "ready";
    for (const axis of ["standards", "spec"]) {
      const d = await until(detail, d => d.workers.some((w: any) => w.role === axis && w.condition === "working"));
      f.workers.get(d.workers.find((w: any) => w.role === axis && w.condition === "working").id)!.condition = "ready";
    }
    const stopped = await until(detail, d => ["blocked", "merged"].includes(d.human_review_approvals[0]?.condition));
    expect(stopped.human_review_approvals[0]).toMatchObject({ condition: "blocked" });
    expect(f.mergeEffects).toHaveLength(0);
    expect(stopped.implementation.stage).toBe("review");
    expect((await f.api(`${prefix}/pause`, {}).then(r => r.json())).pause.condition).toBe("paused");
    expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
    expect((await detail()).human_review_approvals[0]).toEqual(stopped.human_review_approvals[0]);
    expect(f.mergeEffects).toHaveLength(0);
  } finally { f.close(); }
}, 30000);

it("keeps conditional authority visibly blocked when new owner context changes the approved repair scope", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
    const c = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Only preserve this progress" }).then(r => r.json());
    expect((await f.api(`${prefix}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "approve", comment_ids: [c.id], idempotency_key: "changed-scope" })).status).toBe(202);
    expect((await f.api(`${prefix}/questions`, { question: "New scope: should we also export progress?" })).status).toBe(201);
    const d = await until(detail, d => d.human_review_approvals[0].condition === "blocked");
    expect(d.human_review_approvals[0].reason).toContain("owner context changed");
    expect(f.mergeEffects).toHaveLength(0);
  } finally { f.close(); }
}, 20000);

it("retains approval through necessary independent-review repairs and a lost merge response until the frozen release milestone", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f, "release");
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
    const c = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Keep progress durable" }).then(r => r.json());
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "approve", comment_ids: [c.id], idempotency_key: "necessary-repairs" };
    const response = await f.api(`${prefix}/human-review/submit`, body); expect(response.status).toBe(202);
    const batch = await response.json();
    const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id === batch.id && w.condition === "working"));
    f.workers.get(fixing.workers.find((w: any) => w.rework_batch_id === batch.id).id)!.condition = "ready";
    for (let round = 0; round < 2; round++) {
      for (const axis of ["standards", "spec"]) {
        const d = await until(detail, d => d.workers.some((w: any) => w.role === axis && w.condition === "working"));
        const w = d.workers.find((w: any) => w.role === axis && w.condition === "working");
        if (round === 0 && axis === "spec") f.reviewOutcomes.set(w.id, "failed");
        f.workers.get(w.id)!.condition = "ready";
      }
      if (round === 0) {
        const repairs = await until(detail, d => d.workers.some((w: any) => w.review_origin === "automatic" && w.condition === "working"));
        f.workers.get(repairs.workers.find((w: any) => w.review_origin === "automatic" && w.condition === "working").id)!.condition = "ready";
        f.loseNextMerge();
      }
    }
    await until(detail, d => d.human_review_approvals[0].condition === "uncertain");
    f.restart();
    const waiting = await until(detail, d => d.human_review_approvals[0].condition === "awaiting_release");
    expect(waiting.implementation).toMatchObject({ stage: "review", outcome: "merged" });
    expect(waiting.human_review_approvals[0].head).toBe(waiting.human_feedback_batches[0].resolution.head);
    expect(f.mergeEffects).toHaveLength(1);
    f.releaseMerged();
    const released = await until(detail, d => d.human_review_approvals[0].condition === "released", 45000);
    expect(released.implementation).toMatchObject({ stage: "done", outcome: "released" });
    expect(released.human_review_approvals).toHaveLength(1);
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 60000);

it("claims one complete exact-revision approval batch and refuses forged, stale or incomplete submissions", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail, run } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
    const comments = [];
    for (const content of ["Preserve progress", "Explain recovery"]) comments.push(await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content }).then(r => r.json()));
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "approve", comment_ids: comments.map(c => c.id), idempotency_key: "atomic-approval" };
    expect((await f.api(`${prefix}/human-review/submit`, { ...body, disposition: ["approve"] })).status).toBe(400);
    const url = `http://localhost:${f.app.port}/api/factory${prefix}/human-review/submit`;
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${f.token}`, origin: "https://untrusted.invalid", "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) })).status).toBe(403);
    expect((await f.agent(run.id, "human-review/submit", body)).status).not.toBe(202);
    expect((await f.api(`${prefix}/human-review/submit`, { ...body, comment_ids: [comments[0].id] }).then(r => r.json())).error.code).toBe("draft_batch_changed");
    expect((await f.api(`${prefix}/human-review/submit`, { ...body, head: "f".repeat(40) }).then(r => r.json())).error.code).toBe("review_stale");
    expect((await detail()).human_review_approvals).toHaveLength(0);
    expect((await detail()).comments.map((c: any) => c.status)).toEqual(["draft", "draft"]);
    const [a, b] = await Promise.all([f.api(`${prefix}/human-review/submit`, body), f.api(`${prefix}/human-review/submit`, body)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect((await a.json()).id).toBe((await b.json()).id);
    expect((await detail()).human_feedback_batches).toHaveLength(1);
    expect((await detail()).human_review_approvals).toHaveLength(1);
    expect((await f.api(`${prefix}/human-review/submit`, { ...body, comment_ids: [comments[0].id] }).then(r => r.json())).error.code).toBe("batch_conflict");
  } finally { f.close(); }
}, 20000);

it("retains failed repair checks as a visible stop without spending conditional merge authority", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
    const c = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Keep this progress" }).then(r => r.json());
    const response = await f.api(`${prefix}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "approve", comment_ids: [c.id], idempotency_key: "failed-repair" });
    expect(response.status).toBe(202); const batch = await response.json();
    const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id === batch.id && w.condition === "working"));
    f.failNextCheck();
    f.workers.get(fixing.workers.find((w: any) => w.rework_batch_id === batch.id).id)!.condition = "ready";
    const stopped = await until(detail, d => d.human_review_approvals[0].condition === "blocked");
    expect(stopped.human_review_approvals[0].reason).toContain("failed");
    expect(stopped.comments[0].status).toBe("submitted");
    expect(f.mergeEffects).toHaveLength(0);
    f.restart();
    expect((await detail()).human_review_approvals[0].condition).toBe("blocked");
    expect((await f.api(`${prefix}/pause`, {}).then(r => r.json())).pause.condition).toBe("paused");
    expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
    expect((await detail()).human_review_approvals[0]).toEqual(stopped.human_review_approvals[0]);
    expect(f.mergeEffects).toHaveLength(0);
  } finally { f.close(); }
}, 20000);

it("preserves uncertain conditional merge authority across owner Pause and resumes observation without another approval", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { prefix, detail } = await published(f);
    const ready = await until(detail, d => d.human_reviews?.[0]?.condition === "ready"); const review = ready.human_reviews[0];
    const c = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Keep progress durable" }).then(r => r.json());
    const response = await f.api(`${prefix}/human-review/submit`, { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "approve", comment_ids: [c.id], idempotency_key: "pause-conditional" });
    expect(response.status).toBe(202); const batch = await response.json();
    const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id === batch.id && w.condition === "working"));
    f.workers.get(fixing.workers.find((w: any) => w.rework_batch_id === batch.id).id)!.condition = "ready";
    f.loseNextMerge();
    for (const axis of ["standards", "spec"]) {
      const d = await until(detail, d => d.workers.some((w: any) => w.role === axis && w.condition === "working"));
      f.workers.get(d.workers.find((w: any) => w.role === axis && w.condition === "working").id)!.condition = "ready";
    }
    await until(detail, d => d.human_review_approvals[0].condition === "uncertain");
    expect((await f.api(`${prefix}/pause`, {})).status).toBe(200);
    const observationDeadline = Date.now() + 2500;
    const paused = await until(detail, d => d.human_review_approvals[0].condition === "blocked" || Date.now() >= observationDeadline);
    expect(paused.human_review_approvals[0].condition).toBe("uncertain");
    expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
    const merged = await until(detail, d => d.human_review_approvals[0].condition === "merged");
    expect(merged.human_review_approvals).toHaveLength(1);
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 20000);


for (const changedScope of [false, true]) it(changedScope ? "keeps exhausted conditional authority blocked when answered owner context changes before Resume" : "resumes exhausted conditional repair recovery and merges with the original approval only", async () => {
  let historyAvailable = true;
  const f = await capacityFixture({ advancingHeads: true, workerTranscript: worker => !historyAvailable && worker.role === "implementer" ? null : {
    source_id: `owned-conditional-resume:${worker.id}`, version: "v1", cursor: null,
    turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: "Owned retained conditional repair history" }] }],
  } });
  try {
    const { prefix, detail, run } = await published(f);
    const initial = await until(detail, d => d.human_reviews?.[0]?.condition === "ready");
    const review = initial.human_reviews[0];
    const comment = await f.api(`${prefix}/comments`, { snapshot_id: review.snapshot_id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Resume only these approved repairs" }).then(r => r.json());
    const body = { review_id: review.id, snapshot_id: review.snapshot_id, head: review.head, disposition: "approve", comment_ids: [comment.id], idempotency_key: "conditional-recovery-resume" };
    const response = await f.api(`${prefix}/human-review/submit`, body);
    expect(response.status).toBe(202); const batch = await response.json();
    const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id === batch.id && w.condition === "working"));
    const repair = fixing.workers.find((w: any) => w.rework_batch_id === batch.id);
    historyAvailable = false; f.workers.get(repair.id)!.condition = "ready";
    const blocked = await until(detail, d => d.human_review_approvals[0].condition === "blocked", 45000);
    expect(blocked.automatic_review[0]).toMatchObject({ condition: "blocked", attempts: 6, human_batch_id: batch.id });
    expect(blocked.human_review_approvals[0].reason).toBe(blocked.automatic_review[0].reason);
    expect(f.mergeEffects).toHaveLength(0);
    // Resume without a confirmed Pause cannot renew either recovery budget.
    expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
    expect((await detail()).human_review_approvals[0]).toEqual(blocked.human_review_approvals[0]);
    if (changedScope) {
      const question = await f.api(`${prefix}/questions`, { question: "Should the approved repair also export progress?" }).then(r => r.json());
      expect((await f.api(`${prefix}/questions/${question.id}/answer`, { revision: question.revision, answer: "Yes; add export behavior" })).status).toBe(200);
    }
    historyAvailable = true;
    expect((await f.api(`${prefix}/pause`, {}).then(r => r.json())).pause.condition).toBe("paused");
    f.restart();
    expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
    const resumed = await detail();
    if (changedScope) {
      expect(resumed.automatic_review[0].condition).not.toBe("blocked");
      expect(resumed.human_review_approvals[0]).toEqual(blocked.human_review_approvals[0]);
      expect(resumed.events.filter((e: any) => e.kind === "human_review_repair_recovery_resumed")).toHaveLength(0);
      expect(f.mergeEffects).toHaveLength(0);
      return;
    }
    expect(resumed.human_review_approvals[0]).toMatchObject({ id: blocked.human_review_approvals[0].id, condition: "repairing", repair_batch_id: batch.id, original_candidate: { head: review.head, snapshot_id: review.snapshot_id } });
    expect(resumed.human_review_approvals[0].repair_scope).toBe(blocked.human_review_approvals[0].repair_scope);
    await until(detail, d => !d.workers.find((w: any) => w.id === repair.id).suspension);
    f.workers.get(repair.id)!.condition = "ready";
    await until(detail, d => !d.runs.find((r: any) => r.id === run.id).suspension);
    f.runs.get(run.id)!.condition = "ready";
    for (const axis of ["standards", "spec"]) {
      const next = await until(detail, d => d.workers.some((w: any) => w.role === axis && w.condition === "working"));
      f.workers.get(next.workers.find((w: any) => w.role === axis && w.condition === "working").id)!.condition = "ready";
    }
    const merged = await until(detail, d => d.human_review_approvals[0].condition === "merged");
    expect(merged.human_review_approvals).toHaveLength(1);
    expect(merged.human_review_approvals[0]).toMatchObject({ id: blocked.human_review_approvals[0].id, repair_batch_id: batch.id, repair_signature: batch.signature, original_candidate: { head: review.head, snapshot_id: review.snapshot_id }, head: merged.human_feedback_batches[0].resolution.head });
    expect(merged.human_review_approvals[0].head).not.toBe(review.head);
    expect(merged.review_evidence).toEqual(expect.arrayContaining(blocked.review_evidence));
    expect(merged.checks).toEqual(expect.arrayContaining(blocked.checks));
    expect(merged.tickets.filter((t: any) => t.status === "done")).toHaveLength(blocked.tickets.length);
    expect(merged.workers.filter((w: any) => w.rework_batch_id === batch.id)).toHaveLength(1);
    expect(f.mergeEffects).toHaveLength(1);
    f.restart();
    expect((await f.api(`${prefix}/human-review/submit`, body).then(r => r.json())).id).toBe(batch.id);
    expect((await f.api(`${prefix}/resume`, {})).status).toBe(200);
    expect((await detail()).human_review_approvals[0].condition).toBe("merged");
    expect(f.mergeEffects).toHaveLength(1);
  } finally { f.close(); }
}, 60000);
