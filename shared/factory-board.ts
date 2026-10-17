import type { FactoryAssignmentActivity, FactoryAction, FactoryActivity, FactoryBoardItem, FactoryQuestion, FactoryAssignmentProgress, FactoryCapacityWait, FactoryCheck, FactoryRun, FactoryTicket, FactoryWorker, Implementation } from "./factory.ts";

type BoardWait = FactoryCapacityWait & { ticket_id?: string };
const ended = (condition: string) => ["completed", "cancelled", "failed"].includes(condition);
const executing = (context: FactoryRun | FactoryWorker) => context.condition === "working" && !context.suspension && (!context.continuation || context.continuation.condition === "resumed");
const attention = (condition: string) => ["needs_you", "blocked", "interrupted", "failed"].includes(condition);

/** Suspension retains its phase; restored inputs are used only to choose a lane. */
function phaseContext<T extends FactoryRun | FactoryWorker>(idea: Implementation, context: T): T {
  return idea.pause && context.suspension?.pause_id === idea.pause.id && !ended(context.condition)
    ? { ...context, condition: context.suspension.previous_condition, suspension: undefined } : context;
}
function phaseCheck<T extends Pick<FactoryCheck, "condition" | "pause_id">>(idea: Implementation, check: T): T {
  return idea.pause && check.condition === "cancelled" && check.pause_id === idea.pause.id
    ? { ...check, condition: "working" } : check;
}

