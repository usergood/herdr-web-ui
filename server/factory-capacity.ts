import type { FactoryApproval, FactoryCapacity, FactoryCapacityReservation, FactoryCapacityWait, FactoryCheck, FactoryRun, FactorySettings, FactoryTicket, FactoryWorker, Implementation } from "../shared/factory.ts";
import { FactoryError } from "./factory-host.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Retained ownership is independent of observed execution. */
function consumesCapacity(context: Pick<FactoryRun, "condition" | "continuation" | "suspension"> & Partial<Pick<FactoryRun, "scope_pause" | "implementation_completion_pending">>): boolean {
  if (context.implementation_completion_pending || context.scope_pause && context.scope_pause.condition !== "paused") return true;
  if (["completed", "cancelled", "failed"].includes(context.condition)) return false;
  if (context.suspension) return context.suspension.condition !== "stopped";
  if (["sending", "uncertain"].includes(context.continuation?.condition ?? "")) return true;
  if (["ready", "needs_you"].includes(context.condition) && ["parked", "queued"].includes(context.continuation?.condition ?? "")) return false;
  return context.condition !== "ready";
}

/** Only app-owned reservations count; never infer execution from the terminal roster. */
type LegacyCapacity = { implementations: Set<string>; implementing: Set<string>; agents: number; builds: number };
export function factoryCapacity(store: Pick<FactoryStore, "list">): LegacyCapacity;
export function factoryCapacity(store: Pick<FactoryStore, "list">, settings: FactorySettings): FactoryCapacity;
export function factoryCapacity(store: Pick<FactoryStore, "list">, settings?: FactorySettings): FactoryCapacity | LegacyCapacity {
  if (!settings) {
    const runs = store.list<FactoryRun>("runs");
    const parents = new Map(runs.map(run => [run.id, run]));
    const active = runs.filter(consumesCapacity);
    const workers = store.list<FactoryWorker>("workers").filter(consumesCapacity);
    const checks = store.list<FactoryCheck>("checks").filter(check => ["working", "interrupted"].includes(check.condition));
    const implementing = implementingAssignments(store, runs.filter(run => run.action === "implement-spec"));
    const implementations = new Set([...active.map(run => run.implementation_id), ...implementing]);
    for (const child of [...workers, ...checks]) { const parent = parents.get(child.run_id); if (parent) { implementations.add(parent.implementation_id); if (["work", "implement-spec"].includes(parent.action)) implementing.add(parent.implementation_id); } }
    return { implementations, implementing, agents: active.length + workers.length, builds: checks.length };
  }
  const runs = store.list<FactoryRun>("runs");
  const parents = new Map(runs.map(run => [run.id, run]));
  const assignments = new Map(store.list<Implementation>("implementations").map(idea => [idea.id, idea]));
  const reservation = (id: string, run: FactoryRun | undefined, workerId: string | null, label: string, condition: string, reason: string | null): FactoryCapacityReservation => {
    const idea = run ? assignments.get(run.implementation_id) : undefined;
    return { id, run_id: run?.id ?? "", worker_id: workerId, implementation_id: run?.implementation_id ?? "", assignment_title: idea?.title ?? run?.implementation_id ?? id, project_id: idea?.project_id ?? null, machine_id: run?.machine_id ?? "unknown", provider: run?.provider ?? "codex", label, condition, uncertain: ["accepted", "disconnected", "interrupted"].includes(condition), reason };
  };
  const contexts: FactoryCapacity["contexts"] = runs.filter(consumesCapacity).map(run => ({ ...reservation(run.id, run, null, run.action, run.continuation?.condition === "uncertain" ? "disconnected" : run.condition, run.continuation?.condition === "uncertain" ? run.continuation.reason : run.waiting_reason), pool: run.capacity_pool ?? "normal" }));
  for (const worker of store.list<FactoryWorker>("workers").filter(consumesCapacity)) {
    const run = parents.get(worker.run_id);
    const ticket = (run?.manifest as { tickets?: FactoryTicket[] } | undefined)?.tickets?.find(ticket => ticket.id === worker.ticket_id);
    contexts.push({ ...reservation(worker.id, run, worker.id, ticket?.title ?? worker.role, worker.continuation?.condition === "uncertain" ? "disconnected" : worker.condition, worker.continuation?.condition === "uncertain" ? worker.continuation.reason : worker.waiting_reason), run_id: worker.run_id, pool: "normal" });
  }
  const builds = store.list<FactoryCheck>("checks").filter(check => ["working", "interrupted"].includes(check.condition)).map(check => ({ ...reservation(check.id, parents.get(check.run_id), check.worker_id, "check", check.condition, null), run_id: check.run_id }));
  const waiting = store.list<FactoryCapacityWait>("capacity_waits").map(wait => ({ id: wait.id, created_at: wait.created_at, updated_at: wait.updated_at, implementation_id: wait.implementation_id, assignment_title: wait.assignment_title, action: wait.action, machine_id: wait.machine_id, provider: wait.provider, idempotency_key: wait.idempotency_key, reason: wait.reason, purpose: wait.purpose, condition: wait.condition, run_id: wait.run_id, ...(wait.continuation ? { continuation: true } : {}) })).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const continuations = runs.filter(run => run.continuation && run.continuation.condition !== "resumed" && !["completed", "cancelled", "failed"].includes(run.condition)).map(run => ({ ...reservation(run.continuation!.id, run, null, run.continuation!.kind, run.continuation!.condition, run.continuation!.reason), uncertain: run.continuation!.condition === "uncertain" }));
  for (const worker of store.list<FactoryWorker>("workers").filter(worker => worker.continuation && worker.continuation.condition !== "resumed" && !["completed", "cancelled", "failed"].includes(worker.condition))) continuations.push({ ...reservation(worker.continuation!.id, parents.get(worker.run_id), worker.id, worker.role, worker.continuation!.condition, worker.continuation!.reason), uncertain: worker.continuation!.condition === "uncertain" });
  return { continuations, normal: { limit: settings.max_agents, used: contexts.filter(context => context.pool === "normal").length }, planning: { limit: 1, used: contexts.filter(context => context.pool === "planning").length }, builds: { limit: settings.max_builds, used: builds.length }, contexts, build_reservations: builds, waiting };
}

