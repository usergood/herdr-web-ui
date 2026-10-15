import type { FactoryCheck, FactoryRun, FactoryWorker, RunCondition } from "../shared/factory.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Resting chats retain ownership, but consume no execution capacity. */
function consumesCapacity(condition: RunCondition): boolean {
  return !["ready", "completed", "cancelled", "failed"].includes(condition);
}

export function factoryCapacity(store: FactoryStore): { implementations: Set<string>; agents: number } {
  const runs = store.list<FactoryRun>("runs");
  const activeRuns = runs.filter(run => consumesCapacity(run.condition));
  const workers = store.list<FactoryWorker>("workers").filter(worker => consumesCapacity(worker.condition));
  const implementations = new Set(activeRuns.map(run => run.implementation_id));
  for (const id of implementingAssignments(store, runs.filter(run => run.action === "implement-spec"))) implementations.add(id);
  const parents = new Map(runs.map(run => [run.id, run.implementation_id]));
  for (const worker of workers) {
    const id = parents.get(worker.run_id);
    if (id) implementations.add(id);
  }
  return { implementations, agents: activeRuns.length + workers.length };
}

/** A native completion is not evidence that checked implementation and review finished. */
export function implementingAssignments(store: FactoryStore, runs: FactoryRun[]): Set<string> {
  const owners = new Set(runs.filter(run => run.implementation_completion_pending || !["completed", "failed", "cancelled"].includes(run.condition) || run.condition === "completed" && !run.implementation_completion).map(run => run.implementation_id));
  const parents = new Map(runs.map(run => [run.id, run.implementation_id]));
  for (const worker of store.list<FactoryWorker>("workers")) if (parents.has(worker.run_id) && !["completed", "failed", "cancelled"].includes(worker.condition)) owners.add(parents.get(worker.run_id)!);
  for (const check of store.list<FactoryCheck>("checks")) if (parents.has(check.run_id) && ["working", "interrupted"].includes(check.condition)) owners.add(parents.get(check.run_id)!);
  return owners;
}
