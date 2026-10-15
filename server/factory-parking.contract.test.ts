import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) { const value = await read(); if (ready(value)) return value; await Bun.sleep(30); }
  throw new Error("Waiting conversation did not reach its expected public state");
}

describe("waiting factory conversations through authenticated HTTP", () => {
  it("parks an owner question only after native rest and resumes the same conversation with its exact answered revision", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Waiting conversation");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "owner-wait" }).then(r => r.json());
      const question = await f.api(`/implementations/${id}/questions`, { question: "Which owned scope?", run_id: run.id }).then(r => r.json());
      const detail = () => f.api(`/implementations/${id}`).then(r => r.json());
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(1);
      f.runs.get(run.id)!.condition = "ready";
      await eventually(detail, d => d.runs[0].continuation?.condition === "parked");
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(0);
      const next = await f.assignment("Other work");
      const holder = await f.api(`/implementations/${next}/runs`, { action: "work", idempotency_key: "other" }).then(r => r.json());
      await f.api(`/implementations/${id}/questions/${question.id}/answer`, { revision: question.revision, answer: "The exact owned scope" });
      const queued = await eventually(detail, d => d.runs[0].continuation?.condition === "queued");
      const revision = queued.question_revision;
      f.restart();
      await f.api(`/runs/${holder.id}/stop`, {});
      const resumed = await eventually(detail, d => d.runs[0].continuation?.condition === "resumed");
      expect(resumed.runs).toHaveLength(1);
      expect(resumed.runs[0]).toMatchObject({ id: run.id, worktree: run.worktree, condition: "working" });
      expect(resumed.questions[0]).toMatchObject({ id: question.id, answer: "The exact owned scope" });
      expect(f.prompts).toEqual([expect.objectContaining({ run_id: run.id, text: expect.stringContaining(revision) })]);
      expect(f.launches).toHaveLength(2);
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(1);
    } finally { f.close(); }
  });
  it("hands the only normal slot from coordinator to child, independent review and back without duplicate launches", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("One slot handoff");
      const assignment = await f.api(`/implementations/${id}`).then(r => r.json());
      await f.api(`/projects/${assignment.implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned execution fixtures only" });
      const specification = await f.api(`/implementations/${id}/specifications`, { content: "An owned child implements the accepted Ticket before independent reviews" }).then(r => r.json());
      for (const kind of ["specification", "testing_seams"]) await f.api(`/implementations/${id}/approvals`, { kind, revision: specification.id, scope: "Owned Ticket handoff" });
      const graph = await f.api(`/implementations/${id}/tickets`, { specification_id: specification.id, tickets: [{ key: "one", title: "Owned Ticket", acceptance: "Implement then independently review", dependencies: [] }] }).then(r => r.json());
      await f.api(`/implementations/${id}/approvals`, { kind: "ticket_graph", revision: graph.hash, scope: "Owned Ticket" });
      const run = await f.api(`/implementations/${id}/runs`, { action: "implement-spec", idempotency_key: "coordinator" }).then(r => r.json());
      const child = () => f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: graph.tickets[0].id, idempotency_key: "first-child" });
      expect((await child()).status).toBe(202);
      f.runs.get(run.id)!.condition = "ready";
      const detail = () => f.api(`/implementations/${id}`).then(r => r.json());
      const working = await eventually(detail, d => d.workers[0]?.condition === "working" && d.runs[0].continuation?.condition === "parked");
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(1);
      expect(working.runs[0].continuation.kind).toBe("children");
      expect(f.prompts).toHaveLength(0);
      await child();
      f.workers.get(working.workers[0].id)!.condition = "ready";
      const candidate = await f.api(`/runs/${run.id}/workers/${working.workers[0].id}/refresh`, {}).then(r => r.json());
      expect(candidate.head).toBe("1".repeat(40));
      expect((await f.api(`/runs/${run.id}/workers/${candidate.id}/check`, {}).then(r => r.json())).condition).toBe("passed");
      expect((await f.api(`/runs/${run.id}/workers/${candidate.id}/integrate`, {}).then(r => r.json())).condition).toBe("completed");
      await eventually(detail, d => d.runs[0].continuation?.condition === "resumed");
      const standards = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "standards" }).then(r => r.json());
      expect(standards.condition).toBe("queued");
      f.runs.get(run.id)!.condition = "ready";
      const standardReview = await eventually(detail, d => d.workers.some((w: { role: string; condition: string }) => w.role === "standards" && w.condition === "working"));
      f.workers.get(standardReview.workers.find((w: { role: string }) => w.role === "standards").id)!.condition = "completed";
      await eventually(detail, d => d.runs[0].continuation?.condition === "resumed");
      const spec = () => f.api(`/runs/${run.id}/workers`, { role: "spec", idempotency_key: "second-review" });
      await spec();
      f.runs.get(run.id)!.condition = "ready";
      const reviewing = await eventually(detail, d => d.workers.some((w: { role: string; condition: string }) => w.role === "spec" && w.condition === "working") && d.runs[0].continuation?.condition === "parked");
      const reviewer = reviewing.workers.find((w: { role: string }) => w.role === "spec");
      f.restart();
      f.workers.get(reviewer.id)!.condition = "completed";
      await eventually(detail, d => d.runs[0].continuation?.condition === "resumed");
      expect(f.workerLaunches).toHaveLength(3);
      expect(f.launches).toEqual([run.id]);
      expect(f.prompts.map(p => p.run_id)).toEqual([run.id, run.id, run.id]);
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(1);
      expect((await detail()).implementation.stage).toBe("review");
    } finally { f.close(); }
  });

  it("keeps an explicit answer send in the same capacity queue instead of bypassing a parked reservation", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Explicit answer handoff");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "wait" }).then(r => r.json());
      const question = await f.api(`/implementations/${id}/questions`, { run_id: run.id, question: "Owned answer?" }).then(r => r.json());
      f.runs.get(run.id)!.condition = "ready";
      const detail = () => f.api(`/implementations/${id}`).then(r => r.json());
      await eventually(detail, d => d.runs[0].continuation?.condition === "parked");
      const other = await f.assignment("Answer slot holder");
      const holder = await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      await f.api(`/implementations/${id}/questions/${question.id}/answer`, { revision: question.revision, answer: "Retained context" });
      const revision = (await detail()).question_revision;
      const send = () => f.api(`/runs/${run.id}/send-answers`, { revision, idempotency_key: "explicit" }).then(r => r.json());
      expect((await send()).condition).toBe("queued");
      expect(f.prompts).toHaveLength(0);
      await f.api(`/runs/${holder.id}/stop`, {});
      await eventually(detail, d => d.runs[0].continuation?.condition === "resumed");
      expect((await send()).condition).toBe("sent");
      expect(f.prompts).toHaveLength(1);
    } finally { f.close(); }
  });

  it("retains uncertain delivery capacity after a lost response and restart, without replaying the prompt", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Lost resume acknowledgment");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "wait" }).then(r => r.json());
      const q = await f.api(`/implementations/${id}/questions`, { run_id: run.id, question: "Owned scope?" }).then(r => r.json());
      f.runs.get(run.id)!.condition = "ready";
      const detail = () => f.api(`/implementations/${id}`).then(r => r.json());
      await eventually(detail, d => d.runs[0].continuation?.condition === "parked");
      f.loseNextSend();
      await f.api(`/implementations/${id}/questions/${q.id}/answer`, { revision: q.revision, answer: "Retained answer" });
      await eventually(detail, d => d.runs[0].continuation?.condition === "uncertain");
      f.runs.get(run.id)!.condition = "ready";
      f.restart();
      const next = await f.assignment("After lost delivery");
      const waiting = await f.api(`/implementations/${next}/runs`, { action: "work", idempotency_key: "after" });
      expect(waiting.status).toBe(202);
      expect((await waiting.json()).condition).toBe("queued");
      const overview = await f.api("").then(r => r.json());
      expect(overview.capacity.normal.used).toBe(1);
      expect(overview.capacity.contexts[0]).toMatchObject({ uncertain: true, reason: expect.stringContaining("inspect") });
      expect(f.prompts).toHaveLength(1);
      expect(f.launches).toHaveLength(1);
    } finally { f.close(); }
  });

  it("recovers a lost park observation and native permission wait without releasing unknown execution or interrupted builds", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1, max_builds: 1 });
      const id = await f.assignment("Permission and observation wait");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "permission" }).then(r => r.json());
      f.loseNextCheck();
      expect((await f.api(`/runs/${run.id}/checks`, {}).then(r => r.json())).condition).toBe("interrupted");
      const question = await f.api(`/implementations/${id}/questions`, { run_id: run.id, question: "Owned permission scope?" }).then(r => r.json());
      f.runs.get(run.id)!.condition = "ready";
      f.uncertain(true);
      f.restart();
      await f.api(`/runs/${run.id}/reconcile`, {});
      let overview = await f.api("").then(r => r.json());
      expect(overview.capacity.normal.used).toBe(1);
      expect(overview.capacity.builds.used).toBe(1);
      const other = await f.assignment("Waiting after uncertainty");
      await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "other" });
      expect(f.launches).toHaveLength(1);
      f.uncertain(false);
      f.runs.get(run.id)!.condition = "needs_you"; // Owned native permission prompt, not an app question.
      await f.api(`/runs/${run.id}/reconcile`, {});
      await f.api(`/implementations/${id}/questions/${question.id}/answer`, { revision: question.revision, answer: "The exact scope" });
      overview = await f.api("").then(r => r.json());
      expect(overview.capacity.normal.used).toBe(1);
      expect(f.prompts).toHaveLength(0);
      f.runs.get(run.id)!.condition = "ready"; // Owner clears the native permission prompt.
      const next = await eventually(() => f.api(`/implementations/${other}`).then(r => r.json()), d => d.runs[0]?.condition === "working");
      expect(f.prompts).toHaveLength(0); // The older root request wins the free slot.
      await f.api(`/runs/${next.runs[0].id}/stop`, {});
      await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => d.runs[0].continuation?.condition === "resumed");
      expect(f.prompts).toHaveLength(1);
      expect((await f.api("").then(r => r.json())).capacity.builds.used).toBe(1);
    } finally { f.close(); }
  });

  it("parks and resumes the exact child conversation that asked for owner input, retaining answer-consumption provenance", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Child owner question");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "parent" }).then(r => r.json());
      f.runs.get(run.id)!.condition = "ready";
      const worker = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "child" }).then(r => r.json());
      const q = await f.agent(run.id, "question", { worker_id: worker.id, question: "Which child decision?" }).then(r => r.json());
      expect(q.worker_id).toBe(worker.id);
      f.workers.get(worker.id)!.condition = "ready";
      const detail = () => f.api(`/implementations/${id}`).then(r => r.json());
      await eventually(detail, d => d.workers[0].continuation?.condition === "parked");
      expect((await f.api(`/runs/${run.id}/workers/${worker.id}/reconcile`, {}).then(r => r.json())).continuation?.condition).toBe("parked");
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(0);
      const other = await f.assignment("Child answer slot holder");
      const holder = await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      await f.api(`/implementations/${id}/questions/${q.id}/answer`, { revision: q.revision, answer: "The child scope" });
      await eventually(detail, d => d.workers[0].continuation?.condition === "queued");
      f.restart();
      await f.api(`/runs/${holder.id}/stop`, {});
      const resumed = await eventually(detail, d => d.workers[0].continuation?.condition === "resumed");
      expect(resumed.workers[0]).toMatchObject({ id: worker.id, worktree: worker.worktree, condition: "working" });
      expect(f.prompts).toEqual([expect.objectContaining({ run_id: run.id, worker_id: worker.id, text: expect.stringContaining(resumed.question_revision) })]);
      expect((await f.agent(run.id, "consume", { worker_id: worker.id, revision: "stale" })).status).toBe(409);
      const consumed = await f.agent(run.id, "consume", { worker_id: worker.id, revision: resumed.question_revision }).then(r => r.json());
      expect(consumed.receipt).toMatchObject({ worker_id: worker.id, revision: resumed.question_revision });
      expect(f.workerLaunches).toHaveLength(1);
    } finally { f.close(); }
  });

  it("automatically recovers when a native permission prompt arrives between park acknowledgment and delivery", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Late native permission");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "late-permission" }).then(r => r.json());
      const q = await f.agent(run.id, "question", { question: "Which owned scope?" }).then(r => r.json());
      f.runs.get(run.id)!.condition = "ready";
      const detail = () => f.api(`/implementations/${id}`).then(r => r.json());
      await eventually(detail, d => d.runs[0].continuation?.condition === "parked");
      f.blockNextSend();
      await f.api(`/implementations/${id}/questions/${q.id}/answer`, { revision: q.revision, answer: "Retain native permissions" });
      await eventually(detail, d => d.runs[0].continuation?.condition === "parking" && d.runs[0].condition === "needs_you");
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(1);
      expect(f.prompts).toHaveLength(0);
      f.runs.get(run.id)!.condition = "ready";
      await eventually(detail, d => d.runs[0].continuation?.condition === "resumed");
      expect(f.prompts).toHaveLength(1);
      expect(f.launches).toEqual([run.id]);
    } finally { f.close(); }
  });

});
