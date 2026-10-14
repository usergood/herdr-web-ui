import type { FactoryRun, FactoryWorker, RunCondition } from "../shared/factory.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Resting chats retain ownership, but consume no execution capacity. */
function consumesCapacity(condition: RunCondition): boolean {
  return !["ready", "completed", "cancelled", "failed"].includes(condition);
}

export function factoryCapacity(store: FactoryStore): { implementations: Set<string>; agents: number } {
  const runs = store.list<FactoryRun>("runs");
  const activeRuns = runs.filter(run => consumesCapacity(run.condition));
  const uncertainPauses = new Set(runs.filter(run => run.scope_pause && run.scope_pause.condition !== "paused").map(run => run.id));
  const workers = store.list<FactoryWorker>("workers").filter(worker => consumesCapacity(worker.condition) || worker.condition === "ready" && uncertainPauses.has(worker.run_id));
  const implementations = new Set(activeRuns.map(run => run.implementation_id));
  const parents = new Map(runs.map(run => [run.id, run.implementation_id]));
  for (const worker of workers) {
    const id = parents.get(worker.run_id);
    if (id) implementations.add(id);
  }
  return { implementations, agents: activeRuns.length + workers.length };
}
