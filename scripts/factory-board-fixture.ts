import type { capacityFixture } from "./factory-capacity-fixture.ts";

/** Exercise only authenticated app HTTP and owned Machine responses. */
export async function boardScenario(f: Awaited<ReturnType<typeof capacityFixture>>) {
  const id = await f.assignment("Named child progress");
  const detail = await f.api(`/implementations/${id}`).then(r => r.json());
  await f.api(`/projects/${detail.implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned unpaid fixtures" });
  const spec = await f.api(`/implementations/${id}/specifications`, { content: "Implement transport before the dependent view" }).then(r => r.json());
  for (const kind of ["specification", "testing_seams"]) await f.api(`/implementations/${id}/approvals`, { kind, revision: spec.id, scope: "Public HTTP and desktop/mobile board" });
  const graph = await f.api(`/implementations/${id}/tickets`, { specification_id: spec.id, tickets: [
    { key: "transport", title: "Transport progress", acceptance: "Expose progress", dependencies: [] },
    { key: "view", title: "Dependent view", acceptance: "Render progress", dependencies: ["transport"] },
  ] }).then(r => r.json());
  await f.api(`/implementations/${id}/approvals`, { kind: "ticket_graph", revision: graph.hash, scope: "Two bounded Tickets" });
  const run = await f.api(`/implementations/${id}/runs`, { action: "implement-spec", idempotency_key: "root" }).then(r => r.json());
  const worker = await f.api(`/runs/${run.id}/workers`, { role: "implementer", ticket_id: graph.tickets[0].id, shared_paths: [], idempotency_key: "transport" }).then(r => r.json());
  return { id, run, worker, graph };
}

/** Submit real revision-bound feedback and allocate its fresh repair through HTTP. */
export async function boardRepair(f: Awaited<ReturnType<typeof capacityFixture>>, id: string, runId: string, ticketId: string) {
  const snapshot = await f.api(`/implementations/${id}/snapshots`, { mode: "branch", run_id: runId }).then(r => r.json());
  const comment = await f.api(`/implementations/${id}/comments`, { snapshot_id: snapshot.id, path: "progress.ts", side: "new", line_start: 1, line_end: 1, content: "Repair the progress explanation" }).then(r => r.json());
  const batch = await f.api(`/implementations/${id}/request-changes`, { run_id: runId, snapshot_id: snapshot.id, comment_ids: [comment.id], idempotency_key: "board-feedback" }).then(r => r.json());
  if (batch.status !== "sent") throw new Error(`Owned feedback was not delivered: ${JSON.stringify(batch)}`);
  const worker = await f.api(`/runs/${runId}/workers`, { role: "implementer", ticket_id: ticketId, review_batch_id: batch.id, shared_paths: [], idempotency_key: "board-repair" }).then(r => r.json());
  if (!worker.id || worker.rework_batch_id !== batch.id) throw new Error(`Owned repair was not admitted: ${JSON.stringify(worker)}`);
  return worker;
}
