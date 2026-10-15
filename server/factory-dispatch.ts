import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FactoryCapacityWait, FactoryProject, FactoryRun, FactoryWorker, Implementation } from "../shared/factory.ts";
import { FactoryError, hash } from "./factory-host.ts";
import type { FactoryStore } from "./factory-store.ts";

interface Request extends FactoryCapacityWait {
  request: Record<string, unknown>; origin: string; scope_hash: string;
  attempts: number; next_attempt_at: number;
}

/** A queued intent is not an executing reservation. Admission records the native
 * identity before launch; an uncertain launch is observed, never replayed. */
export class FactoryDispatch {
  resumeSuspension: ((id: string, body: Record<string, unknown>) => Promise<void>) | null = null;
  maintenance: (() => Promise<void>) | null = null;
  worker: ((id: string, body: Record<string, unknown>) => Promise<FactoryWorker>) | null = null;
  resume: ((id: string, body: Record<string, unknown>) => Promise<void>) | null = null;
  onRun: ((run: FactoryRun) => void) | null = null;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private readonly store: FactoryStore, private readonly reconcile: () => Promise<void>, private readonly admit: (id: string, body: Record<string, unknown>, origin: string) => Promise<FactoryRun>) { this.schedule(); }
  private scope(id: string): string {
    const idea = this.store.get<Implementation>("implementations", id);
    const assignment = idea ? { title: idea.title, description: idea.description, project_id: idea.project_id, provider: idea.provider, machine_id: idea.machine_id } : null;
    const project = idea?.project_id ? this.store.get<FactoryProject>("projects", idea.project_id) : null;
    const { updated_at: _projectUpdated, removed_at: _removed, ...configuration } = project ?? {};
    return hash(JSON.stringify({ assignment, configuration, checkouts: project ? this.store.list("checkouts", project.id) : [], specifications: this.store.list("specifications", id), graph: this.store.get("graphs", id) }));
  }
  async start(wait: FactoryCapacityWait & { run_id: null }, body: Record<string, unknown>, origin: string): Promise<FactoryRun | FactoryCapacityWait>;
  async start(wait: FactoryCapacityWait & { run_id: string }, body: Record<string, unknown>, origin: string): Promise<FactoryWorker | FactoryCapacityWait>;
  async start(wait: FactoryCapacityWait, body: Record<string, unknown>, origin: string): Promise<FactoryRun | FactoryWorker | FactoryCapacityWait> {
    const previous = this.store.get<Request>("capacity_waits", wait.id);
    if (previous && hash(JSON.stringify(previous.request)) !== hash(JSON.stringify(body))) throw new FactoryError("idempotency_conflict", "This Start key already belongs to another request", 409);
    if (!previous) this.store.db.transaction(() => {
      for (const obsolete of this.store.list<Request>("capacity_waits", wait.implementation_id)) {
        if (obsolete.condition === "blocked" && obsolete.run_id === wait.run_id && obsolete.action === wait.action && obsolete.request.role === body.role && obsolete.request.ticket_id === body.ticket_id) this.store.remove("capacity_waits", obsolete.id);
      }
      this.store.put("capacity_waits", { ...wait, request: body, origin, scope_hash: this.scope(wait.implementation_id), attempts: 0, next_attempt_at: 0 }, wait.implementation_id);
    }).immediate();
    const failures = new Map<string, unknown>();
    await this.drain(failures);
    if (failures.has(wait.id)) throw failures.get(wait.id);
    const run = wait.run_id ? this.store.list<FactoryWorker & { key: string }>("workers", wait.run_id).find(worker => worker.key === wait.idempotency_key) : this.store.list<FactoryRun>("runs", wait.implementation_id).find(run => run.idempotency_key === wait.idempotency_key);
    if (run) return run;
    return this.public(this.store.get<Request>("capacity_waits", wait.id)!);
  }
  enqueueContinuation(wait: FactoryCapacityWait, body: Record<string, unknown>): void {
    const previous = this.store.get<Request>("capacity_waits", wait.id);
    this.store.put("capacity_waits", { ...wait, created_at: previous?.created_at ?? wait.created_at, request: body, origin: "", scope_hash: "", attempts: previous?.attempts ?? 0, next_attempt_at: previous?.next_attempt_at ?? 0 }, wait.implementation_id);
  }
  private public(request: Request): FactoryCapacityWait {
    const { request: _request, origin: _origin, scope_hash: _scope, attempts: _attempts, next_attempt_at: _next, ...wait } = request;
    return wait;
  }
  private drain(failures = new Map<string, unknown>()): Promise<void> {
    if (this.pending) return this.pending.then(() => this.drain(failures));
    const operation = Promise.resolve().then(async () => {
      if (this.stopped || existsSync(join(this.store.root, "recovery-copy.json"))) return;
      await this.maintenance?.();
      if (!this.store.list("capacity_waits").length && !this.store.list<FactoryRun>("runs").some(run => run.continuation && !["resumed", "blocked", "uncertain"].includes(run.continuation.condition)) && !this.store.list<FactoryWorker>("workers").some(worker => worker.continuation && !["resumed", "blocked", "uncertain"].includes(worker.continuation.condition))) return;
      await this.reconcile();
      const requests = this.store.list<Request>("capacity_waits").sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (!requests.length) return;
      for (const request of requests) {
        if (this.stopped) return;
        const idea = this.store.get<Implementation>("implementations", request.implementation_id);
        if (idea?.pause || idea?.deletion) continue;
        if (request.condition === "blocked" || request.next_attempt_at > Date.now()) continue;
        try {
          if (!request.run_id && request.scope_hash && request.scope_hash !== this.scope(request.implementation_id)) throw new FactoryError("scope_changed", "The queued execution scope changed; inspect it and submit a new Start request", 409);
          if (request.continuation && request.run_id) {
            const resume = request.request.suspension ? this.resumeSuspension : this.resume;
            if (!resume) continue;
            await resume(request.run_id, request.request);
          } else if (request.run_id) {
            if (!this.worker) continue;
            await this.worker(request.run_id, request.request);
          } else {
            const run = await this.admit(request.implementation_id, request.request, request.origin);
            if (!this.stopped) this.onRun?.(run);
          }
          if (!this.stopped) this.store.remove("capacity_waits", request.id);
        } catch (error) {
          if (this.stopped) return;
          const code = error instanceof FactoryError ? error.code : "dispatch_unavailable";
          const capacity = code === "capacity_exhausted";
          const ineligible = ["assignment_paused", "assignment_deleting", "ticket_not_ready", "ticket_owned", "writers_active", "shared_writer_owned", "answers_unready", "implementation_owned", "inactive_assignment", "continuation_waiting"].includes(code);
          const retry = ["machine_offline", "machine_disconnected", "remote_factory_unavailable"].includes(code);
          const attempts = request.attempts + (retry ? 1 : 0);
          const blocked = !capacity && !ineligible && (!retry || attempts >= 6);
          const reason = error instanceof FactoryError ? error.message : "Dispatch could not be verified";
          this.store.put("capacity_waits", { ...request, condition: blocked ? "blocked" : "queued", attempts, next_attempt_at: retry ? Date.now() + Math.min(30_000, 1000 * 2 ** (attempts - 1)) : 0, reason: blocked ? `${reason}${retry ? `; recovery stopped after ${attempts} attempts` : ""}. Inspect the request and Machine before submitting a new Start request` : reason }, request.implementation_id);
          if (!capacity && !retry && !ineligible) failures.set(request.id, error);
        }
      }
    });
    this.pending = operation;
    return operation.finally(() => { if (this.pending === operation) this.pending = null; });
  }
  private schedule(): void {
    this.timer = setTimeout(() => { void this.drain().catch(() => {}).finally(() => { if (!this.stopped) this.schedule(); }); }, 500);
    this.timer.unref();
  }
  flush(): Promise<void> { return this.drain(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}
