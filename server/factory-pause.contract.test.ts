import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

async function eventually(read: () => Promise<any>, ready: (value: any) => boolean) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) { const value = await read(); if (ready(value)) return value; await Bun.sleep(30); }
  throw new Error("Assignment suspension did not reach the expected public state");
}
async function acceptedRun(f: Awaited<ReturnType<typeof capacityFixture>>, id: string) {
  const detail = await f.api(`/implementations/${id}`).then(r => r.json());
  await f.api(`/projects/${detail.implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned unpaid fixtures" });
  const spec = await f.api(`/implementations/${id}/specifications`, { content: "Two bounded Tickets preserve completed progress during Pause" }).then(r => r.json());
  for (const kind of ["specification", "testing_seams"]) await f.api(`/implementations/${id}/approvals`, { kind, revision: spec.id, scope: "Public API and desktop/mobile" });
  const graph = await f.api(`/implementations/${id}/tickets`, { specification_id: spec.id, tickets: ["one", "two"].map(key => ({ key, title: key, acceptance: "Owned completed progress", dependencies: [] })) }).then(r => r.json());
  await f.api(`/implementations/${id}/approvals`, { kind: "ticket_graph", revision: graph.hash, scope: "Two bounded Tickets" });
  const run = await f.api(`/implementations/${id}/runs`, { action: "implement-spec", idempotency_key: "root" }).then(r => r.json());
  return { run, graph };
}

describe("Assignment Pause and Resume through authenticated HTTP", () => {
  it("durably pauses an unfinished Assignment without an agent slot or changing its board lane", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const holder = await f.assignment("Capacity holder");
      await f.api(`/implementations/${holder}/runs`, { action: "work", idempotency_key: "holder" });
      const id = await f.assignment("Preserved queued work");
      await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "queued" });
      const pause = await f.api(`/implementations/${id}/pause`, {});
      expect(pause.status).toBe(200);
      expect(await pause.json()).toMatchObject({ id, stage: "inbox", pause: { condition: "paused" } });
      f.restart();
      const detail = await f.api(`/implementations/${id}`).then(r => r.json());
      expect(detail.implementation.pause.condition).toBe("paused");
      expect(detail.runs).toHaveLength(0);
      expect(detail.capacity_waiting).toHaveLength(1);
      expect((await f.api(`/implementations/${id}/resume`, {}).then(r => r.json())).pause).toBeUndefined();
      expect(f.launches).toHaveLength(1);
    } finally { f.close(); }
  });
  it("keeps Pause pending and reservations across restart until an offline Machine confirms all owned execution stopped", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Offline suspension");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "active" }).then(r => r.json());
      f.offline(true);
      const pause = await f.api(`/implementations/${id}/pause`, {}).then(r => r.json());
      expect(pause.pause.condition).toBe("pending");
      expect(pause.pause.reasons.join(" ")).toContain("owned-a");
      expect((await f.api(`/implementations/${id}/resume`, {})).status).toBe(409);
      f.restart();
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(1);
      expect((await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "blocked" })).status).toBe(409);
      f.offline(false);
      const detail = await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => d.implementation.pause?.condition === "paused");
      expect(detail.runs[0]).toMatchObject({ id: run.id, worktree: run.worktree, suspension: { condition: "stopped" } });
      expect(detail.native_snapshots).toHaveLength(1);
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(0);
      expect(f.launches).toHaveLength(1);
    } finally { f.close(); }
  });
  it("queues the retained unfinished Run on Resume and continues it once capacity returns without replaying a launch", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Resumable progress");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "original" }).then(r => r.json());
      await f.api(`/implementations/${id}/pause`, {});
      const other = await f.assignment("Resume capacity holder");
      const holder = await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      await f.api(`/implementations/${id}/resume`, {});
      f.restart();
      const read = () => f.api(`/implementations/${id}`).then(r => r.json());
      const queued = await read();
      expect(queued.runs[0].suspension.condition).toBe("stopped");
      expect(queued.capacity_waiting.some((w: any) => w.id.startsWith("suspension:"))).toBe(true);
      await f.api(`/runs/${holder.id}/stop`, {});
      const continued = await eventually(read, d => !d.runs[0].suspension);
      expect(continued.runs).toHaveLength(1);
      expect(continued.runs[0]).toMatchObject({ id: run.id, worktree: run.worktree, condition: "working" });
      expect(f.launches).toHaveLength(2);
      expect(continued.implementation.pause).toBeUndefined();
    } finally { f.close(); }
  });
  it("does not acknowledge Pause before a late root allocation is accounted for", async () => {
    const f = await capacityFixture();
    const gate = f.holdNextAllocation();
    try {
      const id = await f.assignment("Late root allocation");
      const start = f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "late" });
      const runId = await gate.started;
      expect((await f.api(`/implementations/${id}/pause`, {}).then(r => r.json())).pause.condition).toBe("pending");
      gate.release(); await start;
      const paused = await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => d.implementation.pause?.condition === "paused");
      expect(paused.runs[0]).toMatchObject({ id: runId, suspension: { condition: "stopped" } });
      f.restart();
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(0);
    } finally { gate.release(); f.close(); }
  });
  it("does not revive an attempt explicitly stopped while the Assignment was Paused", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Stopped progress");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "original" }).then(r => r.json());
      await f.api(`/implementations/${id}/pause`, {});
      await f.api(`/runs/${run.id}/stop`, {});
      await f.api(`/implementations/${id}/resume`, {});
      const detail = await f.api(`/implementations/${id}`).then(r => r.json());
      expect(detail.capacity_waiting).toHaveLength(0);
      expect(detail.runs[0].condition).toBe("cancelled");
    } finally { f.close(); }
  });
  it("retains an uncertain build reservation when the Machine has not acknowledged that build's shutdown", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Uncertain build shutdown");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "active" }).then(r => r.json());
      f.loseNextCheck(); f.unconfirmedBuildShutdown(true);
      expect((await f.api(`/runs/${run.id}/checks`, {}).then(r => r.json())).condition).toBe("interrupted");
      const paused = await f.api(`/implementations/${id}/pause`, {}).then(r => r.json());
      expect(paused.pause.condition).toBe("pending");
      expect((await f.api("").then(r => r.json())).capacity.builds.used).toBe(1);
    } finally { f.close(); }
  });
  it("keeps a confirmed child shutdown when its stale allocation response arrives after Pause", async () => {
    const f = await capacityFixture();
    const gate = f.holdNextAllocation(true);
    try {
      const id = await f.assignment("Late child allocation");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "root" }).then(r => r.json());
      const allocation = f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "late-child" });
      const workerId = await gate.started;
      await f.api(`/implementations/${id}/pause`, {});
      gate.release(); await allocation;
      const detail = await f.api(`/implementations/${id}`).then(r => r.json());
      expect(detail.implementation.pause.condition).toBe("paused");
      expect(detail.workers[0]).toMatchObject({ id: workerId, suspension: { condition: "stopped" } });
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(0);
    } finally { gate.release(); f.close(); }
  });
  it("observes a lost Resume acknowledgment after restart without launching the continuation twice", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Lost Resume acknowledgment");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "root" }).then(r => r.json());
      await f.api(`/implementations/${id}/pause`, {});
      f.uncertain(true); f.loseNextResume();
      await f.api(`/implementations/${id}/resume`, {});
      const read = () => f.api(`/implementations/${id}`).then(r => r.json());
      await eventually(read, d => d.runs[0].suspension?.condition === "uncertain");
      f.restart();
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(1);
      f.uncertain(false);
      const observed = await eventually(read, d => !d.runs[0].suspension);
      expect(observed.runs[0].id).toBe(run.id);
      expect(f.resumptions).toEqual([run.id]);
    } finally { f.close(); }
  }, 15_000);
  it("resumes only unfinished Tickets while preserving completed Tickets, approvals and check evidence", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Completed progress");
      const { run, graph } = await acceptedRun(f, id);
      const worker = await f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: graph.tickets[0].id, idempotency_key: "completed" }).then(r => r.json());
      f.workers.get(worker.id)!.condition = "ready";
      await f.api(`/runs/${run.id}/workers/${worker.id}/refresh`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/check`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/integrate`, {});
      const unfinished = await f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: graph.tickets[1].id, idempotency_key: "unfinished" }).then(r => r.json());
      const before = await f.api(`/implementations/${id}`).then(r => r.json());
      await f.api(`/implementations/${id}/pause`, {});
      f.restart();
      await f.api(`/implementations/${id}/resume`, {});
      const after = await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => !d.runs[0].suspension && !d.workers.find((w: any) => w.id === unfinished.id).suspension);
      expect(after.workers.find((w: any) => w.id === worker.id).condition).toBe("completed");
      expect(after.approvals).toEqual(before.approvals);
      expect(after.checks).toEqual(before.checks);
      expect(f.resumptions.sort()).toEqual([unfinished.id, run.id].sort());
      expect(after.tickets[0].status).toBe("done");
    } finally { f.close(); }
  });
  it("blocks stale accepted scope on Resume while retaining its work and original approvals", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Changed accepted revision");
      const { run } = await acceptedRun(f, id);
      await f.api(`/implementations/${id}/pause`, {});
      await f.api(`/implementations/${id}/specifications`, { content: "A changed Specification requires its own authority" });
      await f.api(`/implementations/${id}/resume`, {});
      const blocked = await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => d.capacity_waiting.some((w: any) => w.condition === "blocked"));
      expect(blocked.runs[0]).toMatchObject({ id: run.id, worktree: run.worktree, suspension: { condition: "stopped" } });
      expect(blocked.capacity_waiting[0].reason).toContain("accepted scope changed");
      expect(f.resumptions).toHaveLength(0);
    } finally { f.close(); }
  });
  it("replaces an old parked-answer continuation when owner Resume restores the stopped conversation", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Paused parked answer");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "root" }).then(r => r.json());
      const question = await f.agent(run.id, "question", { question: "Which retained scope?" }).then(r => r.json());
      f.runs.get(run.id)!.condition = "ready";
      const read = () => f.api(`/implementations/${id}`).then(r => r.json());
      await eventually(read, d => d.runs[0].continuation?.condition === "parked");
      const other = await f.assignment("Answer holder");
      const holder = await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      await f.api(`/implementations/${id}/questions/${question.id}/answer`, { revision: question.revision, answer: "The original approved scope" });
      await eventually(read, d => d.runs[0].continuation?.condition === "queued");
      await f.api(`/implementations/${id}/pause`, {});
      await f.api(`/implementations/${id}/resume`, {});
      await f.api(`/runs/${holder.id}/stop`, {});
      await eventually(read, d => !d.runs[0].suspension);
      expect(f.prompts).toHaveLength(0);
      expect(f.resumptions).toEqual([run.id]);
    } finally { f.close(); }
  });
  it("carries captured native history into the retained continuation instead of starting without the unfinished discussion", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Preserved discussion");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "root" }).then(r => r.json());
      f.setTranscript({ source_id: "owned-resume-discussion", version: "v1", cursor: null, turns: [{ role: "assistant", ts: "2026-10-15T12:00:00Z", parts: [{ kind: "text", text: "The remaining work is to validate the retained change against the approved Specification." }] }] });
      await f.api(`/implementations/${id}/pause`, {});
      await f.api(`/implementations/${id}/resume`, {});
      await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => !d.runs[0].suspension);
      expect(f.resumeHistories).toEqual([expect.stringContaining("The remaining work is to validate the retained change against the approved Specification.")]);
      expect(f.resumptions).toEqual([run.id]);
    } finally { f.close(); }
  });
  it("automatically continues a Resume that the offline Machine confirms never started", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Resume while offline");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "root" }).then(r => r.json());
      await f.api(`/implementations/${id}/pause`, {});
      f.offline(true);
      await f.api(`/implementations/${id}/resume`, {});
      const read = () => f.api(`/implementations/${id}`).then(r => r.json());
      await eventually(read, d => d.runs[0].suspension?.condition === "uncertain");
      f.restart(); f.offline(false);
      await eventually(read, d => !d.runs[0].suspension);
      expect(f.resumptions).toEqual([run.id]);
    } finally { f.close(); }
  }, 15_000);
  it("retains a reservation for a previously resting context while its offline shutdown is uncertain", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Resting shutdown uncertainty");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "root" }).then(r => r.json());
      f.runs.get(run.id)!.condition = "ready";
      await f.api(`/runs/${run.id}/reconcile`, {});
      f.offline(true);
      await f.api(`/implementations/${id}/pause`, {});
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(1);
    } finally { f.close(); }
  });
  it("keeps a Start queued when Pause arrives during admission before a native reservation exists", async () => {
    const f = await capacityFixture();
    const gate = f.holdNextAdmission();
    try {
      const id = await f.assignment("Pause during admission");
      const starting = f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "root" });
      await gate.started;
      await f.api(`/implementations/${id}/pause`, {});
      gate.release(); await starting;
      const paused = await f.api(`/implementations/${id}`).then(r => r.json());
      expect(paused.capacity_waiting[0].condition).toBe("queued");
      expect(paused.runs).toHaveLength(0);
      await f.api(`/implementations/${id}/resume`, {});
      const resumed = await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => d.runs.length === 1 && d.runs[0].condition === "working");
      expect(resumed.runs[0].condition).toBe("working");
      expect(f.launches).toHaveLength(1);
    } finally { gate.release(); f.close(); }
  });
  it("does not use the extra pre-approval planning allowance to resume an already accepted Specification", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Accepted Specification continuation");
      const run = await f.api(`/implementations/${id}/runs`, { action: "to-spec", idempotency_key: "draft" }).then(r => r.json());
      const specification = await f.api(`/implementations/${id}/specifications`, { content: "The accepted current scope" }).then(r => r.json());
      await f.api(`/implementations/${id}/approvals`, { kind: "specification", revision: specification.id, scope: "The current scope" });
      await f.api(`/implementations/${id}/pause`, {});
      const other = await f.assignment("Normal capacity holder");
      await f.api(`/implementations/${other}/runs`, { action: "work", idempotency_key: "holder" });
      await f.api(`/implementations/${id}/resume`, {});
      const detail = await eventually(() => f.api(`/implementations/${id}`).then(r => r.json()), d => !d.runs[0].suspension || d.capacity_waiting.some((w: any) => w.reason.includes("normal 1/1")));
      expect(detail.runs[0].suspension?.condition).toBe("stopped");
      expect((await f.api("").then(r => r.json())).capacity.planning.used).toBe(0);
      expect(f.resumptions).not.toContain(run.id);
    } finally { f.close(); }
  });
});
