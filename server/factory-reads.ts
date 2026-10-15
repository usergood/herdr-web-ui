import type { FactoryCurrent, FactoryDetail, FactoryOverview, FactoryRun, FactoryTicket, FactoryQuestion, FactoryWorker, FactoryCheck, FactoryEvent, FactoryReviewEvidence, Implementation, SpecificationVersion } from "../shared/factory.ts";
import { projectFactoryBoard } from "../shared/factory-board.ts";
import { FactoryStore } from "./factory-store.ts";
import { hash } from "./factory-host.ts";

/** Request-local reads: no cross-request cache or lifecycle decisions. Heavy JSON is not decoded. */
export class FactoryReads {
  private cache = new Map<string, unknown[]>();
  constructor(private store: FactoryStore) {}
  list<T>(kind: string, parent?: string): T[] {
    const key = JSON.stringify([kind, parent]);
    if (!this.cache.has(key)) {
      const expression = kind === "runs" ? `json_set(json_remove(data, '$.manifest'), '$.manifest', json_object('execution_preset', json_extract(data, '$.manifest.execution_preset'), 'project', json_object('id', json_extract(data, '$.manifest.project.id')), 'tickets', json((SELECT coalesce(json_group_array(json_object('id', json_extract(value, '$.id'), 'title', json_extract(value, '$.title'))), '[]') FROM json_each(data, '$.manifest.tickets')))))`
        : kind === "checks" ? `json_remove(data, '$.commands')`
        : kind === "review_evidence" ? `json_remove(data, '$.content')`
        : kind === "events" ? `json_set(json_remove(data, '$.data'), '$.data', json_object('run_id', json_extract(data, '$.data.run_id'), 'message', json_extract(data, '$.data.message')))` : "data";
      const rows = parent === undefined
        ? this.store.db.query<{ data: string }, [string]>(`SELECT ${expression} AS data FROM records WHERE kind=? ORDER BY rowid`).all(kind)
        : this.store.db.query<{ data: string }, [string, string]>(`SELECT ${expression} AS data FROM records WHERE kind=? AND parent=? ORDER BY rowid`).all(kind, parent);
      this.cache.set(key, rows.map(row => JSON.parse(row.data)));
    }
    return this.cache.get(key) as T[];
  }
  specification(id: string): SpecificationVersion | null {
    const row = this.store.db.query<{ data: string }, [string]>("SELECT data FROM records WHERE kind='specifications' AND parent=? ORDER BY rowid DESC LIMIT 1").get(id);
    return row ? JSON.parse(row.data) : null;
  }
  tickets(id: string, specification = this.specification(id)): FactoryTicket[] {
    const graph = this.store.get<{ specification_id: string; tickets: FactoryTicket[] }>("graphs", id);
    return graph?.specification_id === specification?.id ? graph?.tickets ?? [] : [];
  }
  questions(id: string, runs: FactoryRun[], runId?: string): FactoryQuestion[] {
    const byId = new Map(runs.map(run => [run.id, run]));
    const probe = runId && byId.get(runId)?.action === "verify-provider";
    return this.list<FactoryQuestion>("questions", id).filter(q => probe ? q.run_id === runId : !q.run_id || byId.get(q.run_id)?.action !== "verify-provider");
  }
  current(id: string, context: Parameters<typeof projectFactoryBoard>[1]): FactoryCurrent | null {
    const implementation = this.store.get<Implementation>("implementations", id);
    if (!implementation) return null;
    const runs = this.list<FactoryRun>("runs", id), runIds = new Set(runs.map(run => run.id));
    const active = [...runs].reverse().find(run => !["completed", "cancelled", "failed"].includes(run.condition));
    const questionRunId = active?.action === "verify-provider" ? active.id : undefined;
    const questions = this.questions(id, runs), scoped = this.questions(id, runs, questionRunId);
    const spec = this.specification(id), tickets = this.tickets(id, spec);
    const checks = runs.flatMap(run => this.list<Omit<FactoryCheck, "commands">>("checks", run.id));
    const workers = runs.flatMap(run => this.list<FactoryWorker>("workers", run.id));
    const events = this.list<FactoryEvent>("events", id);
    const selectedEvents = [
      events.filter(e => e.kind === "continuation_waiting" && (e.data as { run_id?: string })?.run_id === (active?.id ?? runs.at(-1)?.id)).at(-1),
      ...[["native_snapshot_unavailable", "planning_handoff_retained"], ["planning_documents_unavailable", "planning_documents_retained"]].map(kinds => events.filter(e => kinds.includes(e.kind) && (e.data as { run_id?: string })?.run_id === runs.at(-1)?.id).at(-1)),
    ].filter((e): e is FactoryEvent => !!e);
    return {
      revision: this.store.revision, implementation,
      board: projectFactoryBoard(implementation, { ...context, tickets, runs, workers, checks, questions: scoped }),
      graph_hash: this.store.get<{ hash: string }>("graphs", id)?.hash ?? hash("[]"), question_revision: hash(JSON.stringify(questions)),
      question_context: { run_id: questionRunId ?? null, revision: hash(JSON.stringify(scoped)), questions: scoped },
      questions: scoped, specifications: spec ? [spec] : [], tickets,
      approvals: this.list<FactoryDetail["approvals"][number]>("approvals", id).map(a => ({ ...a, scope: "" })),
      runs: runs.map(run => ({ ...run, manifest: { execution_preset: (run.manifest as { execution_preset?: unknown })?.execution_preset } })),
      checks: checks.filter(check => check.worker_id === null),
      review_evidence: [...runIds].flatMap(runId => this.list<Omit<FactoryReviewEvidence, "content">>("review_evidence", runId)), events: selectedEvents,
    };
  }
  overview(settings: FactoryOverview["settings"], context: (id: string) => Parameters<typeof projectFactoryBoard>[1], navigation: boolean): FactoryOverview {
    const ideas = this.list<Implementation>("implementations"), runs = this.list<FactoryRun>("runs"), workers = this.list<FactoryWorker>("workers"), checks = this.list<Omit<FactoryCheck, "commands">>("checks");
    const byIdea = new Map(ideas.map(idea => [idea.id, runs.filter(run => run.implementation_id === idea.id)]));
    const tickets = new Map(ideas.map(idea => [idea.id, this.tickets(idea.id)]));
    return {
      implementations: [...ideas].sort((a,b) => a.position - b.position).map(idea => { if (!navigation) return idea; const { description, delivery, upstream_update, ...summary } = idea; return summary; }),
      projects: this.list("projects"), checkouts: this.list<FactoryOverview["checkouts"][number]>("checkouts").map(checkout => { if (!navigation) return checkout; const { instructions, ...summary } = checkout; return summary; }), settings,
      board: ideas.map(idea => projectFactoryBoard(idea, { ...context(idea.id), runs: byIdea.get(idea.id), workers, checks, tickets: tickets.get(idea.id), questions: this.questions(idea.id, byIdea.get(idea.id)!) })),
      activity: ideas.flatMap(idea => { const run = byIdea.get(idea.id)?.at(-1), graph = tickets.get(idea.id)!; return run ? [{ implementation_id: idea.id, run_id: run.id, condition: run.condition, action: run.action, waiting_reason: run.waiting_reason, completed_tickets: graph.filter(t => t.status === "done").length, total_tickets: graph.length }] : []; }),
      pane_archives: this.list("pane_archives"),
      pane_links: runs.flatMap(run => {
        const manifest = run.manifest as { project?: { id?: string }; tickets?: { id: string; title: string }[] };
        const base = { project_id: manifest.project?.id ?? null, implementation_id: run.implementation_id, run_id: run.id, machine_id: run.machine_id, provider: run.provider };
        return [...(run.pane_id ? [{ ...base, pane_id: run.pane_id, worker_id: null, worktree: run.worktree, workspace_id: run.workspace_id, title: run.action, condition: run.condition }] : []), ...workers.filter(worker => worker.run_id === run.id && worker.pane_id).map(worker => ({ ...base, pane_id: worker.pane_id!, worker_id: worker.id, worktree: worker.worktree, workspace_id: worker.workspace_id, title: manifest.tickets?.find(t => t.id === worker.ticket_id)?.title ?? worker.role, condition: worker.condition }))];
      }),
    };
  }
}
