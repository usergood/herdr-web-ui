import type { FactoryApproval, FactoryCheck, FactoryRun, FactoryWorker, Implementation, RunCondition } from "../shared/factory.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Resting chats release capacity unless stopping still needs confirmation. */
function consumesCapacity(condition: RunCondition, stopPending = false): boolean {
  return condition === "ready" ? stopPending : !["completed", "cancelled", "failed"].includes(condition);
}

export function factoryCapacity(store: FactoryStore): { implementations: Set<string>; implementing: Set<string>; agents: number; builds: number } {
  const runs = store.list<FactoryRun>("runs");
  const discards = new Set(store.list<Implementation>("implementations").filter(idea => idea.discard_requested_at && idea.outcome !== "discarded").map(idea => idea.id));
  const uncertainPauses = new Set(runs.filter(run => run.scope_pause && run.scope_pause.condition !== "paused").map(run => run.id));
  const parents = new Map(runs.map(run => [run.id, run.implementation_id]));
  const activeRuns = runs.filter(run => consumesCapacity(run.condition, discards.has(run.implementation_id)));
  const workers = store.list<FactoryWorker>("workers").filter(worker => consumesCapacity(worker.condition, discards.has(parents.get(worker.run_id) ?? "") || uncertainPauses.has(worker.run_id)));
  const implementations = new Set(activeRuns.map(run => run.implementation_id));
  const implementingRuns = new Map(runs.filter(run => ["work", "implement-spec"].includes(run.action)).map(run => [run.id, run.implementation_id]));
  const implementing = new Set(activeRuns.filter(run => implementingRuns.has(run.id)).map(run => run.implementation_id));
  // Checked, independently reviewed retirement releases the implementing slot;
  // uncertain retirement, children and builds retain it.
  for (const id of implementingAssignments(store, runs.filter(run => run.action === "implement-spec"))) { implementations.add(id); implementing.add(id); }
  for (const worker of workers) {
    const id = parents.get(worker.run_id);
    if (id) implementations.add(id);
    const implementingId = implementingRuns.get(worker.run_id);
    if (implementingId) implementing.add(implementingId);
  }
  const builds = store.list<FactoryCheck>("checks").filter(check => ["working", "interrupted"].includes(check.condition));
  for (const check of builds) { const id = parents.get(check.run_id); if (id) implementations.add(id); const implementingId = implementingRuns.get(check.run_id); if (implementingId) implementing.add(implementingId); }
  return { implementations, implementing, agents: activeRuns.length + workers.length, builds: builds.length };
}

/** A native completion is not evidence that checked implementation and review finished. */
export function implementingAssignments(store: FactoryStore, runs: FactoryRun[]): Set<string> {
  // Historical owner acceptance already retired execution before completion receipts
  // existed. Keep that released slot without revalidating cleaned workspaces.
  const accepted = (run: FactoryRun) => store.list<FactoryApproval>("approvals", run.implementation_id).some(approval => approval.kind === "review" && approval.scope.startsWith(`Run ${run.id};`));
  const owners = new Set(runs.filter(run => run.implementation_completion_pending || !["completed", "failed", "cancelled"].includes(run.condition) || run.condition === "completed" && !run.implementation_completion && !accepted(run)).map(run => run.implementation_id));
  const parents = new Map(runs.map(run => [run.id, run.implementation_id]));
  for (const worker of store.list<FactoryWorker>("workers")) if (parents.has(worker.run_id) && !["completed", "failed", "cancelled"].includes(worker.condition)) owners.add(parents.get(worker.run_id)!);
  for (const check of store.list<FactoryCheck>("checks")) if (parents.has(check.run_id) && ["working", "interrupted"].includes(check.condition)) owners.add(parents.get(check.run_id)!);
  return owners;
}
