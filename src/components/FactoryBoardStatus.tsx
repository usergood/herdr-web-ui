import { ClipboardList, Code, FlaskConical, MessagesSquare, CircleAlert, BookOpen, Settings, History, Clock, GitPullRequest, type LucideIcon } from "lucide-react";
import type { FactoryBoardItem } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import "./FactoryBoardStatus.css";

export function FactoryBoardStatus({ state, showActivity = true, showTicketProgress = true }: { state: FactoryBoardItem; showActivity?: boolean; showTicketProgress?: boolean }) {
  const t = useT();
  let label: string | null = null; let Icon: LucideIcon = ClipboardList;
  switch (state.activity) {
    case "specifying": label = t("Specifying"); break;
    case "implementing": label = t("Implementing"); Icon = Code; break;
    case "validating": label = t("Validating"); Icon = FlaskConical; break;
    case "reviewing": label = t("Reviewing"); Icon = MessagesSquare; break;
    case "awaiting_checks": label = t("Awaiting checks"); Icon = Clock; break;
    case "awaiting_release": label = t("Awaiting release"); Icon = Clock; break;
    case "awaiting_merge": label = t("Awaiting merge"); Icon = GitPullRequest; break;
    case "discard_pending": label = t("Discard pending"); Icon = Clock; break;
    case "researching": label = t("Researching"); Icon = BookOpen; break;
    case "setting_up": label = t("Setting up"); Icon = Settings; break;
    case "reflecting": label = t("Reflecting"); Icon = History; break;
  }
  return <div className="factory-board-status">
    {showActivity && label && <p className="factory-activity" role="status" aria-label={label}><Icon aria-hidden="true" /><span>{label}</span></p>}
    {state.lane === "needs_you" && <p className="factory-attention" role={state.condition === "failed" ? "alert" : "status"}><CircleAlert aria-hidden="true" />{state.condition === "failed" ? t("Failed") : t("Needs you")}</p>}
    {showTicketProgress && state.ticket_progress && <p>{t("Tickets: {completed}/{total}", state.ticket_progress)}</p>}
    {state.waiting_reason && <p role="status">{state.waiting_reason}</p>}
  </div>;
}
