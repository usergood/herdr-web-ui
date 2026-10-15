import type { FactoryConversation, FactoryConversationContext, FactoryDetail, FactoryRun, FactoryWorker } from "./factory.ts";

/** Read-only projection of durable provenance; never admits or starts native work. */
export function workflowConversations(detail: Pick<FactoryDetail, "implementation" | "runs" | "workers" | "tickets" | "native_snapshots">): FactoryConversation[] {
  const assignmentId = detail.implementation.id;
  const roots: FactoryConversation[] = (["specifications", "orchestrator", "human_review"] as const).map(kind => ({ id: `${assignmentId}:${kind}`, implementation_id: assignmentId, parent_id: null, kind, title: null, contexts: [] }));
  const conversations = [...roots];
  const context = (run: FactoryRun, worker?: FactoryWorker): FactoryConversationContext => ({
    run_id: run.id, worker_id: worker?.id ?? null, action: run.action, machine_id: run.machine_id, provider: run.provider,
    condition: worker?.condition ?? run.condition, pane_id: worker ? worker.pane_id : run.pane_id,
    workspace_id: worker ? worker.workspace_id : run.workspace_id, worktree: worker ? worker.worktree : run.worktree,
    snapshot_ids: detail.native_snapshots.filter(s => s.run_id === run.id && (s.worker_id ?? null) === (worker?.id ?? null)).map(s => s.id),
  });
  const child = (kind: FactoryConversation["kind"], parent: FactoryConversation, key: string, title: string | null = null) => {
    const id = `${parent.id}:${key}`;
    let entry = conversations.find(c => c.id === id);
    if (!entry) { entry = { id, implementation_id: assignmentId, parent_id: parent.id, kind, title, contexts: [] }; conversations.push(entry); }
    return entry;
  };
  for (const run of detail.runs) {
    const root = run.conversation_kind === "human_review" ? roots[2]! : ["grill-me", "grill-with-docs", "to-spec"].includes(run.action) ? roots[0]! : ["to-tickets", "implement-spec"].includes(run.action) ? roots[1]! : null;
    if (root) root.contexts.push(context(run));
    for (const worker of detail.workers.filter(w => w.run_id === run.id)) {
      let entry: FactoryConversation;
      if (worker.role === "standards" || worker.role === "spec") {
        const reviewer = child("reviewer", roots[1]!, "reviewer");
        entry = child(worker.role, reviewer, worker.role);
      } else if (worker.rework_batch_id) {
        // Legacy request-changes batches were owner feedback. Explicit provenance
        // distinguishes future automatic repairs without moving any old history.
        entry = child("review_fixes", worker.review_origin === "automatic" ? roots[1]! : roots[2]!, worker.id);
      } else {
        const frozen = (run.manifest as { tickets?: { id: string; title: string }[] } | null)?.tickets?.find(t => t.id === worker.ticket_id);
        entry = child("implementation", roots[1]!, `ticket:${worker.ticket_id}`, frozen?.title ?? detail.tickets.find(t => t.id === worker.ticket_id)?.title ?? worker.ticket_id);
      }
      entry.contexts.push(context(run, worker));
    }
  }
  return conversations;
}