/** Board progress projects retained evidence. It neither admits work nor changes its age. */
export function assignmentProgress(idea: Implementation, tickets: FactoryTicket[], runs: FactoryRun[], workers: FactoryWorker[], checks: FactoryCheck[] = [], waiting: BoardWait[] = [], workflowReasons: { run_id: string; reason: string | null; reason_is_error?: boolean }[] = []): FactoryAssignmentProgress {
  const current = runs.at(-1);
  const relevant = workers.filter(worker => runs.some(run => run.id === worker.run_id));
  const waits = waiting.filter(wait => wait.implementation_id === idea.id);
  const scopedChecks = checks.filter(check => runs.some(run => run.id === check.run_id && (!ended(run.condition) || run === current || ["working", "interrupted"].includes(check.condition))));
  const latestChecks = scopedChecks.filter((check, index) => !scopedChecks.slice(index + 1).some(next => next.run_id === check.run_id && next.worker_id === check.worker_id));
  const liveChecks = scopedChecks.filter(check => check.condition === "working");
  const liveWorkers = relevant.filter(executing);
  const activities = new Set<FactoryAssignmentActivity>();
  if (idea.pause?.condition !== "paused") {
    for (const run of runs.filter(executing)) {
      if (["setup", "grill-me", "grill-with-docs", "to-spec", "to-tickets"].includes(run.action)) activities.add("specifying");
      if (run.action === "work" && run.conversation_kind !== "human_review") activities.add("implementing");
    }
    for (const worker of liveWorkers) activities.add(worker.role !== "implementer" ? "auto_review" : worker.rework_batch_id ? "fixing" : "implementing");
    if (liveChecks.length) activities.add("testing");
  }
  const checkReason = (check: FactoryCheck) => check.condition === "interrupted" ? "Check execution is uncertain; reconcile its reservation" : `Checks failed${check.commands.filter(command => command.exit_code !== 0).map(command => `: ${command.args.join(" ")} (exit ${command.exit_code})`).join("")}`;
  const contextReason = (context: FactoryRun | FactoryWorker) => ("delivery_completion_error" in context && !ended(context.condition) ? context.delivery_completion_error : null) || context.waiting_reason || context.continuation?.reason || (attention(context.condition) || context.condition === "disconnected" ? `Execution ${context.condition}` : null);
  const completed = (ticket: FactoryTicket) => {
    const attempts = relevant.filter(worker => worker.ticket_id === ticket.id && worker.role === "implementer");
    const latest = attempts.at(-1);
    return latest?.rework_batch_id ? latest.condition === "completed" : ticket.status === "done" || attempts.some(worker => worker.condition === "completed");
  };
  const rows = tickets.map(ticket => {
    const attempts = relevant.filter(worker => worker.role === "implementer" && worker.ticket_id === ticket.id);
    const latest = attempts.at(-1);
    const done = completed(ticket);
    const running = idea.pause?.condition !== "paused" && (attempts.some(executing) || liveChecks.some(check => attempts.some(worker => worker.id === check.worker_id)));
    const dependencies = tickets.filter(dependency => ticket.dependencies.includes(dependency.id) && !completed(dependency));
    const check = latestChecks.find(check => check.worker_id === latest?.id && ["failed", "interrupted"].includes(check.condition));
    const reason = done || running ? null : idea.pause ? (idea.pause.condition === "paused" ? "Assignment is paused" : idea.pause.reasons.join("; ") || "Assignment suspension is pending")
      : latest && contextReason(latest) || (dependencies.length ? `Waiting for dependencies: ${dependencies.map(dependency => dependency.title).join(", ")}` : null)
      || waits.find(wait => wait.ticket_id === ticket.id)?.reason || (check ? checkReason(check) : null)
      || (latest?.condition === "ready" ? "Awaiting checks and integration" : "Waiting for an implementation worker");
    return { ticket_id: ticket.id, title: ticket.title, state: done ? "completed" as const : running ? "running" as const : "waiting" as const, reason };
  });
  const latestWorkers = relevant.filter((worker, index) => runs.some(run => run.id === worker.run_id && (!ended(run.condition) || run === current)) && !relevant.slice(index + 1).some(next => next.run_id === worker.run_id && next.role === worker.role && next.ticket_id === worker.ticket_id));
  const scopedRuns = runs.filter(run => !ended(run.condition) || run === current);
  const failed = (context: FactoryRun | FactoryWorker) => ["failed", "interrupted", "disconnected", "blocked"].includes(context.condition);
  const workflowFaults = workflowReasons.filter(record => record.reason_is_error && record.reason && scopedRuns.some(run => run.id === record.run_id)).map(record => record.reason!);
  const errorReasons = [...new Set([
    ...scopedRuns.filter(run => !ended(run.condition)).flatMap(run => run.delivery_completion_error ? [run.delivery_completion_error] : []),
    ...workflowFaults,
    ...(idea.deletion?.reasons ?? []), ...(idea.pause?.reasons ?? []),
    ...waits.filter(wait => wait.condition === "blocked" || wait.reason_is_error).map(wait => wait.reason),
    ...[...scopedRuns, ...latestWorkers].filter(failed).flatMap(context => contextReason(context) ? [contextReason(context)!] : []),
    ...latestChecks.filter(check => ["failed", "interrupted"].includes(check.condition)).map(checkReason),
  ])];
  const reasons = [...new Set([
    ...workflowFaults,
    ...(idea.deletion?.reasons ?? []), ...(idea.pause?.reasons ?? []),
    ...waits.map(wait => wait.reason),
    ...scopedRuns.flatMap(run => contextReason(run) ? [contextReason(run)!] : []),
    ...latestWorkers.flatMap(worker => contextReason(worker) ? [contextReason(worker)!] : []),
    ...rows.flatMap(row => row.reason ? [row.reason] : []),
    ...latestChecks.filter(check => ["failed", "interrupted"].includes(check.condition)).map(checkReason),
  ])];
  // Suspension changes native conditions to ready. Preserve the lane's prior phase,
  // while activity tags and Ticket counts continue to describe verified execution.
  const laneContexts = [...runs, ...relevant].map(context => phaseContext(idea, context));
  const underway = scopedChecks.some(check => phaseCheck(idea, check).condition === "working") || laneContexts.some(context => executing(context) || ["accepted", "disconnected"].includes(context.condition));
  const needsAttention = waits.some(wait => wait.condition === "blocked") || (current && attention(current.suspension?.previous_condition ?? current.condition)) || latestWorkers.some(worker => attention(worker.suspension?.previous_condition ?? worker.condition)) || latestChecks.some(check => ["failed", "interrupted"].includes(check.condition));
  const lane = idea.stage === "done" ? "done" : needsAttention || idea.stage === "review" ? "needs_you"
    : underway ? "running" : waits.length || idea.stage === "ready" ? "queued" : idea.stage === "inbox" ? "inbox" : "needs_you";
  return { implementation_id: idea.id, lane, activities: (["specifying", "implementing", "testing", "auto_review", "fixing"] as const).filter(activity => activities.has(activity)), counts: { waiting: rows.filter(row => row.state === "waiting").length, running: rows.filter(row => row.state === "running").length, completed: rows.filter(row => row.state === "completed").length }, tickets: rows, reasons, error_reasons: errorReasons };
}

