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
  return { implementation_id: implementation.id, lane: attention ? "needs_you" : busy ? "running" : implementation.stage === "done" ? "done" : awaitingChecks ? "running" : checkpoint || proposal ? "needs_you" : implementation.stage === "ready" ? "queued" : "inbox", activity: implementation.stage === "done" && !attention && !busy ? null : validating ? "validating" : reviewing ? "reviewing" : awaitingChecks ? "awaiting_checks" : run ? factoryRunActivity(run.action) : proposal ? implementation.stage === "review" ? "reviewing" : "specifying" : null, condition: attention?.condition ?? run?.condition ?? null, run_id: run?.id ?? null, busy, waiting_reason: attention?.waiting_reason ?? run?.waiting_reason ?? null, ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null };
}
