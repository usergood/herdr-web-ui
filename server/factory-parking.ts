import type { FactoryCapacityWait, FactoryRun, FactoryWorker, Implementation } from "../shared/factory.ts";
import type { FactoryDispatch } from "./factory-dispatch.ts";
import { HerdrError } from "./herdr/client.ts";
import { FactoryError } from "./factory-host.ts";
import type { FactoryStore } from "./factory-store.ts";
import type { FactoryWorkflow } from "./factory-workflow.ts";

/** Observation is the park acknowledgment. A request alone never releases a slot.
 * Only the central dispatcher can reserve and deliver a continuation. */
export class FactoryParking {
  private readonly sending = new Set<string>();
  private readonly abort = new AbortController();
  constructor(private readonly store: FactoryStore, private readonly workflow: FactoryWorkflow, private readonly queue: FactoryDispatch, private readonly reserve: (planning: boolean) => "normal" | "planning", private readonly deliver: (run: FactoryRun, text: string, signal: AbortSignal, worker?: FactoryWorker) => Promise<void>) {
    queue.resume = (id, body) => this.resume(id, body);
  }
  observe(run: FactoryRun, resting: boolean): FactoryRun {
    const workers = this.store.list<FactoryWorker & { key: string }>("workers", run.id);
    const waits = this.store.list<FactoryCapacityWait>("capacity_waits", run.implementation_id).filter(wait => wait.run_id === run.id && !wait.continuation);
    const keys = [...new Set([...waits.map(wait => wait.idempotency_key), ...workers.filter(worker => !["ready", "completed", "cancelled", "failed"].includes(worker.condition)).map(worker => worker.key)])];
    let park = run.continuation;
    if (keys.length && (!park || park.condition === "resumed")) park = { ...this.store.record(), kind: "children", condition: "parking", reason: "Waiting for verified native rest before releasing capacity", question_revision: null, worker_keys: keys };
    if (!park || park.condition === "resumed" || park.condition === "blocked") return run;
    if (park.condition === "sending" || park.condition === "uncertain") {
      if (this.sending.has(run.id)) return run;
      return { ...run, continuation: { ...park, condition: "uncertain", reason: "Continuation delivery could not be confirmed; inspect the native conversation before sending again" } };
    }
    const waitId = `resume:${park.id}`;
    if (!resting) {
      this.store.remove("capacity_waits", waitId);
      return { ...run, continuation: { ...park, condition: "parking", reason: run.waiting_reason ?? "Waiting for verified native rest before releasing capacity" } };
    }
    const questions = this.workflow.questions(run.implementation_id, run.id);
    if (questions.some(question => question.answer === null)) {
      this.store.remove("capacity_waits", waitId);
      return { ...run, continuation: { ...park, condition: "parked", reason: "Waiting for owner answers; execution capacity released" } };
    }
    if (park.kind === "children" && (waits.length || (park.worker_keys ?? []).some(key => {
      const worker = workers.find(worker => worker.key === key);
      return !worker || !["completed", "cancelled", "failed"].includes(worker.condition) && (worker.condition !== "ready" || !!worker.continuation && worker.continuation.condition !== "resumed");
    }))) {
      this.store.remove("capacity_waits", waitId);
      return { ...run, continuation: { ...park, condition: "parked", worker_keys: [...new Set([...(park.worker_keys ?? []), ...keys])], reason: waits.find(wait => wait.condition === "blocked")?.reason ?? "Waiting for child work; execution capacity released" } };
    }
    const revision = this.workflow.questionRevision(run.implementation_id, run.id);
    if (park.kind === "owner" && this.consumed(run, revision, null)) { this.store.remove("capacity_waits", waitId); return { ...run, continuation: { ...park, condition: "resumed", question_revision: revision, reason: "The native conversation consumed the current answered context" } }; }
    park = { ...park, queued_at: park.queued_at ?? new Date().toISOString(), condition: "queued", question_revision: revision, reason: "Waiting for agent capacity to resume this conversation" };
    const idea = this.store.get<Implementation>("implementations", run.implementation_id)!;
    this.queue.enqueueContinuation({ ...park, created_at: park.queued_at!, id: waitId, implementation_id: run.implementation_id, assignment_title: idea.title, action: run.action, machine_id: run.machine_id, provider: run.provider, idempotency_key: park.id, purpose: this.planning(run) ? "planning" : "execution", condition: "queued", run_id: run.id, continuation: true }, { park_id: park.id, revision });
    return { ...run, continuation: park };
  }
  observeWorker(run: FactoryRun, worker: FactoryWorker, resting: boolean): FactoryWorker {
    let park = worker.continuation;
    if (!park || ["resumed", "blocked"].includes(park.condition)) return worker;
    if (["sending", "uncertain"].includes(park.condition)) return this.sending.has(worker.id) ? worker : { ...worker, continuation: { ...park, condition: "uncertain", reason: "Continuation delivery could not be confirmed; inspect the native conversation before sending again" } };
    const waitId = `resume:${park.id}`;
    if (!resting) {
      this.store.remove("capacity_waits", waitId);
      return { ...worker, continuation: { ...park, condition: "parking", reason: worker.waiting_reason ?? "Waiting for verified native rest before releasing capacity" } };
    }
    const questions = this.workflow.questions(run.implementation_id, run.id);
    if (questions.some(question => question.answer === null)) {
      this.store.remove("capacity_waits", waitId);
      return { ...worker, condition: "needs_you", continuation: { ...park, condition: "parked", reason: "Waiting for owner answers; execution capacity released" } };
    }
    const revision = this.workflow.questionRevision(run.implementation_id, run.id);
    if (this.consumed(run, revision, worker.id)) { this.store.remove("capacity_waits", waitId); return { ...worker, continuation: { ...park, condition: "resumed", question_revision: revision, reason: "The native conversation consumed the current answered context" } }; }
    park = { ...park, queued_at: park.queued_at ?? new Date().toISOString(), condition: "queued", question_revision: revision, reason: "Waiting for agent capacity to resume this conversation" };
    const idea = this.store.get<Implementation>("implementations", run.implementation_id)!;
    this.queue.enqueueContinuation({ ...park, created_at: park.queued_at!, id: waitId, implementation_id: run.implementation_id, assignment_title: idea.title, action: run.action, machine_id: run.machine_id, provider: run.provider, idempotency_key: park.id, purpose: "execution", condition: "queued", run_id: run.id, continuation: true }, { park_id: park.id, revision, worker_id: worker.id });
    return { ...worker, continuation: park };
  }
  private consumed(run: FactoryRun, revision: string, workerId: string | null): boolean {
    return this.store.list<{ revision: string; worker_id: string | null }>("answer_consumption", run.id).some(receipt => receipt.revision === revision && receipt.worker_id === workerId);
  }
  private planning(run: FactoryRun): boolean {
    const specification = this.workflow.specification(run.implementation_id);
    return ["grill-me", "grill-with-docs"].includes(run.action) || run.action === "to-spec" && (!specification || !this.workflow.approved(run.implementation_id, "specification", specification.id));
  }
  private async resume(id: string, body: Record<string, unknown>): Promise<void> {
    const parent = this.store.get<FactoryRun>("runs", id);
    if (!parent || ["completed", "cancelled", "failed"].includes(parent.condition)) return;
    const workerId = typeof body.worker_id === "string" ? body.worker_id : null;
    const collection = workerId ? "workers" : "runs";
    const targetId = workerId ?? id;
    const target = this.store.db.transaction(() => {
      const current = this.store.get<FactoryRun | FactoryWorker>(collection, targetId);
      if (!current || !current.continuation || ["completed", "cancelled", "failed"].includes(current.condition) || current.continuation.id !== body.park_id) return null;
      if (current.continuation.condition !== "queued") throw new FactoryError("continuation_waiting", current.continuation.reason, 409);
      if (this.workflow.questionRevision(parent.implementation_id, id) !== body.revision || this.workflow.questions(parent.implementation_id, id).some(question => question.answer === null)) throw new FactoryError("continuation_waiting", "Waiting for the current answered revision", 409);
      const pool = this.reserve(!workerId && this.planning(parent));
      const reserved: FactoryRun | FactoryWorker = { ...current, ...(!workerId ? { capacity_pool: pool } : {}), condition: "accepted", continuation: { ...current.continuation, condition: "sending", reason: "Resuming the retained conversation" } };
      this.store.put(collection, reserved, workerId ? id : parent.implementation_id);
      return reserved;
    }).immediate();
    if (!target) return;
    const run = parent;
    this.sending.add(targetId);
    try {
      await this.deliver(run, `Resume this retained conversation after ${target.continuation!.kind === "children" ? "child work reached a resting or completed state; inspect each child through contract and reconcile its result" : "owner answers arrived"}. The current answered context is ${body.revision}. Read contract through .saurons-eye-tracker.mjs and consume this exact revision before continuing. Preserve changed or unanswered questions and all native permissions.`, this.abort.signal, workerId ? target as FactoryWorker : undefined);
      this.settle(run, target, workerId, "resumed", "The retained conversation resumed", "working");
      if (!this.abort.signal.aborted) this.store.event(run.implementation_id, "conversation_resumed", { run_id: id, continuation_id: body.park_id, revision: body.revision });
    } catch (error) {
      const safe = (error instanceof FactoryError || error instanceof HerdrError) && ["agent_busy", "worker_busy", "delivery_busy", "agent_blocked", "agent_not_ready", "input_draft", "run_unavailable", "recovery_copy"].includes(error.code);
      this.settle(run, target, workerId, safe ? (error instanceof FactoryError || error instanceof HerdrError) && ["agent_busy", "worker_busy", "delivery_busy", "agent_blocked", "agent_not_ready"].includes(error.code) ? "parking" : "blocked" : "uncertain", error instanceof Error ? error.message : "Continuation delivery is uncertain; inspect the native conversation", safe ? "working" : "disconnected");
    } finally { this.sending.delete(targetId); }
  }
  private settle(run: FactoryRun, target: FactoryRun | FactoryWorker, workerId: string | null, condition: NonNullable<FactoryRun["continuation"]>["condition"], reason: string, nativeCondition: FactoryRun["condition"]): void {
    if (this.abort.signal.aborted) return;
    const current = this.store.get<FactoryRun | FactoryWorker>(workerId ? "workers" : "runs", target.id);
    if (current?.continuation?.id === target.continuation!.id && current.continuation.condition === "sending" && !["completed", "cancelled", "failed"].includes(current.condition)) this.store.put(workerId ? "workers" : "runs", { ...current, condition: nativeCondition, continuation: { ...current.continuation, condition, reason } }, workerId ? run.id : run.implementation_id);
  }
  answerDelivery(run: FactoryRun, revision: string, key: string, worker?: FactoryWorker): import("../shared/protocol.ts").FactoryAnswerDelivery | null {
    const target = worker ?? run;
    const park = target.continuation;
    if (park?.kind !== "owner" || park.question_revision !== null && park.question_revision !== revision) return null;
    const condition = park.condition === "parking" && ["working", "needs_you", "disconnected", "interrupted"].includes(target.condition) ? "blocked" : park.condition === "resumed" ? "sent" : ["parking", "parked", "queued"].includes(park.condition) ? "queued" : park.condition;
    const prior = this.store.list<{ id: string; key: string; revision: string; continuation_id?: string }>("answer_deliveries", run.id).find(entry => entry.continuation_id === park.id || !worker && entry.key === key);
    if (prior?.key === key && prior.revision !== revision) throw new FactoryError("delivery_conflict", "This key belongs to another answered revision", 409);
    const delivery = { ...this.store.record(), ...prior, id: prior?.id ?? park.id, run_id: run.id, key: prior?.key ?? key, revision, continuation_id: park.id, condition: condition as import("../shared/protocol.ts").FactoryAnswerDelivery["condition"] };
    this.store.put("answer_deliveries", delivery, run.id);
    return delivery;
  }
  stop(): void { this.abort.abort(); }
}
