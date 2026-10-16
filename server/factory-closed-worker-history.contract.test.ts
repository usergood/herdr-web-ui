import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

async function until(read: () => Promise<any>, ready: (value: any) => boolean): Promise<any> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Worker history did not settle: ${JSON.stringify({ execution: value.automatic_execution, review: value.automatic_review, workers: value.workers })}`);
    await Bun.sleep(20);
  }
}

async function accepted(f: Awaited<ReturnType<typeof capacityFixture>>) {
  await f.api("/settings", { max_agents: 1 });
  const id = await f.assignment("Preserve completed worker conversations");
  const detail = () => f.api(`/implementations/${id}`).then(r => r.json());
  await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixtures only" });
  const specification = await f.api(`/implementations/${id}/specifications`, { content: "Retain named native context history" }).then(r => r.json());
  await f.api(`/implementations/${id}/specification-acceptance`, { source: "button", specification_id: specification.id, hash: specification.hash });
  const run = (await until(detail, d => d.runs.length === 1)).runs[0];
  await f.agent(run.id, "tickets", { specification_id: specification.id, testing_plan: "Authenticated HTTP and desktop/mobile", tickets: [{ key: "history", title: "Keep the completed context", acceptance: "History remains readable after close", dependencies: [] }] });
  f.runs.get(run.id)!.condition = "ready";
  const worker = (await until(detail, d => d.workers.length === 1 && d.workers[0].condition === "working")).workers[0];
  return { id, run, worker, detail };
}

const page = (worker: { id: string; role: string }, before?: string) => ({ source_id: `owned-history:${worker.id}`, version: "recorded-v1", cursor: before ? null : "older-context", turns: [{ role: "assistant" as const, ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text" as const, text: `${before ? "Earlier" : "Final"} ${worker.role} context retained automatically` }] }] });

describe("Closed native worker history through authenticated HTTP", () => {
  it("automatically retains every owned remote implementation history page before integration and close, including after restart", async () => {
    const f = await capacityFixture({ advancingHeads: true, workerTranscript: page });
    try {
      const { worker, detail } = await accepted(f);
      f.workers.get(worker.id)!.condition = "ready";
      const completed = await until(detail, d => d.workers[0].condition === "completed");
      expect(f.closedWorkers.has(worker.id)).toBe(true);
      expect(completed.native_snapshots.filter((s: any) => s.worker_id === worker.id).map((s: any) => s.turns[0].parts[0].text).sort()).toEqual(["Earlier implementer context retained automatically", "Final implementer context retained automatically"]);
      f.restart();
      const retained = await detail();
      const named = retained.conversations.find((c: any) => c.title === "Keep the completed context");
      expect(named.contexts[0]).toMatchObject({ worker_id: worker.id, snapshot_ids: expect.arrayContaining(completed.native_snapshots.filter((s: any) => s.worker_id === worker.id).map((s: any) => s.id)) });
      expect(retained.events.filter((e: any) => e.kind === "ticket_integrated")).toHaveLength(1);
    } finally { f.close(); }
  });
  it("retains each independent report and full named review conversation before native close without a manual import", async () => {
    const f = await capacityFixture({ advancingHeads: true, workerTranscript: page });
    try {
      const { worker, detail } = await accepted(f);
      f.workers.get(worker.id)!.condition = "ready";
      for (const role of ["standards", "spec"]) {
        const reviewing = await until(detail, d => d.workers.some((w: any) => w.role === role && w.condition === "working"));
        const reviewer = reviewing.workers.find((w: any) => w.role === role);
        if (role === "standards") f.loseNextStop();
        f.workers.get(reviewer.id)!.condition = "ready";
        const finished = await until(detail, d => d.workers.find((w: any) => w.id === reviewer.id).condition === "completed");
        expect(f.closedWorkers.has(reviewer.id)).toBe(true);
        expect(finished.review_evidence.filter((r: any) => r.worker_id === reviewer.id)).toHaveLength(1);
        expect(finished.native_snapshots.filter((h: any) => h.worker_id === reviewer.id).map((h: any) => h.turns[0].parts[0].text).sort()).toEqual([`Earlier ${role} context retained automatically`, `Final ${role} context retained automatically`]);
      }
      f.restart();
      const retained = await detail();
      expect(retained.review_evidence).toHaveLength(2);
      for (const role of ["standards", "spec"]) expect(retained.conversations.find((c: any) => c.kind === role).contexts[0].snapshot_ids).toHaveLength(2);
      expect(f.workerLaunches).toHaveLength(3);
    } finally { f.close(); }
  });

  for (const role of ["implementer", "standards"]) it(`preserves an owned ${role} when an earlier history page is unavailable and recovers without replaying completed work`, async () => {
    let unavailable = true;
    const f = await capacityFixture({ advancingHeads: true, workerTranscript: (worker, before) => worker.role === role && before && unavailable ? null : page(worker, before) });
    try {
      const { worker, detail } = await accepted(f);
      f.workers.get(worker.id)!.condition = "ready";
      let target = worker;
      if (role === "standards") {
        const reviewing = await until(detail, d => d.workers.some((w: any) => w.role === role && w.condition === "working"));
        target = reviewing.workers.find((w: any) => w.role === role);
        f.workers.get(target.id)!.condition = "ready";
      }
      const pending = await until(detail, d => d.events.some((e: any) => e.kind === "worker_history_unavailable" && e.data.worker_id === target.id));
      expect(f.closedWorkers.has(target.id)).toBe(false);
      expect(pending.workers.find((w: any) => w.id === target.id)).toMatchObject({ condition: "ready", waiting_reason: expect.stringContaining("history could not be completely retained") });
      expect(pending.native_snapshots.filter((h: any) => h.worker_id === target.id)).toHaveLength(1);
      if (role === "implementer") expect(pending.events.filter((e: any) => e.kind === "ticket_integrated")).toHaveLength(0);
      else expect(pending.review_evidence.filter((r: any) => r.worker_id === target.id)).toHaveLength(1);
      unavailable = false; f.restart();
      const recovered = await until(detail, d => d.workers.find((w: any) => w.id === target.id).condition === "completed");
      expect(recovered.native_snapshots.filter((h: any) => h.worker_id === target.id)).toHaveLength(2);
      expect(recovered.events.filter((e: any) => e.kind === "ticket_integrated")).toHaveLength(1);
      expect(f.workerLaunches.filter(id => id === target.id)).toHaveLength(1);
      if (role === "standards") expect(recovered.review_evidence.filter((r: any) => r.worker_id === target.id)).toHaveLength(1);
    } finally { f.close(); }
  });

  it("keeps an owned worker available when its native context has no recorded conversation yet", async () => {
    const f = await capacityFixture({ workerTranscript: worker => ({ source_id: `owned-unwritten:${worker.id}`, version: "unwritten", cursor: null, turns: [] }) });
    try {
      const { worker, detail } = await accepted(f);
      f.workers.get(worker.id)!.condition = "ready";
      const pending = await until(detail, d => d.events.some((e: any) => e.kind === "worker_history_unavailable"));
      expect(f.closedWorkers.has(worker.id)).toBe(false);
      expect(pending.events.filter((e: any) => e.kind === "ticket_integrated")).toHaveLength(0);
      expect(pending.workers[0].condition).toBe("ready");
    } finally { f.close(); }
  });

});
