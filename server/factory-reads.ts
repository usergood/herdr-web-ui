import type { FactoryCurrent, FactoryDetail, FactoryOverview, FactoryRun, FactoryTicket, FactoryQuestion, FactoryWorker, FactoryCheck, FactoryEvent, FactoryReviewEvidence, Implementation, SpecificationVersion } from "../shared/factory.ts";
import { workflowConversations } from "../shared/factory-conversations.ts";
import { assignmentProgress, projectFactoryBoard } from "../shared/factory-board.ts";
import { factoryCapacity } from "./factory-capacity.ts";
import { FactoryStore } from "./factory-store.ts";
import { hash } from "./factory-host.ts";

/** Request-local reads: no cross-request cache or lifecycle decisions. Heavy JSON is not decoded. */
export class FactoryReads {
  private cache = new Map<string, unknown[]>();
  constructor(private store: FactoryStore) {}
  list<T>(kind: string, parent?: string): T[] {
    const key = JSON.stringify([kind, parent]);
    if (!this.cache.has(key)) {
      const expression = kind === "runs" ? `json_set(json_remove(data, '$.manifest'), '$.manifest', json_object('planning_authority', json_extract(data, '$.manifest.planning_authority'), 'execution_preset', json_extract(data, '$.manifest.execution_preset'), 'rework', json_extract(data, '$.manifest.rework'), 'issue_admission', CASE WHEN json_type(data, '$.manifest.issue_admission') = 'object' THEN json_object('source', json_object('id', json_extract(data, '$.manifest.issue_admission.source.id'), 'revision', json_extract(data, '$.manifest.issue_admission.source.revision'), 'current', json_object('title', json_extract(data, '$.manifest.issue_admission.source.current.title'))), 'planning', json_object('authorization', json_object('approval', json_object('actor', json_object('login', json_extract(data, '$.manifest.issue_admission.planning.authorization.approval.actor.login')))))) ELSE NULL END, 'project', json_object('id', json_extract(data, '$.manifest.project.id')), 'tickets', json((SELECT coalesce(json_group_array(json_object('id', json_extract(value, '$.id'), 'title', json_extract(value, '$.title'), 'status', json_extract(value, '$.status'), 'dependencies', json(coalesce(json_extract(value, '$.dependencies'), '[]')))), '[]') FROM json_each(data, '$.manifest.tickets')))))`
        : kind === "checks" ? `json_remove(data, '$.commands')`
        : kind === "review_evidence" ? `json_remove(data, '$.content')`
        : kind === "native_snapshots" ? `json_remove(data, '$.turns')`
        : kind === "snapshots" ? `json_remove(data, '$.files')`
        : kind === "automatic_review_batches" || kind === "review_batches" ? `json_remove(data, '$.reports')`
        : kind === "capacity_waits" ? `json_set(json_remove(data, '$.request', '$.origin', '$.scope_hash', '$.attempts', '$.next_attempt_at'), '$.ticket_id', json_extract(data, '$.request.ticket_id'))`
        : kind === "events" ? `json_set(json_remove(data, '$.data'), '$.data', json_patch(json_object('run_id', json_extract(data, '$.data.run_id'), 'message', json_extract(data, '$.data.message')), CASE WHEN json_type(data, '$.data.rework_requested') IN ('true', 'false') THEN json_object('rework_requested', json(json_type(data, '$.data.rework_requested'))) ELSE '{}' END))` : "data";
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
    const executionPlans = this.list<NonNullable<FactoryDetail["execution_plans"]>[number]>("execution_plans", id);
    const nativeMetadata = runs.flatMap(run => this.list<Pick<FactoryDetail["native_snapshots"][number], "id" | "run_id" | "worker_id">>("native_snapshots", run.id));
    const events = this.list<FactoryEvent>("events", id);
    const waiting = this.list<NonNullable<FactoryDetail["capacity_waiting"]>[number] & { ticket_id?: string }>("capacity_waits", id);
    const selectedEvents = [
      events.filter(e => e.kind === "run_stopped").at(-1),
      events.filter(e => e.kind === "continuation_waiting" && (e.data as { run_id?: string })?.run_id === (active?.id ?? runs.at(-1)?.id)).at(-1),
      ...[["native_snapshot_unavailable", "planning_handoff_retained"], ["planning_documents_unavailable", "planning_documents_retained"]].map(kinds => events.filter(e => kinds.includes(e.kind) && (e.data as { run_id?: string })?.run_id === runs.at(-1)?.id).at(-1)),
    ].filter((e): e is FactoryEvent => !!e);
    return {
      revision: this.store.revision, implementation, workers, execution_plans: executionPlans,
      conversations: workflowConversations({ implementation, runs, workers, tickets, execution_plans: executionPlans, native_snapshots: nativeMetadata }),
      automatic_planning: this.list("automatic_planning", id), automatic_execution: this.list("automatic_execution", id),
      automatic_review: this.list("automatic_review", id), automatic_review_batches: this.list("automatic_review_batches", id),
      human_reviews: this.list("human_reviews", id), pull_requests: this.list("pull_requests", id),
      capacity_waiting: waiting.map(({ ticket_id: _ticket, ...wait }) => wait),
      board: projectFactoryBoard(implementation, { ...context, tickets, runs, workers, checks, questions: scoped, capacity_waiting: waiting }),
      graph_hash: this.store.get<{ hash: string }>("graphs", id)?.hash ?? hash("[]"), question_revision: hash(JSON.stringify(questions)),
      question_context: { run_id: questionRunId ?? null, revision: hash(JSON.stringify(scoped)), questions: scoped },
      questions: scoped, specifications: spec ? [spec] : [], tickets,
      approvals: this.list<FactoryDetail["approvals"][number]>("approvals", id).map(a => ({ ...a, scope: "" })),
      runs: runs.map(run => {
        const manifest = run.manifest as { execution_preset?: unknown; planning_authority?: unknown; tickets?: unknown[]; issue_admission?: unknown; rework?: unknown };
        return { ...run, manifest: { execution_preset: manifest?.execution_preset, planning_authority: manifest?.planning_authority ?? undefined, tickets: manifest?.tickets?.length ? manifest.tickets : undefined, issue_admission: manifest?.issue_admission ?? undefined, rework: manifest?.rework ?? undefined } };
      }),
      checks,
      review_evidence: [...runIds].flatMap(runId => this.list<Omit<FactoryReviewEvidence, "content">>("review_evidence", runId)), events: selectedEvents,
    };
  }
  /** Only the selected logical conversation may decode its retained history. */
  workflow(id: string, conversationId?: string): FactoryDetail | null {
    const current = this.current(id, {});
    if (!current) return null;
    const selected = current.conversations?.find(conversation => conversationId ? conversation.id === conversationId && conversation.kind !== "reviewer" : conversation.kind === "specifications");
    if (!selected) return null;
    const snapshotIds = selected.contexts.flatMap(context => context.snapshot_ids);
    const runIds = [...new Set(selected.contexts.map(context => context.run_id))];
    const nativeRows = this.store.db.query<{ data: string }, [string, string]>("SELECT data FROM records WHERE kind='native_snapshots' AND parent IN (SELECT value FROM json_each(?)) AND id IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(JSON.stringify(runIds), JSON.stringify(snapshotIds));
    const title = selected.kind === "specifications" ? "Specifications" : selected.kind === "orchestrator" ? "Orchestrator" : selected.kind === "human_review" ? "Human Review" : null;
    const chats = this.list<FactoryDetail["chats"][number]>("chats", id).filter(chat => chat.title === title);
    const messageRows = this.store.db.query<{ data: string }, [string, string]>("SELECT data FROM records WHERE kind='messages' AND parent=? AND json_extract(data, '$.chat_id') IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(id, JSON.stringify(chats.map(chat => chat.id)));
    const human = selected.kind === "human_review";
    const review = human ? current.human_reviews?.at(-1) : undefined;
    const comments = human ? this.list<FactoryDetail["comments"][number]>("comments", id) : [];
    const neededSnapshots = new Set(comments.map(comment => comment.snapshot_id));
    if (review?.snapshot_id) neededSnapshots.add(review.snapshot_id);
    const snapshots = this.list<Omit<FactoryDetail["snapshots"][number], "files">>("snapshots", id).filter(snapshot => human && neededSnapshots.has(snapshot.id)).map(snapshot => ({ ...snapshot, files: [] as FactoryDetail["snapshots"][number]["files"] }));
    // Earlier anchors need provenance only. The active Human Review alone needs
    // a diff body; unrelated snapshots/reports/check outputs remain undecoded.
    if (review?.snapshot_id) {
      const row = this.store.db.query<{ data: string }, [string, string]>("SELECT data FROM records WHERE kind='snapshots' AND parent=? AND id=?").get(id, review.snapshot_id);
      const index = snapshots.findIndex(snapshot => snapshot.id === review.snapshot_id);
      if (row && index !== -1) snapshots[index] = JSON.parse(row.data);
    }
    const deliveries = human ? this.list<NonNullable<FactoryDetail["human_review_deliveries"]>[number] & { origin?: string }>("human_review_messages", id).map(({ origin: _origin, ...receipt }) => receipt) : [];
    return { ...current, chats, messages: messageRows.map(row => JSON.parse(row.data)), native_snapshots: nativeRows.map(row => JSON.parse(row.data)),
      snapshots, comments, artifacts: [], checks: [], review_evidence: [], review_batches: [], automatic_review_batches: [], retrospectives: [], frontier: [],
      human_review_deliveries: deliveries,
      human_feedback_batches: human ? this.list<NonNullable<FactoryDetail["human_feedback_batches"]>[number]>("review_batches", id).filter(batch => batch.origin === "human") : [],
      human_review_approvals: human ? this.list<NonNullable<FactoryDetail["human_review_approvals"]>[number]>("human_review_approvals", id) : [],
    };
  }
  overview(settings: FactoryOverview["settings"], context: (id: string) => Parameters<typeof projectFactoryBoard>[1], navigation: boolean): FactoryOverview {
    const ideas = this.list<Implementation>("implementations"), runs = this.list<FactoryRun>("runs"), workers = this.list<FactoryWorker>("workers"), checks = this.list<Omit<FactoryCheck, "commands">>("checks");
    const byIdea = new Map(ideas.map(idea => [idea.id, runs.filter(run => run.implementation_id === idea.id)]));
    const plans = this.list<NonNullable<FactoryDetail["execution_plans"]>[number]>("execution_plans");
    const tickets = new Map(ideas.map(idea => {
      const executing = byIdea.get(idea.id)!.filter(run => run.action === "implement-spec" && !["completed", "cancelled", "failed"].includes(run.condition)).at(-1);
      const manifest = executing?.manifest as { planning_authority?: unknown; tickets?: FactoryTicket[] } | undefined;
      const frozen = executing ? plans.find(plan => plan.run_id === executing.id)?.tickets ?? (manifest?.planning_authority ? [] : manifest?.tickets ?? []) : this.tickets(idea.id);
      return [idea.id, frozen] as const;
    }));
    const waiting = this.list<NonNullable<FactoryDetail["capacity_waiting"]>[number] & { ticket_id?: string }>("capacity_waits");
    // Recover concrete failure reasons in SQL without decoding retained output bodies.
    const failedCommands = new Map(this.store.db.query<{ id: string; commands: string }, []>("SELECT records.id, json_group_array(json_object('args', json_extract(command.value, '$.args'), 'exit_code', json_extract(command.value, '$.exit_code'))) AS commands FROM records JOIN json_each(records.data, '$.commands') AS command WHERE records.kind='checks' AND json_extract(records.data, '$.condition')='failed' AND json_extract(command.value, '$.exit_code') IS NOT 0 GROUP BY records.id").all().map(row => [row.id, JSON.parse(row.commands) as Pick<FactoryCheck["commands"][number], "args" | "exit_code">[]]));
    const progressChecks = checks.map(check => ({ ...check, commands: (failedCommands.get(check.id) ?? []).map(command => ({ ...command, output: "" })) }));
    const ages = new Map<string, string>();
    for (const wait of waiting) if (!ages.has(wait.implementation_id) || wait.created_at < ages.get(wait.implementation_id)!) ages.set(wait.implementation_id, wait.created_at);
    const nativeMetadata = navigation ? [] : this.list<Pick<FactoryDetail["native_snapshots"][number], "id" | "run_id" | "worker_id">>("native_snapshots");
    const projects = this.list<FactoryOverview["projects"][number]>("projects");
    const projectIds = new Set(projects.filter(project => !project.removed_at).map(project => project.id));
    const board = ideas.map(idea => projectFactoryBoard(idea, { ...context(idea.id), runs: byIdea.get(idea.id), workers, checks, tickets: tickets.get(idea.id), questions: this.questions(idea.id, byIdea.get(idea.id)!), capacity_waiting: waiting.filter(wait => wait.implementation_id === idea.id) }));
    // Navigation has no tree for unassigned, archived or finished Assignments.
    // Explicit run provenance can still put an older Assignment under a Project.
    const visibleIdeas = navigation ? ideas.filter(idea => !idea.archived_at && !board.find(item => item.implementation_id === idea.id)?.sidebar_hidden && (projectIds.has(idea.project_id ?? "") || byIdea.get(idea.id)!.some(run => projectIds.has((run.manifest as { project?: { id?: string } } | null)?.project?.id ?? "")))) : ideas;
    const conversations = visibleIdeas.flatMap(idea => workflowConversations({ implementation: idea, runs: byIdea.get(idea.id)!, workers, tickets: tickets.get(idea.id)!, execution_plans: plans, native_snapshots: nativeMetadata }));
    return {
      implementations: [...ideas].sort((a,b) => (ages.get(a.id) ?? a.created_at).localeCompare(ages.get(b.id) ?? b.created_at)).map(idea => { if (!navigation) return idea; const { description, delivery, upstream_update, ...summary } = idea; return summary; }),
      projects, checkouts: this.list<FactoryOverview["checkouts"][number]>("checkouts").map(checkout => { if (!navigation) return checkout; const { instructions, ...summary } = checkout; return summary; }), settings,
      capacity: factoryCapacity(this, settings),
      conversations: navigation ? conversations.map(conversation => ({ ...conversation, contexts: conversation.contexts.map(({ run_id, worker_id }) => ({ run_id, worker_id })) })) : conversations,
      progress: ideas.map(idea => assignmentProgress(idea, tickets.get(idea.id)!, byIdea.get(idea.id)!, workers, progressChecks, waiting)),
      board,
      activity: ideas.flatMap(idea => { const run = byIdea.get(idea.id)?.at(-1), graph = tickets.get(idea.id)!; return run ? [{ implementation_id: idea.id, run_id: run.id, condition: run.condition, action: run.action, waiting_reason: run.waiting_reason, completed_tickets: graph.filter(t => t.status === "done").length, total_tickets: graph.length }] : []; }),
      pane_archives: this.list("pane_archives"),
      pane_links: runs.flatMap(run => {
        const manifest = run.manifest as { project?: { id?: string }; tickets?: { id: string; title: string }[] };
        const base = { project_id: manifest.project?.id ?? null, implementation_id: run.implementation_id, run_id: run.id, machine_id: run.machine_id, provider: run.provider };
        return [...(run.pane_id ? [{ ...base, pane_id: run.pane_id, worker_id: null, worktree: run.worktree, workspace_id: run.workspace_id, title: run.action, condition: run.condition }] : []), ...workers.filter(worker => worker.run_id === run.id && worker.pane_id).map(worker => ({ ...base, pane_id: worker.pane_id!, worker_id: worker.id, worktree: worker.worktree, workspace_id: worker.workspace_id, title: plans.find(plan => plan.run_id === run.id)?.tickets.find(ticket => ticket.id === worker.ticket_id)?.title ?? manifest.tickets?.find(t => t.id === worker.ticket_id)?.title ?? worker.role, condition: worker.condition }))];
      }),
    };
  }
}
