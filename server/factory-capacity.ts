import type { FactoryCheck, FactoryRun, FactoryWorker, RunCondition } from "../shared/factory.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Resting chats retain ownership, but consume no execution capacity. */
function consumesCapacity(condition: RunCondition): boolean {
  return !["ready", "completed", "cancelled", "failed"].includes(condition);
}

export function factoryCapacity(store: FactoryStore): { implementations: Set<string>; implementing: Set<string>; agents: number; builds: number } {
  const runs = store.list<FactoryRun>("runs");
  const activeRuns = runs.filter(run => consumesCapacity(run.condition));
  const uncertainPauses = new Set(runs.filter(run => run.scope_pause && run.scope_pause.condition !== "paused").map(run => run.id));
  const workers = store.list<FactoryWorker>("workers").filter(worker => consumesCapacity(worker.condition) || worker.condition === "ready" && uncertainPauses.has(worker.run_id));
  const implementations = new Set(activeRuns.map(run => run.implementation_id));
  const implementingRuns = new Map(runs.filter(run => ["work", "implement-spec"].includes(run.action)).map(run => [run.id, run.implementation_id]));
  const implementing = new Set(activeRuns.filter(run => implementingRuns.has(run.id)).map(run => run.implementation_id));
  // A resting implementation coordinator awaits verified completion, even though
  // its chat no longer consumes an agent slot.
  for (const run of runs) if (run.action === "implement-spec" && run.condition === "ready") { implementations.add(run.implementation_id); implementing.add(run.implementation_id); }
  const parents = new Map(runs.map(run => [run.id, run.implementation_id]));
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
