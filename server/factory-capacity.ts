import type { FactoryCapacity, FactoryCapacityReservation, FactoryCapacityWait, FactoryCheck, FactoryRun, FactorySettings, FactoryTicket, FactoryWorker, Implementation, RunCondition } from "../shared/factory.ts";
import { FactoryError } from "./factory-host.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Resting chats retain ownership, but consume no execution capacity. */
function consumesCapacity(condition: RunCondition): boolean {
  return !["ready", "completed", "cancelled", "failed"].includes(condition);
}

/** Only app-owned reservations count; never infer execution from the terminal roster. */
export function factoryCapacity(store: FactoryStore, settings: FactorySettings): FactoryCapacity {
  const runs = store.list<FactoryRun>("runs");
  const parents = new Map(runs.map(run => [run.id, run]));
  const assignments = new Map(store.list<Implementation>("implementations").map(idea => [idea.id, idea]));
  const reservation = (id: string, run: FactoryRun | undefined, workerId: string | null, label: string, condition: string, reason: string | null): FactoryCapacityReservation => {
    const idea = run ? assignments.get(run.implementation_id) : undefined;
    return { id, run_id: run?.id ?? "", worker_id: workerId, implementation_id: run?.implementation_id ?? "", assignment_title: idea?.title ?? run?.implementation_id ?? id, project_id: idea?.project_id ?? null, machine_id: run?.machine_id ?? "unknown", provider: run?.provider ?? "codex", label, condition, uncertain: ["accepted", "disconnected", "interrupted"].includes(condition), reason };
  };
  const contexts: FactoryCapacity["contexts"] = runs.filter(run => consumesCapacity(run.condition)).map(run => ({ ...reservation(run.id, run, null, run.action, run.condition, run.waiting_reason), pool: run.capacity_pool ?? "normal" }));
  for (const worker of store.list<FactoryWorker>("workers").filter(worker => consumesCapacity(worker.condition))) {
    const run = parents.get(worker.run_id);
    const ticket = (run?.manifest as { tickets?: FactoryTicket[] } | undefined)?.tickets?.find(ticket => ticket.id === worker.ticket_id);
    contexts.push({ ...reservation(worker.id, run, worker.id, ticket?.title ?? worker.role, worker.condition, worker.waiting_reason), run_id: worker.run_id, pool: "normal" });
  }
  const builds = store.list<FactoryCheck>("checks").filter(check => ["working", "interrupted"].includes(check.condition)).map(check => ({ ...reservation(check.id, parents.get(check.run_id), check.worker_id, "check", check.condition, null), run_id: check.run_id }));
  const waiting = store.list<FactoryCapacityWait & { request: unknown; origin: string; contract_hash: string }>("capacity_waits").map(({ request: _request, origin: _origin, contract_hash: _contract, ...wait }) => wait);
  return { normal: { limit: settings.max_agents, used: contexts.filter(context => context.pool === "normal").length }, planning: { limit: 1, used: contexts.filter(context => context.pool === "planning").length }, builds: { limit: settings.max_builds, used: builds.length }, contexts, build_reservations: builds, waiting };
}

/** Call inside the same immediate transaction that records the accepted identity. */
export function agentCapacityPool(store: FactoryStore, settings: FactorySettings, planning = false): "normal" | "planning" {
  const capacity = factoryCapacity(store, settings);
  if (capacity.normal.used < capacity.normal.limit) return "normal";
  if (planning && capacity.planning.used < capacity.planning.limit) return "planning";
  const occupants = capacity.contexts.map(context => `${context.assignment_title} / ${context.label} [${context.machine_id}, ${context.provider}, ${context.condition}${context.uncertain ? ", uncertain" : ""}]${context.reason ? `: ${context.reason}` : ""}`).join("; ");
  throw new FactoryError("capacity_exhausted", `Waiting for agent capacity: normal ${capacity.normal.used}/${capacity.normal.limit}, extra planning ${capacity.planning.used}/1, builds ${capacity.builds.used}/${capacity.builds.limit}. ${occupants}`, 409);
}
