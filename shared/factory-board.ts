import type { FactoryAction, FactoryActivity, FactoryBoardItem, FactoryCheck, FactoryQuestion, FactoryRun, FactoryTicket, FactoryWorker, Implementation } from "./factory.ts";

export function factoryRunActivity(action: FactoryAction): FactoryActivity {
  switch (action) {
    case "work": case "implement-spec": case "apply-retro": return "implementing";
    case "verify-provider": return "validating";
    case "setup": return "setting_up";
    case "retro": return "reflecting";
    default: return "specifying";
  }
}

/** Shared presentation policy for the bridge and fictional browser demo. */
export function projectFactoryBoard(implementation: Implementation, context: { tickets?: FactoryTicket[]; runs?: FactoryRun[]; workers?: FactoryWorker[]; checks?: FactoryCheck[]; questions?: FactoryQuestion[] } = {}): FactoryBoardItem {
  const tickets = context.tickets ?? [];
  const runIds = new Set(context.runs?.map(entry => entry.id));
  const quiescent = !(context.runs ?? []).some(entry => !["completed", "cancelled", "failed"].includes(entry.condition))
    && !(context.workers ?? []).some(entry => runIds.has(entry.run_id) && !["completed", "cancelled", "failed"].includes(entry.condition))
    && !(context.checks ?? []).some(entry => runIds.has(entry.run_id) && ["working", "interrupted"].includes(entry.condition));
  if (implementation.discard_requested_at || implementation.stage === "done" && ["research_accepted", "merged", "released", "discarded"].includes(implementation.outcome) && quiescent) {
    const finished = implementation.stage === "done" && quiescent;
    return { implementation_id: implementation.id, lane: finished ? "done" : "needs_you", activity: finished ? null : "discard_pending", condition: finished ? null : "needs_you", run_id: context.runs?.at(-1)?.id ?? null, busy: false, waiting_reason: finished ? null : "Owned work must be confirmed stopped before this Assignment can be discarded. Reconnect its Machine and reconcile Discard.", ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null, sidebar_hidden: finished };
  }
  const run = context.runs?.at(-1);
  const workers = (context.workers ?? []).filter(worker => worker.run_id === run?.id);
  const check = context.checks?.filter(entry => entry.run_id === run?.id).at(-1);
  const working = (condition: string) => ["accepted", "working", "disconnected"].includes(condition);
  const needsYou = (condition: string) => ["needs_you", "blocked", "interrupted", "failed"].includes(condition);
  const question = context.questions?.find(entry => entry.answer === null);
  const attention = (question ? { condition: "needs_you" as const, waiting_reason: question.question } : null) ?? workers.find(worker => needsYou(worker.condition)) ?? (run && needsYou(run.condition) ? run : null) ?? (check && (check.condition === "failed" || check.condition === "interrupted") ? { condition: check.condition, waiting_reason: null } : null);
  const busy = check?.condition === "working" || workers.some(worker => working(worker.condition)) || !!run && working(run.condition);
  const checkpoint = run?.condition === "ready" && !busy;
  const awaitingChecks = checkpoint && !check && ["work", "implement-spec", "apply-retro"].includes(run.action);
  const validating = !!check && ["working", "failed", "interrupted"].includes(check.condition);
  const proposal = !run && ["specifying", "review"].includes(implementation.stage);
  const reviewing = workers.some(worker => worker.role !== "implementer" && !["completed", "cancelled"].includes(worker.condition));
  if (implementation.stage !== "done" && !attention && !busy && run && implementation.completion_evidence?.repository_changes === "none" && implementation.completion_evidence.quiescent) return { implementation_id: implementation.id, lane: "needs_you", activity: "researching", condition: "needs_you", run_id: run.id, busy: false, waiting_reason: "Accept the retained research to finish this Assignment; no repository changes were found.", ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null };
  if (implementation.stage !== "done" && implementation.completion_evidence?.reason && (!busy || implementation.completion_evidence.repository_changes === "unknown")) return { implementation_id: implementation.id, lane: "needs_you", activity: implementation.completion_evidence.repository_changes === "changes" ? "awaiting_merge" : run ? factoryRunActivity(run.action) : null, condition: attention?.condition ?? "needs_you", run_id: run?.id ?? null, busy, waiting_reason: implementation.completion_evidence.reason, ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null };
  return { implementation_id: implementation.id, lane: attention ? "needs_you" : busy ? "running" : implementation.stage === "done" ? "done" : awaitingChecks ? "running" : checkpoint || proposal ? "needs_you" : implementation.stage === "ready" ? "queued" : "inbox", activity: implementation.stage === "done" && !attention && !busy ? null : validating ? "validating" : reviewing ? "reviewing" : awaitingChecks ? "awaiting_checks" : run ? factoryRunActivity(run.action) : proposal ? implementation.stage === "review" ? "reviewing" : "specifying" : null, condition: attention?.condition ?? run?.condition ?? null, run_id: run?.id ?? null, busy, waiting_reason: attention?.waiting_reason ?? run?.waiting_reason ?? null, ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null };
}
