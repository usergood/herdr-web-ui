import type { FactoryRun, FactoryWorker, Implementation, RunCondition } from "../shared/factory.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Resting chats release capacity unless stopping still needs confirmation. */
function consumesCapacity(condition: RunCondition, stopPending = false): boolean {
  return condition === "ready" ? stopPending : !["completed", "cancelled", "failed"].includes(condition);
}

export function factoryCapacity(store: FactoryStore): { implementations: Set<string>; agents: number } {
  const runs = store.list<FactoryRun>("runs");
  const discards = new Set(store.list<Implementation>("implementations").filter(idea => idea.discard_requested_at && idea.outcome !== "discarded").map(idea => idea.id));
  const uncertainPauses = new Set(runs.filter(run => run.scope_pause && run.scope_pause.condition !== "paused").map(run => run.id));
  const parents = new Map(runs.map(run => [run.id, run.implementation_id]));
  const activeRuns = runs.filter(run => consumesCapacity(run.condition, discards.has(run.implementation_id)));
  const workers = store.list<FactoryWorker>("workers").filter(worker => consumesCapacity(worker.condition, discards.has(parents.get(worker.run_id) ?? "") || uncertainPauses.has(worker.run_id)));
  const implementations = new Set(activeRuns.map(run => run.implementation_id));
  for (const worker of workers) {
    const id = parents.get(worker.run_id);
    if (id) implementations.add(id);
  }
  return { implementations, agents: activeRuns.length + workers.length };
}
