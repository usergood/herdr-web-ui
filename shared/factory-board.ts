import type { FactoryActivity, FactoryAssignmentProgress, FactoryCapacityWait, FactoryCheck, FactoryRun, FactoryTicket, FactoryWorker, Implementation } from "./factory.ts";

type BoardWait = FactoryCapacityWait & { ticket_id?: string };
const ended = (condition: string) => ["completed", "cancelled", "failed"].includes(condition);
const executing = (context: FactoryRun | FactoryWorker) => context.condition === "working" && !context.suspension && (!context.continuation || context.continuation.condition === "resumed");
const attention = (condition: string) => ["needs_you", "blocked", "interrupted", "failed"].includes(condition);

/** Board progress projects retained evidence. It neither admits work nor changes its age. */
export function assignmentProgress(idea: Implementation, tickets: FactoryTicket[], runs: FactoryRun[], workers: FactoryWorker[], checks: FactoryCheck[] = [], waiting: BoardWait[] = []): FactoryAssignmentProgress {
  const current = runs.at(-1);
  const relevant = workers.filter(worker => runs.some(run => run.id === worker.run_id));
  const waits = waiting.filter(wait => wait.implementation_id === idea.id);
  const scopedChecks = checks.filter(check => runs.some(run => run.id === check.run_id && (!ended(run.condition) || run === current || ["working", "interrupted"].includes(check.condition))));
  const latestChecks = scopedChecks.filter((check, index) => !scopedChecks.slice(index + 1).some(next => next.run_id === check.run_id && next.worker_id === check.worker_id));
  const liveChecks = scopedChecks.filter(check => check.condition === "working");
  const liveWorkers = relevant.filter(executing);
  const activities = new Set<FactoryActivity>();
  if (idea.pause?.condition !== "paused") {
    for (const run of runs.filter(executing)) {
      if (["setup", "grill-me", "grill-with-docs", "to-spec", "to-tickets"].includes(run.action)) activities.add("specifying");
      if (run.action === "work") activities.add("implementing");
    }
    for (const worker of liveWorkers) activities.add(worker.role !== "implementer" ? "auto_review" : worker.rework_batch_id ? "fixing" : "implementing");
    if (liveChecks.length) activities.add("testing");
  }
  const checkReason = (check: FactoryCheck) => check.condition === "interrupted" ? "Check execution is uncertain; reconcile its reservation" : `Checks failed${check.commands.filter(command => command.exit_code !== 0).map(command => `: ${command.args.join(" ")} (exit ${command.exit_code})`).join("")}`;
  const contextReason = (context: FactoryRun | FactoryWorker) => context.waiting_reason || context.continuation?.reason || (attention(context.condition) || context.condition === "disconnected" ? `Execution ${context.condition}` : null);
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
  const reasons = [...new Set([
    ...(idea.deletion?.reasons ?? []), ...(idea.pause?.reasons ?? []),
    ...waits.map(wait => wait.reason),
    ...runs.filter(run => !ended(run.condition) || run === current).flatMap(run => contextReason(run) ? [contextReason(run)!] : []),
    ...latestWorkers.flatMap(worker => contextReason(worker) ? [contextReason(worker)!] : []),
    ...rows.flatMap(row => row.reason ? [row.reason] : []),
    ...latestChecks.filter(check => ["failed", "interrupted"].includes(check.condition)).map(checkReason),
  ])];
  // Suspension changes native conditions to ready. Preserve the lane's prior phase,
  // while activity tags and Ticket counts continue to describe verified execution.
  const laneContexts = [...runs, ...relevant].map(context => idea.pause && context.suspension && !ended(context.condition)
    ? { ...context, condition: context.suspension.previous_condition, suspension: undefined } : context);
  const underway = liveChecks.length > 0 || laneContexts.some(context => executing(context) || ["accepted", "disconnected"].includes(context.condition));
  const needsAttention = waits.some(wait => wait.condition === "blocked") || (current && attention(current.suspension?.previous_condition ?? current.condition)) || latestWorkers.some(worker => attention(worker.suspension?.previous_condition ?? worker.condition)) || latestChecks.some(check => ["failed", "interrupted"].includes(check.condition));
  const lane = idea.stage === "done" ? "done" : needsAttention || idea.stage === "review" ? "needs_you"
    : underway ? "running" : waits.length || idea.stage === "ready" ? "queued" : idea.stage === "inbox" ? "inbox" : "needs_you";
  return { implementation_id: idea.id, lane, activities: (["specifying", "implementing", "testing", "auto_review", "fixing"] as const).filter(activity => activities.has(activity)), counts: { waiting: rows.filter(row => row.state === "waiting").length, running: rows.filter(row => row.state === "running").length, completed: rows.filter(row => row.state === "completed").length }, tickets: rows, reasons };
}