/** Call inside the same immediate transaction that records the accepted identity. */
export function agentCapacityPool(store: Pick<FactoryStore, "list">, settings: FactorySettings, planning = false): "normal" | "planning" {
  const capacity = factoryCapacity(store, settings);
  if (capacity.normal.used < capacity.normal.limit) return "normal";
  if (planning && capacity.planning.used < capacity.planning.limit) return "planning";
  const occupants = capacity.contexts.map(context => `${context.assignment_title} / ${context.label} [${context.machine_id}, ${context.provider}, ${context.condition}${context.uncertain ? ", uncertain" : ""}]${context.reason ? `: ${context.reason}` : ""}`).join("; ");
  throw new FactoryError("capacity_exhausted", `Waiting for agent capacity: normal ${capacity.normal.used}/${capacity.normal.limit}, extra planning ${capacity.planning.used}/1, builds ${capacity.builds.used}/${capacity.builds.limit}. ${occupants}`, 409);
}

/** A native completion is not evidence that checked implementation and review finished. */
export function implementingAssignments(store: Pick<FactoryStore, "list">, runs: FactoryRun[]): Set<string> {
  // Historical owner acceptance already retired execution before completion receipts
  // existed. Keep that released slot without revalidating cleaned workspaces.
  const accepted = (run: FactoryRun) => store.list<FactoryApproval>("approvals", run.implementation_id).some(approval => approval.kind === "review" && approval.scope.startsWith(`Run ${run.id};`));
  const owners = new Set(runs.filter(run => !((run.manifest as { planning_authority?: { automatic_execution?: boolean } }).planning_authority?.automatic_execution && ["completed", "cancelled", "failed"].includes(run.condition)) && (run.implementation_completion_pending || !["completed", "failed", "cancelled"].includes(run.condition) || run.condition === "completed" && !run.implementation_completion && !accepted(run))).map(run => run.implementation_id));
  const parents = new Map(runs.map(run => [run.id, run.implementation_id]));
  for (const worker of store.list<FactoryWorker>("workers")) if (parents.has(worker.run_id) && !["completed", "failed", "cancelled"].includes(worker.condition)) owners.add(parents.get(worker.run_id)!);
  for (const check of store.list<FactoryCheck>("checks")) if (parents.has(check.run_id) && ["working", "interrupted"].includes(check.condition)) owners.add(parents.get(check.run_id)!);
  return owners;
}