export function factoryRunActivity(action: FactoryAction): FactoryActivity {
  switch (action) {
    case "work": case "implement-spec": case "apply-retro": return "implementing";
    case "verify-provider": return "validating";
    case "setup": return "setting_up";
    case "retro": return "reflecting";
    default: return "specifying";
  }
}

type BoardContext = { tickets?: FactoryTicket[]; runs?: FactoryRun[]; workers?: FactoryWorker[]; checks?: Omit<FactoryCheck, "commands">[]; questions?: FactoryQuestion[]; capacity_waiting?: FactoryCapacityWait[]; admission_problem?: string | null; selected?: boolean; readiness_problem?: string | null };

/** Shared presentation policy for the bridge and fictional browser demo. */
export function projectFactoryBoard(implementation: Implementation, context: BoardContext = {}): FactoryBoardItem {
  let current = projectNativeBoard(implementation, context);
  if (implementation.pause && !implementation.discard_requested_at && !implementation.deletion) {
    // Evaluate every existing delivery/research gate against retained execution phase,
    // while current busy/activity/reasons and conservative sidebar visibility stay factual.
    const phase = projectNativeBoard(implementation, { ...context,
      runs: context.runs?.map(run => phaseContext(implementation, run)),
      workers: context.workers?.map(worker => phaseContext(implementation, worker)),
      checks: context.checks?.map(check => phaseCheck(implementation, check)),
    });
    current = { ...current, lane: phase.lane };
  }
  const deliveryError = context.runs?.filter(run => !ended(run.condition) && run.delivery_completion_error).at(-1)?.delivery_completion_error;
  return deliveryError ? { ...current, delivery_completion_error: deliveryError } : current;
}

