import type { FactoryAssignmentActivity as FactoryActivity, FactoryAssignmentProgress, Implementation } from "../../shared/factory.ts";
import { useT } from "../lib/i18n.ts";
import "./FactoryBoardProgress.css";

function activityLabel(activity: FactoryActivity, t: ReturnType<typeof useT>): string {
  switch (activity) {
    case "specifying": return t("Specifying");
    case "implementing": return t("Implementing");
    case "testing": return t("Testing");
    case "auto_review": return t("Auto-Review");
    case "fixing": return t("Fixing");
  }
}
export function FactoryBoardProgress({ idea, progress, expanded, onExpandedChange, waitingReason, waitingReasonRole }: { waitingReasonRole?: "alert" | "status"; waitingReason?: string | null; idea: Pick<Implementation, "id" | "pause" | "deletion">; progress?: FactoryAssignmentProgress; expanded: boolean; onExpandedChange: (open: boolean) => void }) {
  const t = useT();
  const errorReasons = [...new Set([...(idea.pause?.reasons ?? []), ...(idea.deletion?.reasons ?? []), ...(progress?.error_reasons ?? [])])];
  return <div className="factory-progress">
    {idea.deletion && <p role="status">{t("Delete pending")}</p>}
    {idea.pause && <p role="status">{idea.pause.condition === "pending" ? t("Pause pending") : idea.pause.condition === "resuming" ? t("Resume pending") : t("Paused")}</p>}
    {errorReasons.filter(reason => reason !== waitingReason || waitingReasonRole !== "alert").map(reason => <p role="alert" key={reason}>{reason}</p>)}
    {progress && <>
      <div className="factory-activities" role="status">{progress.activities.map(activity => <span className={`factory-activity factory-activity-${activity}`} key={activity}>{activityLabel(activity, t)}</span>)}</div>
      {progress.tickets.length > 0 && <p className="factory-progress-counts" aria-live="polite">{t("{waiting} waiting · {running} running · {completed} completed", progress.counts)}</p>}
      {progress.tickets.some(ticket => ticket.state === "running") && <ul aria-label={t("Active Tickets")}>{progress.tickets.filter(ticket => ticket.state === "running").map(ticket => <li key={ticket.ticket_id}>{ticket.title}</li>)}</ul>}
      {progress.reasons.filter(reason => reason !== waitingReason && !errorReasons.includes(reason) && !progress.tickets.some(ticket => ticket.reason === reason)).map(reason => <p role="status" key={reason}>{reason}</p>)}
      {progress.tickets.length > 0 && <details open={expanded} onToggle={event => onExpandedChange(event.currentTarget.open)}>
        <summary>{t("All Tickets ({count})", { count: progress.tickets.length })}</summary>
        <ul>{progress.tickets.map(ticket => <li key={ticket.ticket_id}>
          <strong>{ticket.title}</strong> · <span>{ticket.state === "running" ? t("Running") : ticket.state === "completed" ? t("Completed") : t("Waiting")}</span>
          {ticket.reason && <p>{ticket.reason}</p>}
        </li>)}</ul>
      </details>}
    </>}
  </div>;
}
