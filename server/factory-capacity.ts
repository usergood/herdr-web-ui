import type { FactoryRun, FactoryWorker, Implementation, RunCondition } from "../shared/factory.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Resting chats release capacity unless Discard still needs stop confirmation. */
function consumesCapacity(condition: RunCondition, discardPending = false): boolean {
  return condition === "ready" ? discardPending : !["completed", "cancelled", "failed"].includes(condition);
}

export function factoryCapacity(store: FactoryStore): { implementations: Set<string>; agents: number } {
  const runs = store.list<FactoryRun>("runs");
  const discards = new Set(store.list<Implementation>("implementations").filter(idea => idea.discard_requested_at && idea.outcome !== "discarded").map(idea => idea.id));
  const parents = new Map(runs.map(run => [run.id, run.implementation_id]));
  const activeRuns = runs.filter(run => consumesCapacity(run.condition, discards.has(run.implementation_id)));
  const workers = store.list<FactoryWorker>("workers").filter(worker => consumesCapacity(worker.condition, discards.has(parents.get(worker.run_id) ?? "")));
  const implementations = new Set(activeRuns.map(run => run.implementation_id));
  for (const worker of workers) {
    const id = parents.get(worker.run_id);
    if (id) implementations.add(id);
  }
  return { implementations, agents: activeRuns.length + workers.length };
}