function projectNativeBoard(implementation: Implementation, context: BoardContext): FactoryBoardItem {
  const tickets = context.tickets ?? [];
  const runIds = new Set(context.runs?.map(entry => entry.id));
  const quiescent = !(context.runs ?? []).some(entry => !["completed", "cancelled", "failed"].includes(entry.condition))
    && !(context.workers ?? []).some(entry => runIds.has(entry.run_id) && !["completed", "cancelled", "failed"].includes(entry.condition))
    && !(context.checks ?? []).some(entry => runIds.has(entry.run_id) && ["working", "interrupted"].includes(entry.condition));
  const question = context.questions?.find(entry => entry.answer === null);
  const delivered = implementation.stage === "done" && ["research_accepted", "merged", "released", "discarded"].includes(implementation.outcome);
  if (implementation.discard_requested_at || delivered && quiescent && !question) {
    const finished = implementation.stage === "done" && quiescent;
    return { implementation_id: implementation.id, lane: finished ? "done" : "needs_you", activity: finished ? null : "discard_pending", condition: finished ? null : "needs_you", run_id: context.runs?.at(-1)?.id ?? null, busy: false, waiting_reason: finished ? null : "Owned work must be confirmed stopped before this Assignment can be discarded. Reconnect its Machine and reconcile Discard.", ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null, sidebar_hidden: finished };
  }
  const run = context.runs?.at(-1);
  const workers = (context.workers ?? []).filter(worker => worker.run_id === run?.id);
  const waits = (context.capacity_waiting ?? []).filter(wait => wait.implementation_id === implementation.id && (wait.run_id ? wait.run_id === run?.id : !context.runs?.some(attempt => attempt.idempotency_key === wait.idempotency_key)));
  const check = context.checks?.filter(entry => entry.run_id === run?.id).at(-1);
  const working = (condition: string) => ["accepted", "working", "disconnected"].includes(condition);
  const needsYou = (condition: string) => ["needs_you", "blocked", "interrupted", "failed"].includes(condition);
  const busy = check?.condition === "working" || workers.some(worker => working(worker.condition)) || !!run && working(run.condition);
  const blockedWait = !busy && implementation.stage !== "done" ? waits.find(wait => wait.condition === "blocked") : undefined;
  const contextualAttention = (run?.issue_pause ? { condition: "needs_you" as const, waiting_reason: run.waiting_reason } : run?.scope_pause ? { condition: "needs_you" as const, waiting_reason: run.scope_pause.reason } : null) ?? (question ? { condition: "needs_you" as const, waiting_reason: question.question } : null) ?? workers.find(worker => needsYou(worker.condition)) ?? (run && needsYou(run.condition) ? run : null) ?? (check && (check.condition === "failed" || check.condition === "interrupted") ? { condition: check.condition, waiting_reason: null } : null) ?? (context.admission_problem || context.readiness_problem ? { condition: "needs_you" as const, waiting_reason: context.admission_problem ?? context.readiness_problem } : null);
  const attention = contextualAttention ?? (blockedWait ? { condition: "needs_you" as const, waiting_reason: blockedWait.reason } : null);
  const reasonWait = !contextualAttention ? blockedWait ?? (!run?.waiting_reason && !busy && implementation.stage !== "done" ? waits[0] : undefined) : undefined;
  const checkpoint = run?.condition === "ready" && !busy;
  const awaitingChecks = checkpoint && !check && ["work", "implement-spec", "apply-retro"].includes(run.action);
  const validating = !!check && ["working", "failed", "interrupted"].includes(check.condition);
  const proposal = !run && ["specifying", "review"].includes(implementation.stage);
  const reviewing = workers.some(worker => worker.role !== "implementer" && !["completed", "cancelled"].includes(worker.condition));
  if (implementation.stage !== "done" && implementation.delivery_scope?.milestone === "release" && implementation.delivery?.condition === "merged" && implementation.completion_evidence?.quiescent && !busy) return { implementation_id: implementation.id, lane: attention || implementation.delivery.problem ? "needs_you" : "running", activity: "awaiting_release", condition: attention?.condition ?? (implementation.delivery.problem ? "needs_you" : "ready"), run_id: run?.id ?? null, busy: false, waiting_reason: attention?.waiting_reason ?? implementation.delivery.problem, ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null };
  if (implementation.stage !== "done" && implementation.activity === "awaiting_merge" && !busy && !attention) return { implementation_id: implementation.id, lane: "needs_you", activity: "awaiting_merge", condition: "needs_you", run_id: run?.id ?? null, busy: false, waiting_reason: null, ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null };
  if (implementation.stage !== "done" && !attention && !busy && run && implementation.completion_evidence?.repository_changes === "none" && implementation.completion_evidence.quiescent) return { implementation_id: implementation.id, lane: "needs_you", activity: "researching", condition: "needs_you", run_id: run.id, busy: false, waiting_reason: "Accept the retained research to finish this Assignment; no repository changes were found.", ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null };
  if (implementation.stage !== "done" && !run?.scope_pause && implementation.completion_evidence?.reason && (!busy || implementation.completion_evidence.repository_changes === "unknown")) return { implementation_id: implementation.id, lane: "needs_you", activity: implementation.completion_evidence.repository_changes === "changes" ? "awaiting_merge" : run ? factoryRunActivity(run.action) : null, condition: attention?.condition ?? "needs_you", run_id: run?.id ?? null, busy, waiting_reason: implementation.completion_evidence.reason, ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null };
  // Native rest after Pause and a later discussion do not replace the Assignment's phase.
  // Keep explicit delivery/research waits and guarded Discard above; reuse retained progress
  // for ordinary suspension and delivered work without changing activity or sidebar ownership.
  const lifecycleLane = !implementation.deletion && (delivered || implementation.pause && !attention)
    ? assignmentProgress(implementation, tickets, context.runs ?? [], context.workers ?? [], (context.checks ?? []).map(check => ({ ...check, commands: [] })), context.capacity_waiting).lane
    : undefined;
  return { implementation_id: implementation.id, lane: lifecycleLane ?? (attention ? "needs_you" : busy ? "running" : implementation.stage === "done" ? "done" : awaitingChecks ? "running" : checkpoint || proposal ? "needs_you" : implementation.stage === "ready" || context.selected || waits.some(wait => wait.condition === "queued") ? "queued" : "inbox"), activity: implementation.stage === "done" && !attention && !busy ? null : validating ? "validating" : reviewing ? "reviewing" : awaitingChecks ? "awaiting_checks" : run ? factoryRunActivity(run.action) : proposal ? implementation.stage === "review" ? "reviewing" : "specifying" : null, condition: attention?.condition ?? run?.condition ?? null, run_id: run?.id ?? null, busy, waiting_reason: attention?.waiting_reason ?? run?.waiting_reason ?? reasonWait?.reason ?? null, ...(reasonWait ? { waiting_reason_is_error: reasonWait.condition === "blocked" || reasonWait.reason_is_error === true } : {}), ticket_progress: tickets.length ? { completed: tickets.filter(ticket => ticket.status === "done").length, total: tickets.length } : null };
}
