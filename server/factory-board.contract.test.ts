import { describe, expect, it } from "bun:test";
import { boardRepair, boardScenario } from "../scripts/factory-board-fixture.ts";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

describe("Assignment board through authenticated HTTP", () => {
  it("names running Tickets and explains dependencies, then retains integrated completion across restart", async () => {
    const f = await capacityFixture();
    try {
      const { id, run, worker, graph } = await boardScenario(f);
      const progress = () => f.api("").then(r => r.json()).then(o => o.progress.find((p: any) => p.implementation_id === id));
      expect(await progress()).toMatchObject({
        lane: "running", activities: ["implementing"], counts: { waiting: 1, running: 1, completed: 0 },
        tickets: [
          { ticket_id: graph.tickets[0].id, title: "Transport progress", state: "running" },
          { title: "Dependent view", state: "waiting", reason: "Waiting for dependencies: Transport progress" },
        ],
      });
      await f.api(`/runs/${run.id}/workers/${worker.id}/refresh`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/check`, {});
      expect((await f.api(`/runs/${run.id}/workers/${worker.id}/integrate`, {})).status).toBe(200);
      f.restart();
      expect(await progress()).toMatchObject({ counts: { waiting: 1, running: 0, completed: 1 }, tickets: [{ state: "completed" }, { state: "waiting" }] });
      expect((await f.api(`/implementations/${id}`).then(r => r.json())).runs[0].id).toBe(run.id);
    } finally { f.close(); }
  });
  it("shows overlapping worker, check and review activities and stops claiming execution after verified Pause", async () => {
    const f = await capacityFixture();
    const gate = f.holdNextCheck();
    let check: Promise<Response> | undefined;
    try {
      const { id, run, worker } = await boardScenario(f);
      check = f.api(`/runs/${run.id}/checks`, {});
      await gate.started;
      const progress = () => f.api("").then(r => r.json()).then(o => o.progress.find((p: any) => p.implementation_id === id));
      expect((await progress()).activities).toEqual(["implementing", "testing"]);
      gate.release(); await check;
      await f.api(`/runs/${run.id}/workers/${worker.id}/refresh`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/check`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/integrate`, {});
      const reviewer = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "review" });
      expect(reviewer.status).toBe(200);
      expect((await progress()).activities).toEqual(["auto_review"]);
      const reviewWorker = await reviewer.json();
      f.workers.get(reviewWorker.id)!.condition = "failed";
      f.workers.get(reviewWorker.id)!.waiting_reason = "Standards reviewer disconnected";
      await f.api(`/runs/${run.id}/workers/${reviewWorker.id}/reconcile`, {});
      expect((await progress()).reasons).toContain("Standards reviewer disconnected");
      await f.api(`/implementations/${id}/pause`, {});
      f.restart();
      expect(await progress()).toMatchObject({ activities: [], counts: { waiting: 1, running: 0, completed: 1 } });
    } finally { gate.release(); await check; f.close(); }
  });

  it("exposes queued capacity and failed child reasons without claiming that retained work is running", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 2 });
      const { id, run, worker, graph } = await boardScenario(f);
      await f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: graph.tickets[1].id, shared_paths: [], idempotency_key: "dependent" });
      const queuedId = await f.assignment("Waiting oldest request");
      await f.api(`/implementations/${queuedId}/runs`, { action: "work", idempotency_key: "queued" });
      const overview = () => f.api("").then(r => r.json());
      const queued = (await overview()).progress.find((p: any) => p.implementation_id === queuedId);
      expect(queued).toMatchObject({ lane: "queued", activities: [], counts: { waiting: 0, running: 0, completed: 0 } });
      expect(queued.reasons.join(" ")).toContain("capacity");
      const native = f.workers.get(worker.id)!;
      native.condition = "failed"; native.waiting_reason = "Transport compiler failed";
      await f.api(`/runs/${run.id}/workers/${worker.id}/reconcile`, {});
      const progress = (await overview()).progress.find((p: any) => p.implementation_id === id);
      expect(progress).toMatchObject({ lane: "needs_you", activities: [], counts: { waiting: 2, running: 0, completed: 0 }, tickets: [{ state: "waiting", reason: "Transport compiler failed" }, { state: "waiting" }] });
      expect(progress.tickets[1].reason).toContain("Transport progress");
      expect(progress.reasons).toContain("Transport compiler failed");
    } finally { f.close(); }
  });

  it("keeps the executing Ticket scope visible when a newer Specification is drafted", async () => {
    const f = await capacityFixture();
    try {
      const { id } = await boardScenario(f);
      await f.api(`/implementations/${id}/specifications`, { content: "A later unapproved draft must not erase executing work" });
      const progress = (await f.api("").then(r => r.json())).progress.find((p: any) => p.implementation_id === id);
      expect(progress).toMatchObject({ counts: { waiting: 1, running: 1, completed: 0 }, tickets: [{ title: "Transport progress", state: "running" }, { title: "Dependent view" }] });
    } finally { f.close(); }
  });

  it("refuses manual priority changes and retains creation order across restart", async () => {
    const f = await capacityFixture();
    try {
      const first = await f.assignment("First captured");
      const second = await f.assignment("Second captured");
      const reorder = await f.api(`/implementations/${second}/order`, { before_id: first });
      expect(reorder.status).toBe(409);
      expect(await reorder.json()).toMatchObject({ error: { code: "automatic_order" } });
      f.restart();
      expect((await f.api("").then(r => r.json())).implementations.map((idea: any) => idea.id)).toEqual([first, second]);
    } finally { f.close(); }
  });

  it("shows fresh repair work as Fixing and keeps its failed Ticket unfinished despite earlier integration", async () => {
    const f = await capacityFixture();
    try {
      const { id, run, worker, graph } = await boardScenario(f);
      await f.api(`/runs/${run.id}/workers/${worker.id}/refresh`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/check`, {});
      await f.api(`/runs/${run.id}/workers/${worker.id}/integrate`, {});
      const repair = await boardRepair(f, id, run.id, graph.tickets[0].id);
      const progress = () => f.api("").then(r => r.json()).then(o => o.progress.find((p: any) => p.implementation_id === id));
      expect(await progress()).toMatchObject({ activities: ["fixing"], counts: { waiting: 1, running: 1, completed: 0 } });
      f.workers.get(repair.id)!.condition = "failed";
      f.workers.get(repair.id)!.waiting_reason = "Repair compilation failed";
      await f.api(`/runs/${run.id}/workers/${repair.id}/reconcile`, {});
      expect(await progress()).toMatchObject({ lane: "needs_you", activities: [], counts: { waiting: 2, running: 0, completed: 0 }, tickets: [{ state: "waiting", reason: "Repair compilation failed" }, { state: "waiting" }] });
    } finally { f.close(); }
  });

  it("orders queued cards by request age even when Assignments were captured in the opposite order", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const older = await f.assignment("Captured earlier but requested last");
      const newer = await f.assignment("Captured later but requested first");
      const holder = await f.assignment("Slot holder");
      await f.api(`/implementations/${holder}/runs`, { action: "work", idempotency_key: "holder" });
      await f.api(`/implementations/${newer}/runs`, { action: "work", idempotency_key: "first-request" });
      await f.api(`/implementations/${older}/runs`, { action: "work", idempotency_key: "last-request" });
      const overview = await f.api("").then(r => r.json());
      expect(overview.implementations.filter((idea: any) => [older, newer].includes(idea.id)).map((idea: any) => idea.id)).toEqual([newer, older]);
    } finally { f.close(); }
  });

  it("keeps Paused separate from queued and Needs you lanes", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const holder = await f.assignment("Occupied slot");
      const run = await f.api(`/implementations/${holder}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      const queued = await f.assignment("Paused queued request");
      await f.api(`/implementations/${queued}/runs`, { action: "work", idempotency_key: "queued" });
      await f.api(`/implementations/${queued}/pause`, {});
      f.runs.get(run.id)!.condition = "failed";
      f.runs.get(run.id)!.waiting_reason = "Compiler failed before Pause";
      await f.api(`/runs/${run.id}/reconcile`, {});
      await f.api(`/implementations/${holder}/pause`, {});
      const overview = await f.api("").then(r => r.json());
      expect(overview.progress.find((p: any) => p.implementation_id === queued)).toMatchObject({ lane: "queued", activities: [] });
      expect(overview.progress.find((p: any) => p.implementation_id === holder)).toMatchObject({ lane: "needs_you", activities: [] });
    } finally { f.close(); }
  });

  it("explains failed checks but does not carry a stopped attempt's failures into new work", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Fresh work after a failed attempt");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "first" }).then(r => r.json());
      f.failNextCheck();
      await f.api(`/runs/${run.id}/checks`, {});
      const progress = () => f.api("").then(r => r.json()).then(o => o.progress.find((p: any) => p.implementation_id === id));
      expect((await progress()).reasons).toContain("Checks failed: bun test (exit 1)");
      await f.api(`/runs/${run.id}/stop`, {});
      await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "fresh" });
      expect(await progress()).toMatchObject({ lane: "running", activities: ["implementing"], reasons: [] });
    } finally { f.close(); }
  });

});
