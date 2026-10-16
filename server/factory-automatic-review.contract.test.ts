import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

async function until(read: () => Promise<any>, ready: (value: any) => boolean, timeout = 8000): Promise<any> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Automatic review did not progress: ${JSON.stringify({ review: value.automatic_review, runs: value.runs?.map((r: any) => ({ condition: r.condition, reason: r.waiting_reason, continuation: r.continuation })), waiting: value.capacity_waiting, workers: value.workers?.map((w: any) => ({ role: w.role, condition: w.condition, key: w.key })) })}`);
    await Bun.sleep(20);
  }
}

async function candidate(f: Awaited<ReturnType<typeof capacityFixture>>, publish = false, twoTickets = false) {
  await f.api("/settings", { max_agents: 1 });
  const id = await f.assignment("Automatic review result");
  const detail = () => f.api(`/implementations/${id}`).then(r => r.json());
  await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixtures only", ...(publish ? { pull_request: { repository: "fictional/project", base_branch: "main" } } : {}) });
  const specification = await f.api(`/implementations/${id}/specifications`, { content: "Implement the accepted result" }).then(r => r.json());
  await f.api(`/implementations/${id}/specification-acceptance`, { source: "button", specification_id: specification.id, hash: specification.hash });
  const run = (await until(detail, d => d.runs.length === 1)).runs[0];
  await f.agent(run.id, "tickets", { specification_id: specification.id, testing_plan: "Public HTTP and desktop/mobile browser journeys", tickets: [
    { key: "one", title: "Accepted behavior", acceptance: "Return the accepted result", dependencies: [] },
    ...(twoTickets ? [{ key: "two", title: "Dependent accepted behavior", acceptance: "Preserve the dependent result", dependencies: ["one"] }] : []),
  ] });
  f.runs.get(run.id)!.condition = "ready";
  for (let index = 0; index < (twoTickets ? 2 : 1); index++) {
    const started = await until(detail, d => d.workers.filter((w: any) => w.role === "implementer").length > index && d.workers.some((w: any) => w.role === "implementer" && w.condition === "working"));
    f.workers.get(started.workers.find((w: any) => w.role === "implementer" && w.condition === "working").id)!.condition = "ready";
  }
  return { id, detail, run };
}

describe("Automatic independent review through authenticated HTTP", () => {
  it("names remote publication policy problems without copying remote diagnostics or retrying a missing permission", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { id, detail } = await candidate(f, true); f.denyPublication();
      for (const axis of ["standards", "spec"]) {
        const current = await until(detail, d => d.workers.some((w: any) => w.role === axis && w.condition === "working"));
        f.workers.get(current.workers.find((w: any) => w.role === axis).id)!.condition = "ready";
      }
      const problem = await until(detail, d => d.automatic_review?.[0]?.reason);
      expect(problem.automatic_review[0]).toMatchObject({ condition: "blocked", reason: "Publication requires the frozen Project destination and a verified GitHub account on the execution Machine" });
      expect(f.publications.size).toBe(0);
      expect((await f.api(`/implementations/${id}/pause`, {}).then(r => r.json())).pause.condition).toBe("paused");
      expect((await f.api(`/implementations/${id}/resume`, {})).status).toBe(200);
      const resumed = await detail();
      expect(resumed.automatic_review[0]).toEqual(problem.automatic_review[0]);
      expect(resumed.review_evidence).toEqual(problem.review_evidence);
      expect(resumed.events.filter((e: any) => e.kind === "automatic_review_recovery_resumed")).toHaveLength(0);
    } finally { f.close(); }
  });
  it("resumes exhausted native review recovery after confirmed Pause without repeating retained work", async () => {
    let historyAvailable = true;
    const f = await capacityFixture({ advancingHeads: true, workerTranscript: worker => !historyAvailable && worker.role === "standards" ? null : {
      source_id: `owned-review-resume:${worker.id}`, version: "v1", cursor: null,
      turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: "Owned retained review history" }] }],
    } });
    try {
      const { id, detail, run } = await candidate(f, true);
      const started = await until(detail, d => d.workers.some((w: any) => w.role === "standards" && w.condition === "working"));
      const standards = started.workers.find((w: any) => w.role === "standards");
      historyAvailable = false; f.workers.get(standards.id)!.condition = "ready";
      const blocked = await until(detail, d => d.automatic_review?.[0]?.condition === "blocked", 40000);
      expect(blocked.automatic_review[0]).toMatchObject({ attempts: 6, reason: expect.stringContaining("exhausted after six observations") });
      expect(blocked.review_evidence).toHaveLength(1);
      expect(blocked.workers[0].condition).toBe("completed");
      expect(blocked.tickets[0].status).toBe("done");
      expect(f.publications.size).toBe(0);
      // Resume by itself does not grant another observation budget.
      expect((await f.api(`/implementations/${id}/resume`, {})).status).toBe(200);
      expect((await detail()).automatic_review[0]).toMatchObject({ condition: "blocked", attempts: 6 });
      f.offline(true);
      expect((await f.api(`/implementations/${id}/pause`, {}).then(r => r.json())).pause.condition).toBe("pending");
      historyAvailable = true; f.offline(false);
      await until(detail, d => d.implementation.pause?.condition === "paused");
      f.restart();
      expect((await f.api(`/implementations/${id}/resume`, {})).status).toBe(200);
      await until(detail, d => !d.workers.find((w: any) => w.id === standards.id).suspension);
      f.workers.get(standards.id)!.condition = "ready";
      await until(detail, d => !d.runs[0].suspension);
      f.runs.get(run.id)!.condition = "ready";
      const next = await until(detail, d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"));
      expect(next.review_evidence).toEqual(blocked.review_evidence);
      expect(next.workers.find((w: any) => w.id === standards.id).condition).toBe("completed");
      f.workers.get(next.workers.find((w: any) => w.role === "spec").id)!.condition = "ready";
      const done = await until(detail, d => d.automatic_review[0].condition === "published" && d.human_reviews.length === 1);
      expect(done.workers.map((w: any) => w.id).slice(0, 2)).toEqual(blocked.workers.map((w: any) => w.id));
      expect(done.review_evidence).toHaveLength(2);
      expect(done.review_evidence[0]).toEqual(blocked.review_evidence[0]);
      expect(done.checks.map((c: any) => c.id)).toEqual(blocked.checks.map((c: any) => c.id));
      expect(done.events.filter((e: any) => e.kind === "ticket_integrated")).toHaveLength(1);
      expect(done.approvals.map((a: any) => a.kind)).toEqual(["specification"]);
      expect(f.workerLaunches).toHaveLength(3); expect(f.publications.size).toBe(1);
      expect((await f.api(`/implementations/${id}/resume`, {})).status).toBe(200);
      const repeated = await detail();
      expect(repeated.review_evidence).toEqual(done.review_evidence);
      expect(repeated.events.filter((e: any) => e.kind === "automatic_review_recovery_resumed")).toHaveLength(1);
    } finally { f.close(); }
  }, 60000);
  it("retains an independent report across a lost reviewer shutdown reply and resumes without duplicate evidence", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { detail } = await candidate(f);
      const first = await until(detail, d => d.workers.some((w: any) => w.role === "standards" && w.condition === "working"));
      f.loseNextStop(); f.workers.get(first.workers.find((w: any) => w.role === "standards").id)!.condition = "ready";
      await until(detail, d => d.automatic_review?.[0]?.condition === "waiting");
      f.restart();
      const next = await until(detail, d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"));
      expect(next.review_evidence).toHaveLength(1);
      expect(next.workers.find((w: any) => w.role === "standards").condition).toBe("completed");
      f.workers.get(next.workers.find((w: any) => w.role === "spec").id)!.condition = "ready";
      const done = await until(detail, d => d.review_evidence.length === 2);
      expect(new Set(done.review_evidence.map((r: any) => r.worker_id)).size).toBe(2);
    } finally { f.close(); }
  });
  it("preserves native permission and new-scope questions before publishing a checked candidate", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { detail, run } = await candidate(f, true);
      const first = await until(detail, d => d.workers.some((w: any) => w.role === "standards" && w.condition === "working"));
      const worker = f.workers.get(first.workers.find((w: any) => w.role === "standards").id)!;
      worker.condition = "needs_you"; worker.waiting_reason = "Owned review permission required";
      const waiting = await until(detail, d => d.automatic_review?.[0]?.reason === "Owned review permission required");
      expect(waiting.review_evidence).toEqual([]); expect(f.publications.size).toBe(0);
      worker.condition = "ready"; worker.waiting_reason = null;
      const second = await until(detail, d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"));
      await f.agent(run.id, "question", { question: "Does this require new scope?" });
      f.workers.get(second.workers.find((w: any) => w.role === "spec").id)!.condition = "ready";
      const pending = await until(detail, d => d.automatic_review?.[0]?.reason === "Does this require new scope?");
      expect(f.publications.size).toBe(0); expect(pending.review_evidence).toHaveLength(1);
      const question = pending.questions.find((q: any) => q.answer === null);
      expect((await f.api(`/implementations/${pending.implementation.id}/questions/${question.id}/answer`, { revision: question.revision, answer: "No; retain the accepted behavior" })).status).toBe(200);
      const answered = await f.agent(run.id, "contract").then(r => r.json());
      await f.agent(run.id, "consume", { revision: answered.question_revision });
      f.runs.get(run.id)!.condition = "ready";
      for (const axis of ["standards", "spec"]) {
        const fresh = await until(detail, d => d.workers.filter((w: any) => w.role === axis).length === 2 && d.workers.some((w: any) => w.role === axis && w.condition === "working"));
        const reviewer = fresh.workers.filter((w: any) => w.role === axis).at(-1);
        const contract = await f.agent(run.id, "contract").then(r => r.json());
        await f.agent(run.id, "consume", { revision: contract.question_revision, worker_id: reviewer.id });
        f.workers.get(reviewer.id)!.condition = "ready";
      }
      const done = await until(detail, d => d.automatic_review?.[0]?.condition === "published");
      expect(done.review_evidence).toHaveLength(3);
      expect(done.pull_requests[0].evidence_ids).not.toContain(pending.review_evidence[0].id);
    } finally { f.close(); }
  });
  it("blocks a candidate changed outside the repair lineage without publishing stale check and review evidence", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { detail, run } = await candidate(f, true);
      const first = await until(detail, d => d.workers.some((w: any) => w.role === "standards" && w.condition === "working"));
      f.workers.get(first.workers.find((w: any) => w.role === "standards").id)!.condition = "ready";
      await until(detail, d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"));
      f.changeHead(run.id, "e".repeat(40));
      const stale = await until(detail, d => d.automatic_review?.[0]?.condition === "blocked");
      expect(stale.automatic_review[0].reason).toContain("Final checks must cover");
      expect(f.publications.size).toBe(0); expect(stale.review_evidence).toHaveLength(1);
    } finally { f.close(); }
  });
  it("stops after three automatic repair rounds and retains the original findings for inspection", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { detail, run } = await candidate(f, true);
      for (let round = 0; round < 4; round++) {
        for (const axis of ["standards", "spec"]) {
          const current = await until(detail, d => d.workers.filter((w: any) => w.role === axis).length === round + 1 && d.workers.some((w: any) => w.role === axis && w.condition === "working"));
          const reviewer = current.workers.filter((w: any) => w.role === axis).at(-1);
          if (axis === "standards") f.reviewOutcomes.set(reviewer.id, "failed");
          f.workers.get(reviewer.id)!.condition = "ready";
        }
        if (round < 3) {
          const fixing = await until(detail, d => d.workers.filter((w: any) => w.rework_batch_id).length === round + 1 && d.workers.some((w: any) => w.rework_batch_id && w.condition === "working"));
          f.workers.get(fixing.workers.filter((w: any) => w.rework_batch_id).at(-1).id)!.condition = "ready";
        }
      }
      const blocked = await until(detail, d => d.automatic_review?.[0]?.condition === "blocked");
      expect(blocked.automatic_review[0].reason).toContain("three rounds");
      expect(blocked.workers.filter((w: any) => w.rework_batch_id)).toHaveLength(3);
      expect((await f.agent(run.id, "contract").then(r => r.json())).review_batches).toHaveLength(3);
      expect(f.publications.size).toBe(0);
    } finally { f.close(); }
  }, 30000);
  it("publishes the checked and independently reviewed head once and reconciles a lost reply across restart without merge authority", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { detail } = await candidate(f, true);
      const standards = await until(detail, d => d.workers.some((w: any) => w.role === "standards" && w.condition === "working"));
      f.workers.get(standards.workers.find((w: any) => w.role === "standards").id)!.condition = "ready";
      const spec = await until(detail, d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"));
      f.loseNextPublication(); f.workers.get(spec.workers.find((w: any) => w.role === "spec").id)!.condition = "ready";
      await until(detail, d => d.automatic_review?.[0]?.condition === "waiting");
      f.restart();
      const done = await until(detail, d => d.automatic_review?.[0]?.condition === "published");
      const pr = done.pull_requests[0];
      const check = done.checks.find((c: any) => c.id === pr.check_id);
      expect(pr).toMatchObject({ head: check.head, repository: "fictional/project", base_branch: "main", number: 27 });
      expect(done.review_evidence.filter((r: any) => pr.evidence_ids.includes(r.id)).map((r: any) => r.head)).toEqual([check.head, check.head]);
      expect(done.implementation).toMatchObject({ stage: "review", outcome: "pr_open" });
      expect(done.approvals.map((a: any) => a.kind)).toEqual(["specification"]);
      expect(f.publications.size).toBe(1);
      expect(done.runs[0].condition).not.toBe("completed");
      expect(done.events.filter((e: any) => e.kind === "pull_request_published")).toHaveLength(1);
    } finally { f.close(); }
  });
  it("delivers immutable findings to a fresh automatic Review-fixes worker and checks and reviews its repaired revision", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { detail, run } = await candidate(f);
      const first = await until(detail, d => d.workers.some((w: any) => w.role === "standards" && w.condition === "working"));
      const standards = first.workers.find((w: any) => w.role === "standards");
      f.reviewOutcomes.set(standards.id, "failed"); f.workers.get(standards.id)!.condition = "ready";
      const second = await until(detail, d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"));
      f.workers.get(second.workers.find((w: any) => w.role === "spec").id)!.condition = "ready";
      const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id && w.condition === "working"));
      const repair = fixing.workers.find((w: any) => w.rework_batch_id);
      expect(repair).toMatchObject({ review_origin: "automatic", ticket_id: first.workers[0].ticket_id });
      const context = await f.agent(run.id, "contract").then(r => r.json());
      const original = context.review_batches.find((b: any) => b.id === repair.rework_batch_id);
      expect(original.origin).toBe("automatic"); expect(original.head).toBe(standards.base);
      expect(original.reports.map((report: any) => report.outcome)).toEqual(["failed", "passed"]);
      expect(original.reports[0].content).toContain("draft on reload");
      const repairContext = f.workerContexts.get(repair.id).review_batch;
      expect(repairContext).toMatchObject({ id: original.id, run_id: run.id, head: original.head, report_ids: original.reports.map((report: any) => report.id), instructions: expect.stringContaining(".saurons-eye-tracker.mjs contract") });
      expect(repairContext.reports).toBeUndefined();
      expect(fixing.conversations.find((c: any) => c.contexts.some((x: any) => x.worker_id === repair.id))).toMatchObject({ kind: "review_fixes", parent_id: `${fixing.implementation.id}:orchestrator` });
      f.restart(); f.workers.get(repair.id)!.condition = "ready";
      const freshStandards = await until(detail, d => d.workers.filter((w: any) => w.role === "standards").length === 2 && d.workers.some((w: any) => w.role === "standards" && w.condition === "working"));
      f.workers.get(freshStandards.workers.filter((w: any) => w.role === "standards").at(-1).id)!.condition = "ready";
      const freshSpec = await until(detail, d => d.workers.filter((w: any) => w.role === "spec").length === 2 && d.workers.some((w: any) => w.role === "spec" && w.condition === "working"));
      f.workers.get(freshSpec.workers.filter((w: any) => w.role === "spec").at(-1).id)!.condition = "ready";
      const done = await until(detail, d => d.review_evidence.length === 4);
      const final = done.checks.filter((c: any) => c.worker_id === null).at(-1);
      expect(final.head).not.toBe(original.head);
      expect(done.review_evidence.slice(-2).map((r: any) => r.head)).toEqual([final.head, final.head]);
      expect((await f.agent(run.id, "contract").then(r => r.json())).review_batches[0].reports).toEqual(original.reports);
      expect(done.approvals.map((a: any) => a.kind)).toEqual(["specification"]);
    } finally { f.close(); }
  });
  it("reviews a checked candidate with separate Standards and Spec contexts at cap one without owner continuation", async () => {
    const f = await capacityFixture({ advancingHeads: true });
    try {
      const { detail } = await candidate(f);
      const standards = await until(detail, d => d.workers.some((w: any) => w.role === "standards" && w.condition === "working"));
      f.workers.get(standards.workers.find((w: any) => w.role === "standards").id)!.condition = "ready";
      const spec = await until(detail, d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"));
      f.workers.get(spec.workers.find((w: any) => w.role === "spec").id)!.condition = "ready";
      const reviewed = await until(detail, d => d.review_evidence.length === 2);
      const final = reviewed.checks.filter((c: any) => c.worker_id === null).at(-1);
      expect(reviewed.review_evidence.map((r: any) => [r.axis, r.outcome, r.head])).toEqual([
        ["standards", "passed", final.head], ["spec", "passed", final.head],
      ]);
      expect(reviewed.conversations.filter((c: any) => c.kind === "reviewer")).toHaveLength(1);
      expect(reviewed.conversations.filter((c: any) => ["standards", "spec"].includes(c.kind))).toHaveLength(2);
      expect(reviewed.approvals.map((a: any) => a.kind)).toEqual(["specification"]);
      expect(f.workerLaunches).toHaveLength(3);
      f.restart();
      expect((await detail()).review_evidence).toEqual(reviewed.review_evidence);
    } finally { f.close(); }
  });
});


it("repairs every Ticket in one automatic report batch sequentially and publishes only fresh checked reviews", async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { detail, run } = await candidate(f, true, true);
    const initial = await until(detail, d => d.workers.some((w: any) => w.role === "standards" && w.condition === "working"));
    const standards = initial.workers.find((w: any) => w.role === "standards");
    f.reviewOutcomes.set(standards.id, "failed"); f.workers.get(standards.id)!.condition = "ready";
    const spec = await until(detail, d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"));
    f.workers.get(spec.workers.find((w: any) => w.role === "spec").id)!.condition = "ready";
    const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id && w.condition === "working"));
    const first = fixing.workers.find((w: any) => w.rework_batch_id);
    const original = (await f.agent(run.id, "contract").then(r => r.json())).review_batches.find((batch: any) => batch.id === first.rework_batch_id);
    expect(original.ticket_ids).toHaveLength(2);
    const parallel = await f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: original.ticket_ids[1], review_batch_id: original.id, idempotency_key: "parallel-automatic-repair" });
    expect(parallel.status).toBe(409);
    expect((await parallel.json()).error.code).toBe("rework_batch_unavailable");
    expect((await detail()).workers.filter((w: any) => w.rework_batch_id === original.id)).toHaveLength(1);
    f.loseNextIntegration(); f.workers.get(first.id)!.condition = "ready";
    const next = await until(detail, d => d.workers.filter((w: any) => w.rework_batch_id === original.id).length === 2 && d.workers.some((w: any) => w.rework_batch_id === original.id && w.condition === "working"));
    const repairs = next.workers.filter((w: any) => w.rework_batch_id === original.id);
    const second = repairs.find((w: any) => w.id !== first.id);
    expect(repairs[0].condition).toBe("completed");
    expect(second.base).toBe(repairs[0].head);
    expect(repairs.map((w: any) => w.ticket_id)).toEqual(original.ticket_ids);
    expect(new Set(repairs.map((w: any) => w.id)).size).toBe(2);
    f.restart(); f.workers.get(second.id)!.condition = "ready";
    for (const axis of ["standards", "spec"]) {
      const reviewed = await until(detail, d => d.workers.filter((w: any) => w.role === axis).length === 2 && d.workers.some((w: any) => w.role === axis && w.condition === "working"));
      if (axis === "standards") {
        const duplicate = await f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: original.ticket_ids[0], review_batch_id: original.id, idempotency_key: "duplicate-automatic-ticket-repair" });
        expect(duplicate.status).toBe(409);
        expect((await duplicate.json()).error.code).toBe("rework_batch_unavailable");
      }
      f.workers.get(reviewed.workers.find((w: any) => w.role === axis && w.condition === "working").id)!.condition = "ready";
    }
    const done = await until(detail, d => d.automatic_review[0].condition === "published" && d.human_reviews[0]?.condition === "ready");
    const pr = done.pull_requests[0];
    expect(done.workers.filter((w: any) => w.rework_batch_id === original.id).map((w: any) => w.condition)).toEqual(["completed", "completed"]);
    expect(done.review_evidence.filter((report: any) => pr.evidence_ids.includes(report.id)).map((report: any) => [report.axis, report.outcome, report.head])).toEqual([["standards", "passed", pr.head], ["spec", "passed", pr.head]]);
    expect(done.checks.find((check: any) => check.id === pr.check_id)).toMatchObject({ head: pr.head, condition: "passed", worker_id: null });
    const retained = (await f.agent(run.id, "contract").then(r => r.json())).review_batches.find((batch: any) => batch.id === original.id);
    expect(retained.reports).toEqual(original.reports);
    expect(retained.resolution.head).toBe(pr.head);
    expect(done.approvals.map((approval: any) => approval.kind)).toEqual(["specification"]);
    expect(f.publications.size).toBe(1);
    expect(f.workerLaunches).toHaveLength(8);
    expect(done.implementation).toMatchObject({ stage: "review", outcome: "pr_open" });
  } finally { f.close(); }
}, 30_000);


for (const phase of ["between_repairs", "while_repairing"] as const) it(`blocks outside-head drift ${phase} without extending automatic repair authority`, async () => {
  const f = await capacityFixture({ advancingHeads: true });
  try {
    const { detail, run } = await candidate(f, true, true);
    const initial = await until(detail, d => d.workers.some((w: any) => w.role === "standards" && w.condition === "working"));
    const standards = initial.workers.find((w: any) => w.role === "standards");
    f.reviewOutcomes.set(standards.id, "failed"); f.workers.get(standards.id)!.condition = "ready";
    const spec = await until(detail, d => d.workers.some((w: any) => w.role === "spec" && w.condition === "working"));
    f.workers.get(spec.workers.find((w: any) => w.role === "spec").id)!.condition = "ready";
    const fixing = await until(detail, d => d.workers.some((w: any) => w.rework_batch_id && w.condition === "working"));
    const first = fixing.workers.find((w: any) => w.rework_batch_id);
    const original = (await f.agent(run.id, "contract").then(r => r.json())).review_batches.find((batch: any) => batch.id === first.rework_batch_id);
    if (phase === "between_repairs") f.changeAfterNextIntegration("e".repeat(40));
    else f.changeHead(run.id, "e".repeat(40));
    f.workers.get(first.id)!.condition = "ready";
    const stopped = await until(detail, d => d.automatic_review[0].condition === "blocked");
    expect(stopped.workers.filter((w: any) => w.rework_batch_id === original.id)).toHaveLength(1);
    expect(stopped.workers.find((w: any) => w.id === first.id).condition).toBe(phase === "between_repairs" ? "completed" : "ready");
    expect(stopped.events.filter((event: any) => event.kind === "ticket_integrated" && event.data.worker_id === first.id)).toHaveLength(phase === "between_repairs" ? 1 : 0);
    expect(stopped.automatic_review[0].reason).toContain("automatic");
    expect(stopped.pull_requests).toHaveLength(0); expect(f.publications.size).toBe(0);
    const retained = (await f.agent(run.id, "contract").then(r => r.json())).review_batches.find((batch: any) => batch.id === original.id);
    expect(retained.reports).toEqual(original.reports); expect(retained.resolution).toBeUndefined();
  } finally { f.close(); }
}, 30_000);
